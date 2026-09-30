import { BridgeAuthGuard, type BridgeTokenVerifier, createOpenClawAdapter } from "@dodok/openclaw-adapter";
import { createRunnerAdapter, type RunnerAdapter, type RunnerTokenVerifier } from "@dodok/runner-adapter";
import type { ApiError } from "@dodok/shared";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Server } from "socket.io";
import { v7 as uuidv7 } from "uuid";
import packageJson from "../package.json" with { type: "json" };
import { type AdapterRegistry, createAdapterRegistry } from "./adapters/registry";
import type { AgentAdapter, OpenClawAdapterStatus, OpenClawSetupDetail } from "./adapters/types";
import { type Auth, createAuth } from "./auth";
import { bootstrapOwner } from "./auth/owner";
import { createIpLimit, registerAuthRoutes } from "./auth/routes";
import { isLocalVapidSubject, type ServerConfig } from "./config";
import { createDb, type Db } from "./db/client";
import { workspaces } from "./db/schema.sqlite";
import { HttpError, httpStatusToErrorCode } from "./http/errors";
import { createLogger, type Logger, requestLogSerializer } from "./logger";
import { registerAdapterRoutes } from "./modules/adapter/routes";
import { registerAgentRoutes } from "./modules/agents/routes";
import { registerAttachmentRoutes } from "./modules/attachments/routes";
import { sweepAttachments } from "./modules/attachments/service";
import { type BlobLocks, createBlobLocks } from "./modules/attachments/store";
import { registerChannelRoutes } from "./modules/channels/routes";
import { getChannel } from "./modules/channels/service";
import { registerMemberManageRoutes } from "./modules/members/manage.routes";
import { registerMemberRoutes } from "./modules/members/routes";
import { registerMessageRoutes } from "./modules/messages/routes";
import {
  createDiskMonitor,
  DISCONNECT_EVENT_MS,
  type DiskState,
  watchConnections,
  watchGatewayVersion,
  watchRunFailures,
  watchRunners,
} from "./modules/ops/health";
import { createRestLimits } from "./modules/ops/http-limits";
import { ipPrefix } from "./modules/ops/ip";
import { LIMITS, type Limits } from "./modules/ops/limits";
import { monotonicNow } from "./modules/ops/ratelimit";
import { registerOpsRoutes } from "./modules/ops/routes";
import { providersWithAgents } from "./modules/ops/summary";
import type { OpsService } from "./modules/ops/service";
import { createPresence } from "./modules/push/presence";
import { registerPushRoutes } from "./modules/push/routes";
import {
  attachPushTriggers,
  createPushDispatcher,
  createTriggerLookups,
  type PushSend,
  webPushSender,
} from "./modules/push/service";
import { loadVapidKeys } from "./modules/push/vapid";
import type { Orchestrator, RunTimeouts } from "./modules/runs/orchestrator";
import { registerRunnerRoutes, runnerServerUrl } from "./modules/runners/routes";
import { readRunnerFile, runnerDirCandidates } from "./modules/runners/runner-file";
import { activeRunnerTokenCount, isActiveRunnerTokenId, verifyRunnerTokenDb } from "./modules/runners/tokens";
import { registerRunRoutes } from "./modules/runs/routes";
import { registerSearchRoutes } from "./modules/search/routes";
import { pluginDirCandidates, readPluginFile } from "./modules/setup/plugin-file";
import { registerSetupRoutes } from "./modules/setup/routes";
import { bridgePublicUrl, buildSetupStatus } from "./modules/setup/status";
import { importEnvToken, isActiveBridgeToken, verifyBridgeTokenDb } from "./modules/setup/tokens";
import { ServerBus } from "./realtime/bus";
import { attachWireFanout } from "./realtime/events";
import { attachWire, disconnectSessions, disconnectUser, sweepExpiredSessions } from "./realtime/socket";
import type { WireServer } from "./realtime/types";
import { createServices, type Services, sessionRecoverTargets } from "./wiring";

/** 스펙 2장 — 종료 전체 상한. 넘기면 warn 을 남기고 close() 를 끝낸다(남은 단계는 뒤에서 이어진다). */
export const APP_CLOSE_TIMEOUT_MS = 10_000;
/** 첨부 정리 주기(스펙 4.7 — 시작 때 한 번, 그 뒤 한 시간마다) */
export const ATTACHMENT_SWEEP_INTERVAL_MS = 3600_000;
/** 종료 때 진행 중인 푸시 발송을 기다리는 상한 — 넘기면 놓고 db 를 닫는다(늦게 온 결과의 구독 정리는 로그만 남고 버려진다) */
export const PUSH_DRAIN_TIMEOUT_MS = 2_000;
/** Gateway 가 이만큼 reconnecting 이면 운영자에게 알린다 — 토큰 불일치처럼 스스로 풀리지 않는 실패(sc-t11 걱정 2) */
export const GATEWAY_RECONNECTING_NOTICE_MS = 60_000;
/** 운영 사건 보존 정리 주기(운영 보강 스펙 3.1 — 부팅 때 한 번, 그 뒤 하루 한 번) */
export const OPS_SWEEP_INTERVAL_MS = 24 * 3600_000;
/** 만료 세션 청소 주기 — 만료 행을 지우고 그 wire 소켓을 끊는다(socket.ts sweepExpiredSessions). 만료 뒤 소켓은 최대 이만큼 산다 */
export const SESSION_SWEEP_INTERVAL_MS = 60_000;

export type AppDeps = {
  /**
   * 레지스트리에 올릴 어댑터(provider 마다 하나, OpenClaw 는 꼭 있어야 한다). 없으면 설정으로 실제 OpenClaw 어댑터
   * (createOpenClawAdapter — Gateway WS·/bridge) 하나. 테스트는 FakeAdapter 를 준다.
   */
  adapters?: AgentAdapter[] | undefined;
  logger?: Logger;
  /** wire 소켓별 미전송 큐 상한(기본 500) — 테스트가 낮춘다 */
  wireMaxPending?: number;
  /** 런 타임아웃·코얼레싱·동시 런 상한(기본 DEFAULT_RUN_TIMEOUTS) — 테스트가 낮춘다 */
  timeouts?: Partial<RunTimeouts>;
  /** close() 상한(기본 APP_CLOSE_TIMEOUT_MS) — 테스트가 낮춘다 */
  closeTimeoutMs?: number;
  /** 첨부 블롭 sha 잠금(기본은 앱마다 새로 하나) — 업로드 경로와 정리가 같은 객체를 쓰는지 테스트가 들여다본다 */
  blobLocks?: BlobLocks;
  /** 첨부 정리 주기(기본 ATTACHMENT_SWEEP_INTERVAL_MS) — 테스트가 낮춘다 */
  attachmentSweepIntervalMs?: number;
  /** 만료 세션 청소 주기(기본 SESSION_SWEEP_INTERVAL_MS) — 테스트가 낮춘다 */
  sessionSweepIntervalMs?: number;
  /** 웹 푸시 발송기(기본은 VAPID 키로 만든 실제 web-push). 테스트는 가짜를 준다 — 밖으로 보내지 않게 */
  pushSend?: PushSend;
  /** 품은 플러그인 tgz 를 찾을 디렉터리(기본 pluginDirCandidates) — 테스트가 임시 디렉터리나 []를 준다 */
  pluginDirs?: string[];
  /**
   * 앱이 실제 러너 어댑터(`/runner`, createRunnerAdapter)를 만들어 레지스트리에 올린다. 기본은 adapters 를 주지 않았을 때만 —
   * 테스트는 FakeAdapter 곁에 켠다. adapters 에 이미 claude 가 있으면 만들지 않는다
   */
  runnerAdapter?: boolean;
  /** 품은 러너 tgz 를 찾을 디렉터리(기본 runnerDirCandidates) — 테스트가 임시 디렉터리나 []를 준다 */
  runnerDirs?: string[];
  /** 러너 도구 승인 기한(기본 RUNNER_APPROVAL_TTL_MS 10분) — 통합 테스트가 실제 시계로 잴 만큼 줄인다 */
  runnerApprovalTtlMs?: number;
  /** 레이트리밋 숫자(기본 LIMITS, 얕게 덮는다) — 테스트가 수백 번 되풀이할 상한을 줄인다 */
  limits?: Partial<Limits>;
  /** 레이트리밋·브리지 실패 카운터의 시계(ms, 기본 단조 시계 monotonicNow) — 테스트가 창·버킷을 넘긴다. Better Auth·로컬 로그인 상한(@fastify/rate-limit)은 따르지 않는다 */
  limitClock?: () => number;
  /** DATA_DIR 디스크 측정(기본 fs.statfs) — 테스트가 여유를 흉내 낸다 */
  statfs?: Parameters<typeof createDiskMonitor>[0]["statfs"];
  /** 끊김 사건 임계(기본 DISCONNECT_EVENT_MS) — 통합 테스트가 실제 시계로 잴 만큼 줄인다 */
  disconnectEventMs?: number;
  /** 실제 어댑터의 Gateway 재접속 백오프(기본 1초부터 두 배, 상한 30초) — dev:fake 가 끊김 훅 뒤 곧바로 붙게 상한을 줄인다 */
  gatewayBackoff?: { initialMs?: number; maxMs?: number };
};

/** 이어받지 않은 .env 토큰 경고(Review Focus 1) — 사람이 로그에서 이 문장을 찾는다 */
export const ENV_BRIDGE_TOKEN_IGNORED_WARNING =
  "BRIDGE_TOKEN in .env is ignored — manage bridge tokens in the connection page";

/**
 * 브리지 거절 로그·실패 카운터와 wire 레이트리밋 사건의 원격 주소. 리버스 프록시를 믿을 때(TRUST_PROXY=true)만 X-Forwarded-For 첫 값을 쓴다 —
 * 믿지 않는데 읽으면 클라이언트가 헤더를 꾸며 스로틀·귀속을 피한다. Caddy 는 클라이언트 XFF 를 자기가 본 IP 로 덮는다
 */
export function bridgeClientAddress(
  trustProxy: boolean,
): (handshake: { address: string; headers: Record<string, string | string[] | undefined> }) => string {
  return (handshake) => {
    if (!trustProxy) return handshake.address;
    const raw = handshake.headers["x-forwarded-for"];
    const first = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim();
    return first || handshake.address;
  };
}

export type App = {
  fastify: FastifyInstance;
  io: WireServer;
  db: Db;
  bus: ServerBus;
  logger: Logger;
  workspaceId: string;
  auth: Auth;
  /** 부팅 때 보장한 owner 의 id (= Better Auth user.id = users.id) */
  ownerUserId: string;
  /** 붙은 어댑터들 — 런은 에이전트의 provider 로 고른다 */
  registry: AdapterRegistry;
  orchestrator: Orchestrator;
  services: Services;
  /** 운영 사건 입구(= services.ops) — 프로세스 예외 처리기(main.ts)도 여기로 남긴다 */
  ops: OpsService;
  /** DATA_DIR 디스크 여유 — 첫 측정은 createApp 이 끝나기 전에 끝난다. error 면 첨부 업로드가 507 */
  disk(): DiskState;
  /** 10분 주기를 기다리지 않고 지금 다시 재고 그 결과를 돌려준다(dev:fake 디스크 흉내) */
  checkDisk(): Promise<DiskState>;
  /** main 이 종료 표지(startRunState)를 읽은 뒤 직전 종료가 깨끗했는지 넘긴다 — ops/status 가 싣는다. 넘기기 전에는 null */
  setPreviousClean(previousClean: boolean | null): void;
  /** 업로드 경로와 첨부 정리가 함께 지나는 블롭 잠금 — 둘이 같은 객체인지 테스트가 본다 */
  readonly blobLocks: BlobLocks;
  /** listen 뒤에만 채워진다. 그 전에는 빈 문자열. */
  readonly url: string;
  /** 한 번만 실행한다 — 다시 부르면 같은 프로미스. 닫힌 어댑터를 다시 쓰지 않는다(sc-t11 재리뷰 이월). */
  close(): Promise<void>;
};

/**
 * 스펙 2장 부팅 순서: db → auth·owner → bus → Fastify → Socket.IO → 어댑터 생성(레지스트리) → 서비스 배선 → 라우트·wire →
 * 부팅 정리(recoverOnBoot) → ready → 어댑터마다 connect(). 도중에 실패하면 만든 것을 역순으로 닫고 그 오류를 다시 던진다.
 */
export async function createApp(config: ServerConfig, deps: AppDeps = {}): Promise<App> {
  const logger = deps.logger ?? createLogger(config.LOG_LEVEL);
  const startedAt = new Date();
  let previousClean: boolean | null = null;
  const undo: Array<{ step: string; run: () => unknown }> = [];
  try {
    // DATA_DIR 은 gitignore 라 새 클론·워크트리에 없다 — better-sqlite3 는 디렉터리를 만들지 않는다(리뷰 sc-t1 지적 2)
    if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
    const db = createDb(config.dbPath);
    undo.push({ step: "db", run: () => db.$client.close() });
    const workspaceId = ensureWorkspace(db, config.DODOK_WORKSPACE_NAME);
    const auth = createAuth(db, config, logger);
    const { userId: ownerUserId } = await bootstrapOwner(db, auth, config, workspaceId);
    // 브리지 토큰의 정본은 DB — .env 값은 비었을 때만 첫 토큰(라벨 env)으로 이어받는다(설정 마법사 결정 3)
    const envImport = importEnvToken(db, workspaceId, config.BRIDGE_TOKEN);
    if (envImport === "imported") logger.info({ label: "env" }, "bridge token imported from .env");
    if (envImport === "ignored") logger.warn(ENV_BRIDGE_TOKEN_IGNORED_WARNING);
    // 핸드셰이크와 첨부 HTTP 가 같은 검증을 쓴다. DB 오류는 던지고, 부르는 쪽이 거절로 본다
    const verifyBridgeToken: BridgeTokenVerifier = (presented) => verifyBridgeTokenDb(db, presented);
    const verifyRunnerToken: RunnerTokenVerifier = (presented) => verifyRunnerTokenDb(db, presented);
    const bus = new ServerBus();
    const limits: Limits = { ...LIMITS, ...deps.limits };
    const limitClock = deps.limitClock ?? monotonicNow;
    const trustProxy = config.TRUST_PROXY === "true";
    // 브리지·러너의 핸드셰이크와 첨부 HTTP 가 같은 실패 카운터를 쓴다(스펙 4.1·러너 스펙 5장) — 한쪽에서 막힌 주소는 다른
    // 쪽에서도 막힌다
    const bridgeGuard = new BridgeAuthGuard(limits.bridgeFail);
    // 사건 서비스는 어댑터 뒤에 만들어진다 — 막힘은 listen 뒤 핸드셰이크에서만 일어나므로 그때는 있다.
    // 사건은 하나(key bridge)로 묶고 막히게 한 쪽은 detail.path 로 가른다(러너 스펙 8장)
    let ops: OpsService;
    const onAuthBlocked = (address: string, path: "bridge" | "runner") =>
      ops.record({
        kind: "bridge_auth_blocked",
        key: "bridge",
        severity: "warn",
        detail: { ipPrefix: ipPrefix(address), path },
      });
    const onBridgeBlocked = (address: string) => onAuthBlocked(address, "bridge");

    // 기본 제네릭(FastifyBaseLogger)으로 추론되게 한다 — pino Logger 로 추론되면 FastifyInstance·플러그인 타입과 어긋난다.
    // req 직렬화는 이 로거의 것이 Fastify 기본을 이긴다 — 요청 로그의 원격 주소를 가린다(deps.logger 를 받아도 같다)
    const loggerInstance: FastifyBaseLogger = logger.child(
      {},
      { serializers: { req: requestLogSerializer } },
    );
    // 리버스 프록시 뒤면 request.ip(레이트리밋 키)가 X-Forwarded-For 를 따르게 한다(리뷰 sc-t3 이월 4)
    const fastify = Fastify({ loggerInstance, trustProxy });
    undo.push({ step: "fastify", run: () => fastify.close() });
    await fastify.register(cookie);
    // 라우트가 config.rateLimit 로 켠 곳에만 건다(/api/v1/auth/local)
    await fastify.register(rateLimit, { global: false });
    fastify.setErrorHandler((error, _req, reply) => {
      if (error instanceof HttpError) {
        // INTERNAL HttpError(저장값 계약 위반 등)는 서버 버그다 — 원인(cause)과 함께 남긴다
        if (error.body.code === "INTERNAL")
          logger.error({ err: error, cause: error.cause }, "internal error");
        return reply.status(error.status).send(error.body);
      }
      // Fastify 자체 4xx(잘못된 JSON·미지원 content-type·404·429)는 클라이언트 오류다 — 500 으로 바꾸지 않는다(리뷰 sc-t1 지적 1)
      const { statusCode, message } = error as { statusCode?: unknown; message?: unknown };
      const status = typeof statusCode === "number" ? statusCode : 500;
      if (status >= 400 && status < 500) {
        logger.warn({ err: error, status }, "client error");
        return reply.status(status).send({
          code: httpStatusToErrorCode(status),
          message: typeof message === "string" ? message : "bad request",
        });
      }
      logger.error({ err: error }, "unhandled");
      return reply.status(500).send({ code: "INTERNAL", message: "internal error" });
    });

    const io: WireServer = new Server(fastify.server, {
      cors: { origin: config.APP_ORIGIN, credentials: true },
      // 웹은 socket.io-client 를 번들해 쓴다. 켜 두면 운영 번들에서는 client-dist 가 없어 GET /socket.io/socket.io.js 가
      // 200 머리만 보내고 끊긴다(소스 실행은 파일을 준다) — 쓰는 곳이 없는 표면이라 두 모드 모두 끈다(bundle-smoke 가 400 을 확인)
      serveClient: false,
    });
    undo.push({ step: "io", run: () => io.close() });

    // 정본 훅은 오케스트레이터를 부르는데 오케스트레이터는 어댑터를 받아 뒤에 만들어진다 — 브리지 연결은 listen 뒤라 그때는 있다
    let orchestrator: Orchestrator;
    const clientAddress = bridgeClientAddress(trustProxy);
    const adapters: AgentAdapter[] = deps.adapters
      ? [...deps.adapters]
      : [
          createOpenClawAdapter({
            gateway: {
              url: config.gateway.url,
              token: config.gateway.token,
              deviceIdentityPath: config.deviceIdentityPath,
            },
            bridge: {
              io,
              verifyToken: verifyBridgeToken,
              clientAddress,
              logAddress: ipPrefix,
              serverVersion: packageJson.version,
              authGuard: bridgeGuard,
              onBlocked: onBridgeBlocked,
              now: limitClock,
            },
            logger: logger.child({ mod: "adapter" }),
            onCanonical: (message) => orchestrator.onCanonical(message, "openclaw"),
            sessionKeysToRecover: () => sessionRecoverTargets(db),
            ...(config.OPENCLAW_FRAME_DUMP_PATH === undefined
              ? {}
              : { frameDumpPath: config.OPENCLAW_FRAME_DUMP_PATH }),
            ...(deps.gatewayBackoff === undefined ? {} : { backoff: deps.gatewayBackoff }),
          }),
        ];
    // Claude 러너(러너 스펙 2장) — 사람 머신의 러너가 /runner 로 붙어 온다. 최종 답·post 는 OpenClaw 정본과 같은 자리로 저장한다
    // 러너 첨부 GET 의 읽기 범위를 이 어댑터에 묻는다(판정 R5) — 어댑터가 없으면(테스트의 가짜 claude) 열린 런도 없다
    let runnerAdapter: RunnerAdapter | undefined;
    if (
      (deps.runnerAdapter ?? deps.adapters === undefined) &&
      !adapters.some((a) => a.provider === "claude")
    ) {
      runnerAdapter = createRunnerAdapter({
        io,
        verifyToken: verifyRunnerToken,
        clientAddress: (socket) => clientAddress(socket.handshake),
        logAddress: ipPrefix,
        authGuard: bridgeGuard,
        onBlocked: (address) => onAuthBlocked(address, "runner"),
        now: limitClock,
        serverVersion: packageJson.version,
        logger: logger.child({ mod: "runner-adapter" }),
        channelName: (channelId) => getChannel(db, channelId, workspaceId)?.name,
        onOutbound: async (message) => {
          const { messageId } = await orchestrator.onCanonical(message, "claude");
          if (messageId === undefined) throw new Error("canonical store returned no message id");
          return { messageId };
        },
        tokenCount: () => activeRunnerTokenCount(db, workspaceId),
        ...(deps.runnerApprovalTtlMs === undefined ? {} : { approvalTtlMs: deps.runnerApprovalTtlMs }),
      });
      adapters.push(runnerAdapter);
    }
    const closeAdapters = () => Promise.all(adapters.map((adapter) => adapter.close()));
    undo.push({ step: "adapter", run: closeAdapters });
    const registry = createAdapterRegistry(adapters);
    // 설정 마법사·운영 화면의 Gateway·브리지 줄, Gateway 감시는 OpenClaw 어댑터의 것이다
    const openclaw = registry.forProvider("openclaw");
    if (!openclaw) throw new Error("an OpenClaw adapter is required");
    const openclawDetail = (): OpenClawSetupDetail => {
      const detail = openclaw.setupDetail();
      if (detail.provider !== "openclaw")
        throw new Error(`OpenClaw adapter returned ${detail.provider} setup detail`);
      return detail;
    };
    const services = createServices({ db, bus, logger, registry, workspaceId, timeouts: deps.timeouts });
    orchestrator = services.orchestrator;
    ops = services.ops;
    // requireSession·업로드가 request.server.restLimits 로 찾는다(http-limits.ts)
    fastify.decorate("restLimits", createRestLimits({ limits, ops, now: limitClock }));
    undo.push({ step: "orchestrator", run: () => services.orchestrator.stop() });
    // 운영 사건 보존: 30일 지난 줄을 지금 한 번, 그 뒤 하루 한 번 지운다. 실패는 로그만 남기고 부팅·주기를 막지 않는다
    const sweepOps = () => {
      try {
        services.ops.sweep();
      } catch (err) {
        logger.error({ err }, "ops sweep failed");
      }
    };
    sweepOps();
    const opsSweepTimer = setInterval(sweepOps, OPS_SWEEP_INTERVAL_MS);
    opsSweepTimer.unref();
    const closeOps = () => {
      clearInterval(opsSweepTimer);
      services.ops.close(); // 모으던 ops.event·로그를 내보낸다 — io 를 닫기 전에
    };
    undo.push({ step: "ops", run: closeOps });
    // 만료 세션: 지금 한 번, 그 뒤 주기마다. 실패는 로그만 남기고 부팅·주기를 막지 않는다
    const sweepSessions = () => {
      try {
        const ids = sweepExpiredSessions(io, db);
        if (ids.length > 0) logger.info({ count: ids.length }, "expired sessions swept");
      } catch (err) {
        logger.error({ err }, "session sweep failed");
      }
    };
    sweepSessions();
    const sessionSweepTimer = setInterval(
      sweepSessions,
      deps.sessionSweepIntervalMs ?? SESSION_SWEEP_INTERVAL_MS,
    );
    sessionSweepTimer.unref();
    const closeSessionSweep = () => clearInterval(sessionSweepTimer);
    undo.push({ step: "session-sweep", run: closeSessionSweep });
    // 디스크 여유(운영 보강 스펙 5.4): 지금 한 번, 그 뒤 10분마다. 사건을 남기므로 ops 뒤에 만들고 ops 보다 먼저 닫는다
    const disk = createDiskMonitor({
      dataDir: config.DATA_DIR,
      ops,
      logger,
      ...(deps.statfs === undefined ? {} : { statfs: deps.statfs }),
    });
    undo.push({ step: "disk", run: () => disk.close() });
    await disk.ready;

    const secureCookie = new URL(config.APP_ORIGIN).protocol === "https:";
    // 로그인·me/password(비밀번호 추측)와 초대 조회·수락·재설정(폭주)은 버킷이 따로다 — 한쪽이 차도 다른 쪽은 된다
    const loginLimit = createIpLimit(fastify, { perMin: limits.localLoginPerMin, ops });
    const invitePublicLimit = createIpLimit(fastify, { perMin: limits.invitePublicPerMin, ops });
    registerAuthRoutes(fastify, {
      auth,
      db,
      logger,
      workspaceId,
      secureCookie,
      betterAuthPerMin: limits.betterAuthPerMin,
      loginLimit,
      ops,
      disconnectSessions: (sessionIds) => disconnectSessions(io, sessionIds),
    });
    registerMemberRoutes(fastify, {
      auth,
      db,
      bus,
      logger,
      workspaceId,
      appOrigin: config.APP_ORIGIN,
      secureCookie,
      limits,
      loginLimit,
      invitePublicLimit,
      ops,
      limitNow: limitClock,
      disconnectUser: (userId) => disconnectUser(io, userId),
      disconnectSessions: (sessionIds) => disconnectSessions(io, sessionIds),
    });
    const routeContext = {
      auth,
      db,
      bus,
      logger,
      workspaceId,
      registry,
      orchestrator: services.orchestrator,
    };
    registerChannelRoutes(fastify, routeContext);
    registerAgentRoutes(fastify, routeContext);
    registerMessageRoutes(fastify, routeContext);
    registerMemberManageRoutes(fastify, {
      auth,
      db,
      bus,
      workspaceId,
      ops,
      logger,
      disconnectUser: (userId) => disconnectUser(io, userId),
    });
    registerRunRoutes(fastify, routeContext);
    registerAdapterRoutes(fastify, routeContext);
    registerSearchRoutes(fastify, { auth, db, workspaceId, limits, ops, now: limitClock });
    // 첨부: 업로드의 「블롭 쓰기 + 행 넣기」와 정리의 「행 없음 확인 + 블롭 지우기」는 같은 잠금 객체를 지나야 한다 —
    // 이 한 변수로만 넘긴다(App.blobLocks 로도 내보내 테스트가 잠근다)
    mkdirSync(config.attachmentsDir, { recursive: true });
    const blobLocks = deps.blobLocks ?? createBlobLocks();
    registerAttachmentRoutes(fastify, {
      auth,
      db,
      workspaceId,
      dir: config.attachmentsDir,
      verifyBridgeToken,
      runner: {
        verifyToken: verifyRunnerToken,
        mayRead: (tokenId, attachmentId) => runnerAdapter?.mayReadAttachment(tokenId, attachmentId) ?? false,
      },
      bridgeGuard: { guard: bridgeGuard, now: limitClock, onBlocked: onAuthBlocked },
      locks: blobLocks,
      diskFull: () => disk.current().level === "error",
    });
    // 푸시: 키는 환경변수 둘 또는 DATA_DIR/vapid.json(스펙 5.1). 망가진 키 파일은 부팅을 막는다(덮어쓰면 모든 구독이 무효)
    const vapid = loadVapidKeys({
      dataDir: config.DATA_DIR,
      publicKey: config.vapid.publicKey,
      privateKey: config.vapid.privateKey,
    });
    if (isLocalVapidSubject(config.vapid.subject))
      logger.warn(
        { vapidSubject: config.vapid.subject },
        "VAPID subject is a local placeholder — Apple Push rejects it (403 BadJwtToken)",
      );
    registerPushRoutes(fastify, { auth, db, workspaceId, publicKey: vapid.publicKey });
    const sweeper = startAttachmentSweeper(
      () =>
        sweepAttachments({ db, dir: config.attachmentsDir, locks: blobLocks }).then(
          (r) => (r.rows > 0 || r.blobs > 0 ? logger.info(r, "attachments swept") : undefined),
          (err: unknown) => logger.error({ err }, "attachments sweep failed"),
        ),
      deps.attachmentSweepIntervalMs ?? ATTACHMENT_SWEEP_INTERVAL_MS,
    );
    undo.push({ step: "attachments-sweep", run: () => sweeper.close() });
    // 설정 마법사(스펙 3장): 상태는 읽을 때마다 조립한다 — 어댑터 상세·활성 토큰이 바뀌면 다음 읽기에 따른다
    const pluginFile = readPluginFile(deps.pluginDirs ?? pluginDirCandidates(config));
    if (!pluginFile)
      logger.info("plugin file not found — build it with pnpm -F @dodok/openclaw-plugin run pack:plugin");
    const runnerFile = readRunnerFile(deps.runnerDirs ?? runnerDirCandidates(config));
    if (!runnerFile)
      logger.info("runner file not found — build it with pnpm -F @dodok/claude-runner run pack:runner");
    const publicUrl = bridgePublicUrl(config);
    const runnerDetail = () => {
      const detail = registry.forProvider("claude")?.setupDetail();
      return detail?.provider === "claude" ? detail.runners : [];
    };
    const setupStatus = () =>
      buildSetupStatus({
        detail: openclawDetail(),
        pluginFile,
        runners: runnerDetail(),
        runnerFile,
        serverVersion: packageJson.version,
        publicUrl,
        envTokenIgnored:
          config.BRIDGE_TOKEN !== undefined && !isActiveBridgeToken(db, workspaceId, config.BRIDGE_TOKEN),
      });
    // 어느 어댑터든 setup 이벤트(마이크로태스크 뒤)·토큰 발급·폐기 때 owner 에게 다시 읽은 상태를 보낸다
    const emitSetupStatus = () => {
      try {
        bus.emit("setup.status", { status: setupStatus() });
      } catch (err) {
        logger.error({ err }, "setup status emit failed");
      }
    };
    const offSetup = registry.onEvent((event) => {
      if (event.kind === "setup") emitSetupStatus();
    });
    undo.push({ step: "setup-events", run: () => offSetup() });
    registerSetupRoutes(fastify, {
      auth,
      db,
      logger,
      workspaceId,
      openclaw: {
        setupDetail: openclawDetail,
        revokeTokenSessions: (id) => openclaw.revokeTokenSessions(id),
      },
      pluginFile,
      publicUrl,
      status: setupStatus,
      changed: emitSetupStatus,
    });
    registerRunnerRoutes(fastify, {
      auth,
      db,
      logger,
      workspaceId,
      registry,
      ops,
      runnerFile,
      serverUrl: runnerServerUrl(publicUrl),
      changed: emitSetupStatus,
    });
    // 운영 API(운영 보강 스펙 6장) — /healthz 에서 뺀 워크스페이스 id·어댑터 상세도 여기서 owner 에게만
    registerOpsRoutes(fastify, {
      auth,
      db,
      workspaceId,
      adapter: openclaw,
      // 붙어 있고 에이전트가 등록된 제공자 — 러너 어댑터는 늘 붙으므로, claude 에이전트가 없는 배포는 OpenClaw 만 쓰는 배포와 같다
      providersInUse: () =>
        providersWithAgents(
          db,
          workspaceId,
          adapters.map((adapter) => adapter.provider),
        ),
      ops,
      disk: () => disk.current(),
      serverVersion: packageJson.version,
      startedAt,
      previousClean: () => previousClean,
    });
    // 인증 없이 열려 있다 — 워크스페이스 id·어댑터 상세는 내놓지 않는다(운영 보강 스펙 8장, 상세는 owner 전용 ops/status)
    fastify.get("/healthz", async (_request, reply) => {
      const dbOk = pingDb(db, logger);
      return reply.status(dbOk ? 200 : 503).send({ ok: dbOk, db: dbOk ? "ok" : "error" });
    });

    // 종료 ①: close() 가 켜면 새 wire 연결을 인증보다 먼저 거부한다. 기존 연결·/bridge 는 어댑터가 닫힐 때까지 둔다
    let shuttingDown = false;
    io.use((_socket, next) => (shuttingDown ? next(shuttingDownError()) : next()));
    const presence = createPresence();
    attachWire(io, {
      auth,
      db,
      bus,
      logger,
      workspaceId,
      route: (message) => services.router.routeMessage(message),
      runs: services.runs,
      appOrigin: config.APP_ORIGIN,
      presence,
      limits,
      now: limitClock,
      ops,
      clientAddress: bridgeClientAddress(trustProxy),
    });
    const fanout = attachWireFanout(io, bus, { logger, db, workspaceId, maxPending: deps.wireMaxPending });
    undo.push({ step: "fanout", run: () => fanout.close() });
    const watch = watchGatewayReconnecting(openclaw, bus, logger);
    undo.push({ step: "watch", run: () => watch.close() });
    // 운영 사건(스펙 5.2·5.3·3.1 run_failed) — 위 system.notice 감시와 따로 돈다. 부팅 정리(recoverOnBoot)가 닫는 런도 센다
    const connections = watchConnections(openclaw, ops, deps.disconnectEventMs ?? DISCONNECT_EVENT_MS);
    undo.push({ step: "connections", run: () => connections.close() });
    const claude = registry.forProvider("claude");
    const runners = claude
      ? watchRunners(claude, ops, {
          isActiveToken: (tokenId) => isActiveRunnerTokenId(db, workspaceId, tokenId),
          delayMs: deps.disconnectEventMs ?? DISCONNECT_EVENT_MS,
        })
      : { close() {} };
    undo.push({ step: "runners", run: () => runners.close() });
    const gatewayVersion = watchGatewayVersion(openclaw, { db, workspaceId, ops, logger });
    undo.push({ step: "gateway-version", run: () => gatewayVersion.close() });
    const runFailures = watchRunFailures(bus, ops);
    undo.push({ step: "run-failures", run: () => runFailures.close() });
    // 푸시(스펙 5.2~5.4): 버스 → 트리거 → 보고 있으면 거르기 → 발송. 발송은 버스 처리기를 막지 않는다
    const pushDispatcher = createPushDispatcher({
      db,
      logger,
      presence,
      send:
        deps.pushSend ??
        webPushSender({
          subject: config.vapid.subject,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        }),
    });
    const pushTriggers = attachPushTriggers(
      bus,
      pushDispatcher,
      createTriggerLookups(db, workspaceId),
      logger,
    );
    undo.push({ step: "push-triggers", run: () => pushTriggers.close() });

    await services.orchestrator.recoverOnBoot();
    await fastify.ready();
    // Gateway 접속 실패는 부팅을 막지 않는다(스펙 2장) — connect() 는 던지지 않는 계약이지만 방어한다
    for (const adapter of adapters) {
      try {
        await adapter.connect();
      } catch (err) {
        logger.warn({ err, provider: adapter.provider }, "adapter connect failed");
      }
    }

    const closeTimeoutMs = deps.closeTimeoutMs ?? APP_CLOSE_TIMEOUT_MS;
    const step = async (name: string, run: () => unknown) => {
      try {
        await run();
      } catch (err) {
        logger.warn({ err, step: name }, "app close step failed");
      }
    };
    /** 스펙 2장 종료 순서. 진행 중 런은 그대로 두고 다음 부팅의 recoverOnBoot 가 닫는다. */
    const shutdown = async () => {
      shuttingDown = true; // ① 새 wire 연결 거부
      await step("watch", () => watch.close());
      // 사건을 남기는 감시는 ops 를 닫기 전에 끈다 — 그 뒤 기록은 창 없이 즉시 나간다(OpsService.close)
      await step("connections", () => connections.close());
      await step("runners", () => runners.close());
      await step("gateway-version", () => gatewayVersion.close());
      await step("run-failures", () => runFailures.close());
      await step("disk", () => disk.close());
      await step("setup-events", () => offSetup());
      await step("push-triggers", () => pushTriggers.close()); // 새 발송을 받지 않는다 — 이미 나간 것은 ⑥ 앞에서 잠깐 기다린다
      await step("attachments-sweep", () => sweeper.close()); // 진행 중인 정리가 db 를 닫기 전에 끝나게
      await step("session-sweep", closeSessionSweep);
      await step("ops", closeOps);
      await step("orchestrator", () => services.orchestrator.stop()); // ② 타이머·어댑터 구독 해제
      // ③ 브리지 system.notice shutdown → Gateway stop. io.close() 가 /bridge 소켓까지 끊으므로 그보다 먼저
      await step("adapter", closeAdapters);
      await step("fanout", () => fanout.close());
      await step("io", () => io.close()); // ④ 남은 wire·브리지 소켓
      await step("fastify", () => fastify.close()); // ⑤
      // 진행 중인 푸시가 구독 정리(404·410)로 db 를 쓸 수 있다 — 짧게만 기다린다(응답 없는 푸시 서비스가 종료를 막지 않게)
      await step("push-drain", () => pushDispatcher.drain(PUSH_DRAIN_TIMEOUT_MS));
      await step("db", () => db.$client.close()); // ⑥ (리뷰 sc-t1 이월 1)
    };
    let closing: Promise<void> | undefined;

    return {
      fastify,
      io,
      db,
      bus,
      logger,
      workspaceId,
      auth,
      ownerUserId,
      registry,
      orchestrator: services.orchestrator,
      services,
      ops: services.ops,
      disk: () => disk.current(),
      async checkDisk() {
        await disk.check();
        return disk.current();
      },
      setPreviousClean(value) {
        previousClean = value;
      },
      blobLocks,
      get url() {
        const addr = fastify.server.address();
        return typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
      },
      close() {
        closing ??= withDeadline(shutdown(), closeTimeoutMs, () =>
          logger.warn({ timeoutMs: closeTimeoutMs }, "app close timed out"),
        );
        return closing;
      },
    };
  } catch (err) {
    for (const { step, run } of undo.reverse()) {
      try {
        await run();
      } catch (cleanupErr) {
        logger.warn({ err: cleanupErr, step }, "cleanup after failed boot failed");
      }
    }
    throw err;
  }
}

/**
 * 어댑터 status 이벤트로 Gateway 상태를 본다. reconnecting 이 delayMs 동안 이어지면 system.notice warn 을 한 번 보낸다.
 * reconnecting 을 벗어나면 다시 잰다. 타이머는 unref — 프로세스를 붙잡지 않는다.
 */
export function watchGatewayReconnecting(
  adapter: Pick<AgentAdapter, "status" | "onEvent">,
  bus: ServerBus,
  logger: Pick<Logger, "warn">,
  delayMs = GATEWAY_RECONNECTING_NOTICE_MS,
): { close(): void } {
  let gateway: OpenClawAdapterStatus["gateway"] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observe = (next: OpenClawAdapterStatus["gateway"]) => {
    if (next === gateway) return;
    gateway = next;
    clearTimeout(timer);
    timer = undefined;
    if (next !== "reconnecting") return;
    timer = setTimeout(() => {
      timer = undefined;
      logger.warn({ delayMs }, "gateway still reconnecting");
      bus.emit("system.notice", { level: "warn", message: "OpenClaw Gateway 에 연결하지 못하고 있습니다" });
    }, delayMs);
    timer.unref();
  };
  // Gateway 는 OpenClaw 어댑터에만 있다
  const off = adapter.onEvent((e) => {
    if (e.kind === "status" && e.status.provider === "openclaw") observe(e.status.gateway);
  });
  const initial = adapter.status();
  if (initial.provider === "openclaw") observe(initial.gateway);
  return {
    close() {
      off();
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * 첨부 정리를 지금 한 번, 그 뒤 intervalMs 마다 부른다. 앞 정리가 안 끝났으면 그 주기는 건너뛴다(겹쳐 돌지 않는다).
 * run 이 던져도 다음 주기에 다시 돈다. 타이머는 unref. close() 는 타이머를 멈추고 진행 중인 정리를 기다린다
 */
export function startAttachmentSweeper(
  run: () => Promise<unknown>,
  intervalMs: number,
): { close(): Promise<void> } {
  let inflight: Promise<void> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped || inflight) return;
    inflight = (async () => {
      try {
        await run();
      } catch {
        // run 이 로그를 남긴다 — 여기서는 다음 주기를 막지 않게 삼킨다
      } finally {
        inflight = undefined;
      }
    })();
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    async close() {
      stopped = true;
      clearInterval(timer);
      await inflight;
    },
  };
}

function ensureWorkspace(db: Db, name: string): string {
  const existing = db.select().from(workspaces).get();
  if (existing) return existing.id;
  const id = uuidv7();
  db.insert(workspaces).values({ id, name, createdAt: new Date() }).run();
  return id;
}

/** /healthz — 상수 대신 실제로 한 번 읽는다(리뷰 sc-t1 이월 6) */
function pingDb(db: Db, logger: Logger): boolean {
  try {
    db.get(sql`select 1`);
    return true;
  } catch (err) {
    logger.error({ err }, "healthz db check failed");
    return false;
  }
}

function shuttingDownError(): Error & { data: ApiError } {
  return Object.assign(new Error("ADAPTER_UNAVAILABLE"), {
    data: { code: "ADAPTER_UNAVAILABLE" as const, message: "server shutting down" },
  });
}

function withDeadline(work: Promise<void>, ms: number, onTimeout: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve();
    }, ms);
    timer.unref();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

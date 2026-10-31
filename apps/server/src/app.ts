import { BridgeAuthGuard, createOpenClawAdapter } from "@dodok/openclaw-adapter";
import { createRunnerAdapter, type RunnerAdapter, type RunnerTokenVerifier } from "@dodok/runner-adapter";
import type { AdapterStatus, ApiError, ControlResult, GatewayLinkState } from "@dodok/shared";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Server } from "socket.io";
import { v7 as uuidv7 } from "uuid";
import packageJson from "../package.json" with { type: "json" };
import { type AdapterRegistry, createAdapterRegistry } from "./adapters/registry";
import { type AgentAdapter, hasGateways } from "./adapters/types";
import { type Auth, createAuth } from "./auth";
import { bootstrapOwner } from "./auth/owner";
import { createIpLimit, registerAuthRoutes } from "./auth/routes";
import { isLocalVapidSubject, type ServerConfig } from "./config";
import { createDb, type Db, type DbOrTx } from "./db/client";
import { workspaces } from "./db/schema.sqlite";
import { type AgentTokenGuard, requireAgentToken } from "./http/agent-token";
import { clientAddressOf, fastifyTrustProxy, parseTrustProxy } from "./http/client-address";
import { HttpError, httpStatusToErrorCode } from "./http/errors";
import { allowedOrigins } from "./http/origins";
import { registerWebStatic } from "./http/web-static";
import { createLogger, type Logger, RedactingLogController, requestLogSerializer } from "./logger";
import { registerAdapterRoutes } from "./modules/adapter/routes";
import { registerAgentRoutes } from "./modules/agents/routes";
import { registerAttachmentRoutes } from "./modules/attachments/routes";
import { sweepAttachments } from "./modules/attachments/service";
import { type BlobLocks, createBlobLocks } from "./modules/attachments/store";
import type { PostDeps } from "./modules/automations/post";
import { registerAutomationRoutes } from "./modules/automations/routes";
import { tick } from "./modules/automations/scheduler";
import { registerWebhookRoute } from "./modules/automations/webhook";
import { watchPluginHellos } from "./modules/channels/prompt-sync";
import { registerChannelRoutes } from "./modules/channels/routes";
import { registerConversationRoutes } from "./modules/conversations/routes";
import { registerDmRoutes } from "./modules/dms/routes";
import { registerMcpRoute } from "./modules/control/mcp";
import { type Principal, principalForBridge, principalForRunner } from "./modules/control/principal";
import { type ControlService, createControlService } from "./modules/control/service";
import { getChannel } from "./modules/channels/service";
import { registerGatewayRoutes } from "./modules/gateways/routes";
import { bootGateways, getGatewayRow, listGatewayRows } from "./modules/gateways/service";
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
import { monotonicNow, TokenBucket } from "./modules/ops/ratelimit";
import { registerOpsRoutes } from "./modules/ops/routes";
import { buildOpsStatus, type OpsStatusContext } from "./modules/ops/status";
import { getOpsSettings } from "./modules/ops/settings";
import { programsWithAgents } from "./modules/ops/summary";
import type { OpsService } from "./modules/ops/service";
import { loadFcmCredentials } from "./modules/push/fcm-credentials";
import { createPresence } from "./modules/push/presence";
import { registerPushRoutes } from "./modules/push/routes";
import {
  attachPushTriggers,
  createPushDispatcher,
  createTriggerLookups,
  pushCapabilities,
} from "./modules/push/service";
import { fcmTransport } from "./modules/push/transports/fcm";
import { loadApnsCredentials } from "./modules/push/credentials";
import { apnsTransport } from "./modules/push/transports/apns";
import type { PushTransports } from "./modules/push/transports/types";
import { type PushSend, webPushSender, webPushTransport } from "./modules/push/transports/webpush";
import { loadVapidKeys } from "./modules/push/vapid";
import type { Orchestrator, RunTimeouts } from "./modules/runs/orchestrator";
import { registerRunnerAdminRoutes } from "./modules/runners/projects.routes";
import { registerRunnerRoutes, runnerServerUrl } from "./modules/runners/routes";
import { runnerAgentDefinition } from "./modules/runners/definition";
import { readRunnerFile, runnerDirCandidates } from "./modules/runners/runner-file";
import { activeRunnerTokenCount, isActiveRunnerTokenId, verifyRunnerTokenDb } from "./modules/runners/tokens";
import { registerRunRoutes } from "./modules/runs/routes";
import { registerReadRoutes } from "./modules/reads/routes";
import { registerTokenRoutes } from "./modules/tokens/routes";
import { registerSearchRoutes } from "./modules/search/routes";
import { renderLlmsTxt } from "./modules/setup/llms";
import { pluginDirCandidates, readPluginFile } from "./modules/setup/plugin-file";
import { registerSetupRoutes } from "./modules/setup/routes";
import { bridgePublicUrl, buildSetupStatus } from "./modules/setup/status";
import { verifyBridgeTokenDb } from "./modules/setup/tokens";
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
/** 예약 자동화 틱 주기(자동화 스펙 결정 4) — 예약은 분 단위라 회차는 최대 이만큼 늦게 게시된다 */
export const AUTOMATION_TICK_INTERVAL_MS = 60_000;

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
  /** 예약 자동화 틱 주기(기본 AUTOMATION_TICK_INTERVAL_MS) — 테스트가 낮추거나 부팅 틱만 보려고 늘린다 */
  automationTickMs?: number;
  /** 웹 푸시 통로 안의 발송기(기본은 VAPID 키로 만든 실제 web-push). 테스트·dev:fake 는 가짜를 준다 — 밖으로 보내지 않게 */
  pushSend?: PushSend;
  /**
   * 푸시 통로 덮기 — 준 통로가 앱이 만들 통로를 이긴다. 능력(`GET /push/capabilities`)은 붙은 통로로 정해지므로 테스트는
   * iOS off·Android on 같은 조합을 여기서 만든다. webpush 를 주지 않으면 pushSend 로 만든 웹 푸시 통로를 쓴다
   */
  pushTransports?: PushTransports;
  /** 품은 플러그인 tgz 를 찾을 디렉터리(기본 pluginDirCandidates) — 테스트가 임시 디렉터리나 []를 준다 */
  pluginDirs?: string[];
  /**
   * 앱이 실제 러너 어댑터(`/runner`, createRunnerAdapter)를 만들어 레지스트리에 올린다. 기본은 adapters 를 주지 않았을 때만 —
   * 테스트는 FakeAdapter 곁에 켠다. adapters 에 이미 runner 가 있으면 만들지 않는다
   */
  runnerAdapter?: boolean;
  /** 품은 러너 tgz 를 찾을 디렉터리(기본 runnerDirCandidates) — 테스트가 임시 디렉터리나 []를 준다 */
  runnerDirs?: string[];
  /** 러너 도구 승인 기한(기본 RUNNER_APPROVAL_TTL_MS 10분) — 통합 테스트가 실제 시계로 잴 만큼 줄인다 */
  runnerApprovalTtlMs?: number;
  /** 제어 도구 확인 카드 기한(기본 CONTROL_CONFIRM_TTL_MS 10분) — 테스트가 실제 시계로 잴 만큼 줄인다 */
  controlConfirmTtlMs?: number;
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
  /** 제어 도구 입구 — /mcp·러너·플러그인 통로가 부른다 */
  control: ControlService;
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
    // 핸드셰이크와 첨부 HTTP 가 같은 검증을 쓴다 — 토큰 id 와 그 토큰의 Gateway. 꺼진 Gateway 의 토큰은 핸드셰이크에서 어댑터가,
    // 첨부 HTTP 에서 acceptBridgeGateway 가 거절한다. DB 오류는 던지고, 부르는 쪽이 거절로 본다
    const verifyBridgeToken = (presented: unknown) => verifyBridgeTokenDb(db, presented);
    const verifyRunnerToken: RunnerTokenVerifier = (presented) => verifyRunnerTokenDb(db, presented);
    const bus = new ServerBus();
    const limits: Limits = { ...LIMITS, ...deps.limits };
    const limitClock = deps.limitClock ?? monotonicNow;
    // 브리지 거절 로그·실패 카운터·wire 레이트리밋 사건의 소켓 주소와 REST request.ip 가 같은 판정을 쓴다(http/client-address.ts)
    const trustProxy = parseTrustProxy(config.TRUST_PROXY);
    // 브리지·러너의 핸드셰이크와 첨부 HTTP 가 같은 실패 카운터를 쓴다(스펙 4.1·러너 스펙 5장) — 한쪽에서 막힌 주소는 다른
    // 쪽에서도 막힌다
    const bridgeGuard = new BridgeAuthGuard(limits.bridgeFail);
    // 사건 서비스는 어댑터 뒤에 만들어진다 — 막힘은 listen 뒤 핸드셰이크에서만 일어나므로 그때는 있다.
    // 사건은 막히게 한 쪽마다 한 줄(key bridge:<path>) — 한 줄로 묶으면 detail 이 마지막 값으로 덮여 웹훅 소음(남의 틀린 토큰)이
    // 진짜 브리지 맞혀 보기를 가린다. detail.path 도 그대로 싣는다(러너 스펙 8장)
    let ops: OpsService;
    const onAuthBlocked = (address: string, path: "bridge" | "runner" | "mcp" | "webhook") =>
      ops.record({
        kind: "bridge_auth_blocked",
        key: `bridge:${path}`,
        severity: "warn",
        detail: { ipPrefix: ipPrefix(address), path },
      });
    const onBridgeBlocked = (address: string) => onAuthBlocked(address, "bridge");

    // 기본 제네릭(FastifyBaseLogger)으로 추론되게 한다 — pino Logger 로 추론되면 FastifyInstance·플러그인 타입과 어긋난다.
    // req 직렬화는 이 로거의 것이 Fastify 기본을 이긴다 — 요청 로그의 원격 주소·URL 속 웹훅 토큰을 가린다(deps.logger 를 받아도
    // 같다). 직렬화기를 거치지 않는 404 줄은 RedactingLogController 가 가린다
    const loggerInstance: FastifyBaseLogger = logger.child(
      {},
      { serializers: { req: requestLogSerializer } },
    );
    // 리버스 프록시 뒤면 request.ip(레이트리밋 키)가 믿는 프록시의 X-Forwarded-For 를 따르게 한다(리뷰 sc-t3 이월 4)
    const fastify = Fastify({
      loggerInstance,
      trustProxy: fastifyTrustProxy(trustProxy),
      logController: new RedactingLogController(),
    });
    undo.push({ step: "fastify", run: () => fastify.close() });
    // 종료 ①: close() 가 켠다 — 새 wire 연결을 인증보다 먼저 거부하고(아래 io.use), 끝나는 HTTP 응답마다 쉬는 연결을 닫는다
    let shuttingDown = false;
    // server.close()(io.close() 가 부른다)는 쉬는 keep-alive 연결을 그 순간 한 번만 닫고, 응답이 아직 안 끝난 연결은 건너뛴다.
    // 그 응답(예: 첨부 내려받기 마지막 조각)이 조금 뒤 끝나면 연결은 쉬는 keep-alive 로 남아 keepAliveTimeout(Fastify 기본 72초)까지
    // close 를 붙잡는다 — 종료 중에는 응답이 끝날 때마다 다시 닫는다. setImmediate: Node 가 finish 에서 소켓을 응답에서 떼어 낸 뒤
    fastify.addHook("onResponse", (_request, _reply, done) => {
      if (shuttingDown) setImmediate(() => fastify.server.closeIdleConnections());
      done();
    });
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
    // 빌드된 웹·보안 헤더(앱 컨테이너 하나 스펙 3.2). 보안 헤더 훅이 뒤에 붙는 모든 라우트에 걸리게 라우트보다 먼저 둔다
    registerWebStatic(fastify, {
      webDir: config.DODOK_WEB_DIR,
      httpsOrigin: new URL(config.APP_ORIGIN).protocol === "https:",
      logger,
    });

    const io: WireServer = new Server(fastify.server, {
      cors: { origin: allowedOrigins(config), credentials: true },
      // 웹은 socket.io-client 를 번들해 쓴다. 켜 두면 운영 번들에서는 client-dist 가 없어 GET /socket.io/socket.io.js 가
      // 200 머리만 보내고 끊긴다(소스 실행은 파일을 준다) — 쓰는 곳이 없는 표면이라 두 모드 모두 끈다(bundle-smoke 가 400 을 확인)
      serveClient: false,
    });
    undo.push({ step: "io", run: () => io.close() });

    // 정본 훅은 오케스트레이터를 부르는데 오케스트레이터는 어댑터를 받아 뒤에 만들어진다 — 브리지 연결은 listen 뒤라 그때는 있다
    let orchestrator: Orchestrator;
    // 제어 도구 호출도 같다 — 제어 서비스는 라우트 문맥을 받아 어댑터 뒤에 만들어진다. 주체는 그 연결의 열린 런에서 찾고(스펙 「그 런을
    // 시킨 사람」 절), 없으면 끝난 런의 이름이라 실행하지 않는다
    let control: ControlService;
    const controlCall = async (
      principal: Principal | undefined,
      call: { tool: string; args: unknown },
    ): Promise<ControlResult> =>
      principal
        ? control.call(principal, call.tool, call.args)
        : { ok: false, error: { code: "NOT_FOUND", message: "no open run for this call" } };
    const clientAddress = clientAddressOf(trustProxy);
    const adapters: AgentAdapter[] = deps.adapters
      ? [...deps.adapters]
      : [
          // Gateway 연결은 아래 bootGateways 가 DB 에서 넣는다 — 0개여도 뜬다(멀티 Gateway 스펙 「.env」 절)
          createOpenClawAdapter({
            dataDir: config.DATA_DIR,
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
            onCanonical: (message, connectionId) =>
              orchestrator.onCanonical(message, "openclaw", connectionId),
            onControlCall: (connectionId, call) =>
              controlCall(principalForBridge(db, connectionId, call.sessionKey, call.runId), call),
            sessionKeysToRecover: (connectionId) => sessionRecoverTargets(db).get(connectionId) ?? [],
            ...(config.OPENCLAW_FRAME_DUMP_PATH === undefined
              ? {}
              : { frameDumpPath: config.OPENCLAW_FRAME_DUMP_PATH }),
            ...(deps.gatewayBackoff === undefined ? {} : { backoff: deps.gatewayBackoff }),
          }),
        ];
    // 러너(러너 스펙 2장) — 사람 머신의 러너가 /runner 로 붙어 온다. 최종 답·post 는 OpenClaw 정본과 같은 자리로 저장한다
    // 러너 첨부 GET 의 읽기 범위를 이 어댑터에 묻는다(판정 R5) — 어댑터가 없으면(테스트의 가짜 runner) 열린 런도 없다
    let runnerAdapter: RunnerAdapter | undefined;
    if (
      (deps.runnerAdapter ?? deps.adapters === undefined) &&
      !adapters.some((a) => a.provider === "runner")
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
        onOutbound: async (message, connectionId) => {
          const { messageId } = await orchestrator.onCanonical(message, "runner", connectionId);
          if (messageId === undefined) throw new Error("canonical store returned no message id");
          return { messageId };
        },
        tokenCount: () => activeRunnerTokenCount(db, workspaceId),
        onControlCall: (connectionId, call) =>
          controlCall(principalForRunner(db, connectionId, call.runId), call),
        agentDefinition: (agentId, tokenId) => runnerAgentDefinition(db, workspaceId, agentId, tokenId),
        // 러너 소켓마다 버킷(러너 스펙 밖 — 이월 「러너 프레임 속도 제한」). 사건은 어댑터가 주소별 1분에 한 번만 부른다
        frameLimit: {
          buckets: () => ({
            events: new TokenBucket({ ...limits.runner.events, now: limitClock }),
            control: new TokenBucket({ ...limits.runner.control, now: limitClock }),
          }),
          onLimited: (address, frame, dropped) =>
            ops.record({
              kind: "ratelimit",
              key: `runner:${frame}`,
              severity: "info",
              detail: { ipPrefix: ipPrefix(address), dropped },
            }),
        },
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
    if (!hasGateways(openclaw)) throw new Error("the OpenClaw adapter does not manage gateways");
    // DB 의 Gateway 를 모두 넣는다(꺼진 것은 enabled: false) — 연결은 아래 connect() 가 시작한다
    const gatewayCount = bootGateways(db, workspaceId, openclaw, (gatewayId, err) =>
      logger.error({ err, gatewayId }, "gateway config rejected by the adapter"),
    );
    if (gatewayCount === 0) logger.info("no OpenClaw gateway configured — add one in the connection page");
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
      runners: runnerAdapter ?? null,
    };
    registerChannelRoutes(fastify, routeContext);
    registerAgentRoutes(fastify, routeContext);
    registerMessageRoutes(fastify, routeContext);
    registerConversationRoutes(fastify, routeContext);
    registerDmRoutes(fastify, routeContext);
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
    registerReadRoutes(fastify, { auth, db, workspaceId });
    registerTokenRoutes(fastify, { auth, db, workspaceId });
    // 첨부: 업로드의 「블롭 쓰기 + 행 넣기」와 정리의 「행 없음 확인 + 블롭 지우기」는 같은 잠금 객체를 지나야 한다 —
    // 이 한 변수로만 넘긴다(App.blobLocks 로도 내보내 테스트가 잠근다)
    mkdirSync(config.attachmentsDir, { recursive: true });
    const blobLocks = deps.blobLocks ?? createBlobLocks();
    // 꺼진 Gateway 의 토큰은 401 이되 실패로 세지 않는다 — 첨부 HTTP·설치 파일이 같은 판정(핸드셰이크는 어댑터가 가른다)
    const acceptBridgeGateway = (gatewayId: string) =>
      getGatewayRow(db, workspaceId, gatewayId)?.enabled === true;
    const agentTokenGuard: AgentTokenGuard = {
      guard: bridgeGuard,
      now: limitClock,
      onBlocked: onAuthBlocked,
    };
    registerAttachmentRoutes(fastify, {
      auth,
      db,
      workspaceId,
      dir: config.attachmentsDir,
      verifyBridgeToken,
      acceptBridgeGateway,
      runner: {
        verifyToken: verifyRunnerToken,
        mayRead: (tokenId, attachmentId) => runnerAdapter?.mayReadAttachment(tokenId, attachmentId) ?? false,
      },
      bridgeGuard: agentTokenGuard,
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
    // 통로(네이티브 푸시 스펙 「통로」 장) — 웹 푸시는 VAPID 키가 늘 있으니 늘 켜진다. 네이티브 통로는 자격 증명이 있을 때만
    if (config.PUSH_RELAY_URL !== undefined)
      logger.warn("PUSH_RELAY_URL is set but the push relay is not implemented yet — ignored");
    let apns: ReturnType<typeof apnsTransport> | undefined;
    if (deps.pushTransports?.apns === undefined) {
      const credentials = loadApnsCredentials({
        dataDir: config.DATA_DIR,
        ...(config.APNS_KEY_PATH === undefined ? {} : { keyPath: config.APNS_KEY_PATH }),
        ...(config.APNS_KEY_ID === undefined ? {} : { keyId: config.APNS_KEY_ID }),
        ...(config.APNS_TEAM_ID === undefined ? {} : { teamId: config.APNS_TEAM_ID }),
      });
      if ("off" in credentials) logger.info(`push transport apns: off(${credentials.off})`);
      else {
        apns = apnsTransport({
          credentials,
          logger,
          ...(config.APNS_HOST === undefined ? {} : { host: config.APNS_HOST }),
          ...(config.APNS_CA_PATH === undefined ? {} : { ca: readFileSync(config.APNS_CA_PATH) }),
        });
        logger.info("push transport apns: on");
        const opened = apns;
        undo.push({ step: "apns", run: () => opened.close() });
      }
    }
    let fcm = deps.pushTransports?.fcm;
    if (fcm === undefined) {
      const credentials = loadFcmCredentials({
        dataDir: config.DATA_DIR,
        path: config.FCM_SERVICE_ACCOUNT_PATH,
      });
      if ("off" in credentials) logger.info(`push transport fcm: off(${credentials.off})`);
      else {
        logger.info("push transport fcm: on");
        fcm = fcmTransport({
          credentials,
          host: config.FCM_HOST,
          tokenUri: config.FCM_TOKEN_URI,
          logger,
        });
      }
    }
    const pushTransports: PushTransports = {
      ...(apns === undefined ? {} : { apns }),
      ...deps.pushTransports,
      ...(fcm === undefined ? {} : { fcm }),
      webpush:
        deps.pushTransports?.webpush ??
        webPushTransport(
          deps.pushSend ??
            webPushSender({
              subject: config.vapid.subject,
              publicKey: vapid.publicKey,
              privateKey: vapid.privateKey,
            }),
          logger,
        ),
    };
    const capabilities = pushCapabilities(pushTransports);
    registerPushRoutes(fastify, {
      auth,
      db,
      workspaceId,
      publicKey: vapid.publicKey,
      capabilities: () => capabilities,
    });
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
      const detail = registry.forProvider("runner")?.setupDetail();
      return detail?.provider === "runner" ? detail.runners : [];
    };
    const setupStatus = () =>
      buildSetupStatus({
        gateways: listGatewayRows(db, workspaceId),
        details: openclaw.gatewaySetupDetails(),
        pluginFile,
        runners: runnerDetail(),
        runnerFile,
        serverVersion: packageJson.version,
        publicUrl,
      });
    // 어느 어댑터든 setup 이벤트(마이크로태스크 뒤)·Gateway 저장·토큰 발급·폐기 때 owner 에게 다시 읽은 상태를 보낸다
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
    const offPromptResync = watchPluginHellos({ db, bus, logger, registry });
    undo.push({ step: "prompt-resync", run: () => offPromptResync() });
    const serverUrl = runnerServerUrl(publicUrl);
    registerSetupRoutes(fastify, {
      auth,
      db,
      workspaceId,
      pluginFile,
      status: setupStatus,
      bridgeToken: requireAgentToken({
        verify: verifyBridgeToken,
        guard: agentTokenGuard,
        path: "bridge",
        route: "installer",
        accept: (result) => acceptBridgeGateway((result as { gatewayId: string }).gatewayId),
      }),
      // 파일은 부팅 때 한 번 잰다 — 본문도 그때 한 번(다시 빌드된 파일은 재시작해야 내려 주는 것과 같다)
      llmsTxt: renderLlmsTxt({
        origin: serverUrl,
        webOrigin: config.APP_ORIGIN,
        bridgeUrl: publicUrl,
        plugin: pluginFile,
        runner: runnerFile,
      }),
      llmsLimit: createIpLimit(fastify, { perMin: limits.llmsTxtPerMin, ops }),
    });
    registerGatewayRoutes(fastify, {
      auth,
      db,
      logger,
      workspaceId,
      gateways: openclaw,
      publicUrl,
      changed: emitSetupStatus,
      agentsChanged: () => bus.emit("agents.changed", {}),
    });
    registerRunnerRoutes(fastify, {
      auth,
      db,
      logger,
      workspaceId,
      registry,
      ops,
      runnerFile,
      serverUrl,
      runnerToken: requireAgentToken({
        verify: verifyRunnerToken,
        guard: agentTokenGuard,
        path: "runner",
        route: "installer",
      }),
      changed: emitSetupStatus,
    });
    registerRunnerAdminRoutes(fastify, {
      auth,
      db,
      logger,
      workspaceId,
      bus,
      runners: runnerAdapter ?? null,
      limits,
      ops,
      now: limitClock,
    });
    // 자동화(자동화 스펙): 예약 틱·웹훅·「지금 실행」이 같은 게시(라우터로 멘션 런)와 같은 워크스페이스 시간대를 쓴다
    const automationPost: PostDeps = {
      db,
      bus,
      logger,
      route: (message) => services.router.routeMessage(message),
    };
    const workspaceTimeZone = () => getOpsSettings(db, workspaceId, logger).timeZone;
    registerAutomationRoutes(fastify, {
      auth,
      db,
      workspaceId,
      post: automationPost,
      // 웹훅 URL 은 웹 오리진(APP_ORIGIN)이 아니라 서버 공개 주소로 — 러너 serverUrl 과 같은 값(계획 판정 PA2)
      publicOrigin: () => serverUrl,
      timeZone: workspaceTimeZone,
    });
    // 웹훅 토큰을 맞혀 보는 것은 같은 숫자(bridgeFail)의 웹훅 전용 실패 카운터가 막는다 — 나누는 까닭은 WebhookRouteContext.guard
    registerWebhookRoute(fastify, {
      db,
      post: automationPost,
      guard: new BridgeAuthGuard(limits.bridgeFail),
      onBlocked: (address) => onAuthBlocked(address, "webhook"),
      limits,
      ops,
      now: limitClock,
    });
    // 운영 상태 요약 — 운영 API 와 제어 도구 ops_status 가 같은 문맥으로 만든다
    const opsStatusContext: OpsStatusContext = {
      db,
      workspaceId,
      adapter: openclaw,
      ops,
      disk: () => disk.current(),
      serverVersion: packageJson.version,
      startedAt,
      previousClean: () => previousClean,
    };
    // 운영 API(운영 보강 스펙 6장) — /healthz 에서 뺀 워크스페이스 id·어댑터 상세도 여기서 owner 에게만
    registerOpsRoutes(fastify, {
      ...opsStatusContext,
      auth,
      // 붙은 어댑터에 등록된 에이전트의 프로그램 — 러너 어댑터는 늘 붙으므로, 러너 에이전트가 없는 배포는 OpenClaw 만 쓰는 배포와 같다
      programsInUse: () =>
        programsWithAgents(
          db,
          workspaceId,
          adapters.map((adapter) => adapter.provider),
        ),
      ops,
    });
    // 제어 도구(제어 MCP 스펙) — REST 와 같은 액션 함수·정책 함수로 처리한다. 런 종료·확인 카드 결정이 되돌아오도록 서비스에 잇는다 —
    // 부팅 정리(recoverOnBoot)가 닫는 런의 카드도 닫히게 그보다 먼저
    control = createControlService({
      db,
      bus,
      logger: logger.child({ mod: "control" }),
      workspaceId,
      ops,
      limits,
      now: limitClock,
      approvals: services.approvals,
      channels: routeContext,
      agents: routeContext,
      opsStatus: () => buildOpsStatus(opsStatusContext),
      ...(deps.controlConfirmTtlMs === undefined ? {} : { confirmTtlMs: deps.controlConfirmTtlMs }),
    });
    services.bindControl(control);
    // 바깥 MCP 클라이언트(스펙 「바깥 — /mcp」 절) — 개인 토큰 실패는 같은 숫자(bridgeFail)의 /mcp 전용 카운터가 센다. 브리지·러너
    // 카운터와 나누는 까닭: 사람 머신의 MCP 클라이언트에 남은 폐기된 토큰이나, 같은 출구 주소(NAT) 뒤 한 사람의 잘못된 설정이 그
    // 주소의 러너·플러그인 핸드셰이크와 런 도중 첨부 HTTP 를 막으면 안 된다. 토큰은 256비트라 맞혀 보기 방어는 나눠도 같다
    registerMcpRoute(fastify, {
      db,
      workspaceId,
      control,
      guard: { guard: new BridgeAuthGuard(limits.bridgeFail), now: limitClock, onBlocked: onAuthBlocked },
      serverVersion: packageJson.version,
    });
    // 인증 없이 열려 있다 — 워크스페이스 id·어댑터 상세는 내놓지 않는다(운영 보강 스펙 8장, 상세는 owner 전용 ops/status)
    fastify.get("/healthz", async (_request, reply) => {
      const dbOk = pingDb(db, logger);
      return reply.status(dbOk ? 200 : 503).send({ ok: dbOk, db: dbOk ? "ok" : "error" });
    });

    // 종료 ①: close() 가 켜면 새 wire 연결을 인증보다 먼저 거부한다. 기존 연결·/bridge 는 어댑터가 닫힐 때까지 둔다
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
      clientAddress,
    });
    const fanout = attachWireFanout(io, bus, { logger, db, workspaceId, maxPending: deps.wireMaxPending });
    undo.push({ step: "fanout", run: () => fanout.close() });
    const watch = watchGatewayReconnecting(openclaw, bus, logger);
    undo.push({ step: "watch", run: () => watch.close() });
    // 운영 사건(스펙 5.2·5.3·3.1 run_failed) — 위 system.notice 감시와 따로 돈다. 부팅 정리(recoverOnBoot)가 닫는 런도 센다
    const connections = watchConnections(openclaw, ops, deps.disconnectEventMs ?? DISCONNECT_EVENT_MS);
    undo.push({ step: "connections", run: () => connections.close() });
    const attachedRunner = registry.forProvider("runner");
    const runners = attachedRunner
      ? watchRunners(attachedRunner, ops, {
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
    const pushDispatcher = createPushDispatcher({ db, logger, presence, transports: pushTransports, ops });
    // undo 는 역순이다 — 트리거를 뗀 다음, db 를 닫기 전에 진행 중인 발송을 정상 종료와 같은 상한으로 기다린다(구독 정리가 db 를 쓴다)
    undo.push({ step: "push-drain", run: () => pushDispatcher.drain(PUSH_DRAIN_TIMEOUT_MS) });
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

    // 예약 자동화(자동화 스펙 「스케줄러」 절): 부팅 정리와 어댑터 연결 뒤에 첫 틱 — 그보다 먼저 만든 멘션 런은 recoverOnBoot 가
    // 지난 부팅의 것으로 보고 닫는다
    const automationTicks = startAttachmentSweeper(
      () =>
        tick({ ...automationPost, ops, timeZone: workspaceTimeZone }, new Date()).catch((err: unknown) =>
          logger.error({ err }, "automation tick failed"),
        ),
      deps.automationTickMs ?? AUTOMATION_TICK_INTERVAL_MS,
    );

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
      await step("prompt-resync", () => offPromptResync());
      await step("push-triggers", () => pushTriggers.close()); // 새 발송을 받지 않는다 — 이미 나간 것은 ⑥ 앞에서 잠깐 기다린다
      // 진행 중인 틱이 게시·사건 기록을 끝낸 뒤 ops·orchestrator 를 닫는다
      await step("automations", () => automationTicks.close());
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
      await step("apns", async () => apns?.close()); // 발송이 끝난 뒤에 세션을 닫는다
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
      control,
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
 * 어댑터 status 이벤트로 Gateway 마다 상태를 본다. 한 Gateway 의 reconnecting 이 delayMs 동안 이어지면 그 Gateway 이름을 넣은
 * system.notice warn 을 한 번 보낸다(멀티 Gateway 스펙 「운영」 절). reconnecting 을 벗어나면 다시 잰다. 꺼진·지운 Gateway 는 재지 않는다.
 * 타이머는 unref — 프로세스를 붙잡지 않는다.
 */
export function watchGatewayReconnecting(
  adapter: Pick<AgentAdapter, "status" | "onEvent">,
  bus: ServerBus,
  logger: Pick<Logger, "warn">,
  delayMs = GATEWAY_RECONNECTING_NOTICE_MS,
): { close(): void } {
  type Watched = { name: string; state: GatewayLinkState; timer?: ReturnType<typeof setTimeout> };
  const watched = new Map<string, Watched>();
  const observe = (status: AdapterStatus) => {
    // Gateway 는 OpenClaw 어댑터에만 있다
    if (status.provider !== "openclaw") return;
    const listed = new Set<string>();
    for (const entry of status.gateways) {
      listed.add(entry.id);
      const w = watched.get(entry.id) ?? { name: entry.name, state: entry.gateway };
      const changed = !watched.has(entry.id) || w.state !== entry.gateway;
      watched.set(entry.id, w);
      w.name = entry.name;
      if (!changed) continue;
      w.state = entry.gateway;
      clearTimeout(w.timer);
      w.timer = undefined;
      if (entry.gateway !== "reconnecting") continue;
      w.timer = setTimeout(() => {
        w.timer = undefined;
        logger.warn({ delayMs, gatewayId: entry.id }, "gateway still reconnecting");
        bus.emit("system.notice", {
          level: "warn",
          message: `OpenClaw Gateway 「${w.name}」에 연결하지 못하고 있습니다`,
        });
      }, delayMs);
      w.timer.unref();
    }
    for (const [id, w] of watched) {
      if (listed.has(id)) continue;
      clearTimeout(w.timer);
      watched.delete(id);
    }
  };
  const off = adapter.onEvent((e) => {
    if (e.kind === "status") observe(e.status);
  });
  observe(adapter.status());
  return {
    close() {
      off();
      for (const w of watched.values()) clearTimeout(w.timer);
      watched.clear();
    },
  };
}

/**
 * 주기 작업(첨부 정리·자동화 틱)을 지금 한 번, 그 뒤 intervalMs 마다 부른다. 앞 회가 안 끝났으면 그 주기는 건너뛴다(겹쳐 돌지 않는다).
 * run 이 던져도 다음 주기에 다시 돈다. 타이머는 unref. close() 는 타이머를 멈추고 진행 중인 회를 기다린다
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

/** 워크스페이스는 하나 — 있으면 그 id, 없으면 만든다. dev:fake 가 createApp 전에 시드를 넣을 때도 쓴다 */
export function ensureWorkspace(db: DbOrTx, name: string): string {
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

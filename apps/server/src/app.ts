import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Server } from "socket.io";
import { v7 as uuidv7 } from "uuid";
import type { AgentAdapter } from "./adapters/types";
import { type Auth, createAuth } from "./auth";
import { bootstrapOwner } from "./auth/owner";
import { registerAuthRoutes } from "./auth/routes";
import type { ServerConfig } from "./config";
import { createDb, type Db } from "./db/client";
import { workspaces } from "./db/schema.sqlite";
import { HttpError, httpStatusToErrorCode } from "./http/errors";
import { createLogger, type Logger } from "./logger";
import { registerAgentRoutes } from "./modules/agents/routes";
import { registerChannelRoutes } from "./modules/channels/routes";
import { registerMessageRoutes } from "./modules/messages/routes";
import { ServerBus } from "./realtime/bus";
import { attachWireFanout } from "./realtime/events";
import { attachWire } from "./realtime/socket";
import type { WireServer } from "./realtime/types";

/** adapter 가 없으면 헬스는 down, REST 의 어댑터 경로(discover)는 ADAPTER_UNAVAILABLE. 실제 배선은 태스크 12. */
export type AppDeps = {
  adapter?: AgentAdapter | undefined;
  logger?: Logger;
  /** wire 소켓별 미전송 큐 상한(기본 500) — 테스트가 낮춘다 */
  wireMaxPending?: number;
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
  /** listen 뒤에만 채워진다. 그 전에는 빈 문자열. */
  readonly url: string;
  close(): Promise<void>;
};

export async function createApp(config: ServerConfig, deps: AppDeps = {}): Promise<App> {
  const logger = deps.logger ?? createLogger(config.LOG_LEVEL);
  // DATA_DIR 은 gitignore 라 새 클론·워크트리에 없다 — better-sqlite3 는 디렉터리를 만들지 않는다(리뷰 sc-t1 지적 2)
  if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = createDb(config.dbPath);
  const workspaceId = ensureWorkspace(db, config.DODOK_WORKSPACE_NAME);
  const auth = createAuth(db, config, logger);
  const { userId: ownerUserId } = await bootstrapOwner(db, auth, config, workspaceId);
  const bus = new ServerBus();
  // 기본 제네릭(FastifyBaseLogger)으로 추론되게 한다 — pino Logger 로 추론되면 FastifyInstance·플러그인 타입과 어긋난다
  const loggerInstance: FastifyBaseLogger = logger;
  const fastify = Fastify({ loggerInstance });
  await fastify.register(cookie);
  // 라우트가 config.rateLimit 로 켠 곳에만 건다(/api/v1/auth/local)
  await fastify.register(rateLimit, { global: false });
  fastify.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError) {
      // INTERNAL HttpError(저장값 계약 위반 등)는 서버 버그다 — 원인(cause)과 함께 남긴다
      if (error.body.code === "INTERNAL") logger.error({ err: error, cause: error.cause }, "internal error");
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
  registerAuthRoutes(fastify, {
    auth,
    db,
    logger,
    workspaceId,
    secureCookie: new URL(config.APP_ORIGIN).protocol === "https:",
  });
  const routeContext = { auth, db, bus, logger, workspaceId, adapter: deps.adapter };
  registerChannelRoutes(fastify, routeContext);
  registerAgentRoutes(fastify, routeContext);
  registerMessageRoutes(fastify, routeContext);
  fastify.get("/healthz", async () => ({
    ok: true,
    db: "ok",
    workspace: workspaceId,
    adapter: deps.adapter?.status() ?? { provider: "openclaw", gateway: "down", bridge: "down" },
  }));
  const io: WireServer = new Server(fastify.server, {
    cors: { origin: config.APP_ORIGIN, credentials: true },
  });
  // route·runs 는 태스크 9 가 라우터·오케스트레이터로 바꾼다. 어댑터 배선은 태스크 12
  attachWire(io, { auth, db, bus, logger, workspaceId, route: async () => {}, runs: null });
  const fanout = attachWireFanout(io, bus, { logger, maxPending: deps.wireMaxPending });
  await fastify.ready();
  return {
    fastify,
    io,
    db,
    bus,
    logger,
    workspaceId,
    auth,
    ownerUserId,
    get url() {
      const addr = fastify.server.address();
      return typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
    },
    async close() {
      fanout.close();
      io.close();
      await fastify.close();
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

import type { AdapterStatus } from "@dodok/shared";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { v7 as uuidv7 } from "uuid";
import type { ServerConfig } from "./config";
import { createDb, type Db } from "./db/client";
import { workspaces } from "./db/schema.sqlite";
import { HttpError } from "./http/errors";
import { createLogger, type Logger } from "./logger";
import { ServerBus } from "./realtime/bus";

/** 태스크 6 이 AgentAdapter 로 넓힌다. 지금은 헬스에 필요한 status() 만. */
export type AppDeps = { adapter?: { status(): AdapterStatus } | undefined; logger?: Logger };

export type App = {
  fastify: FastifyInstance;
  io: Server;
  db: Db;
  bus: ServerBus;
  logger: Logger;
  workspaceId: string;
  /** listen 뒤에만 채워진다. 그 전에는 빈 문자열. */
  readonly url: string;
  close(): Promise<void>;
};

export async function createApp(config: ServerConfig, deps: AppDeps = {}): Promise<App> {
  const logger = deps.logger ?? createLogger(config.LOG_LEVEL);
  const db = createDb(config.dbPath);
  const workspaceId = ensureWorkspace(db, config.DODOK_WORKSPACE_NAME);
  const bus = new ServerBus();
  // 기본 제네릭(FastifyBaseLogger)으로 추론되게 한다 — pino Logger 로 추론되면 FastifyInstance·플러그인 타입과 어긋난다
  const loggerInstance: FastifyBaseLogger = logger;
  const fastify = Fastify({ loggerInstance });
  await fastify.register(cookie);
  fastify.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send(error.body);
    logger.error({ err: error }, "unhandled");
    return reply.status(500).send({ code: "INTERNAL", message: "internal error" });
  });
  fastify.get("/healthz", async () => ({
    ok: true,
    db: "ok",
    workspace: workspaceId,
    adapter: deps.adapter?.status() ?? { provider: "openclaw", gateway: "down", bridge: "down" },
  }));
  const io = new Server(fastify.server, { cors: { origin: config.APP_ORIGIN, credentials: true } });
  // 인증·wire·어댑터·REST 배선은 태스크 3/5/12 가 여기에 register 한다
  await fastify.ready();
  return {
    fastify,
    io,
    db,
    bus,
    logger,
    workspaceId,
    get url() {
      const addr = fastify.server.address();
      return typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
    },
    async close() {
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

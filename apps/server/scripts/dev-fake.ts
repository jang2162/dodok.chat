/**
 * 가짜 에이전트 개발 모드 — 가짜 Gateway·가짜 플러그인·대본을 묶어 서버를 띄운다. 모델 런·실제 Gateway 없이 웹 전체를 돌린다(웹 MVP 스펙 9.2).
 * 테스트와 같은 가짜(`test/fakes/*`)를 쓴다. 운영 코드(`src/`)는 그대로 — 실제 OpenClawAdapter 가 가짜 Gateway 를 dev Gateway 로 붙는다.
 *
 * .env 를 읽지 않는다: 토큰·비밀은 아래 개발 전용 고정값이고(로그에 찍어도 된다), loadConfig 에는 여기서 정한 값만 넘긴다.
 * DB 는 <dataDir>/dev-fake.sqlite — 시작마다 새로, `--keep` 이면 유지. 실행: `PORT=0 pnpm -F @dodok/server dev:fake [--keep]`.
 */
import type { InboundDeliver } from "@dodok/shared";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type App, createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { type FakeGateway, startFakeGateway } from "../test/fakes/fake-gateway";
import { type FakePlugin, startFakePlugin } from "../test/fakes/fake-plugin";
import { createScenario, type ScenarioAgent, type ScenarioScript } from "../test/fakes/scenario";
import { waitForAdapterConnected } from "../test/helpers/live-app";

/** 개발 전용 고정 로그인 토큰(= owner 비밀번호). 시크릿이 아니다 — 로그에 찍는다 */
export const DEV_FAKE_LOCAL_TOKEN = "dev-fake-local-token";
const DEV_FAKE_SECRET = "dev-fake-better-auth-secret-00000000";
const DEV_FAKE_BRIDGE_TOKEN = "dev-fake-bridge-token";
/** 가짜 Gateway `agents.list` 와 같다 — 이 providerAgentId 마다 대본을 건다 */
const AGENT_IDS = ["dev", "fin"] as const;
/** 실제 클라이언트는 hello 의 tickIntervalMs(30s)×2 동안 프레임이 없으면 끊는다 */
const TICK_INTERVAL_MS = 15_000;
const DELTA_PARTS = 4;
const QUOTE_MAX = 40;

export type DevFakeOptions = {
  /** 기본 3000. 0 이면 빈 포트 */
  port?: number;
  /** 기본 cwd 의 `data` */
  dataDir?: string;
  /** true 면 dev-fake.sqlite 를 지우지 않는다 */
  keep?: boolean;
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
};
export type DevFake = { app: App; url: string; close(): Promise<void> };

/** 코드 포인트 단위로 대략 같은 길이 parts 개로 나눈다(서로게이트 쌍을 가르지 않는다) */
function splitDeltas(text: string, parts: number): string[] {
  const chars = [...text];
  const size = Math.max(1, Math.ceil(chars.length / parts));
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

/**
 * 받은 글로 대본을 고른다 — 키워드: 드롭·실패·느리게·도구. 받은 글을 `@` 없이 인용해(멘션을 새로 만들지 않는다) 되받고,
 * 글이 부른 채널의 다른 에이전트와 보낸 에이전트를 끝의 「@핸들 이어서 부탁해요」로만 불러 릴레이를 만든다.
 * 핸들은 채널 참여자(`context.participants`)에서 읽는다 — 등록한 핸들이 providerAgentId 와 달라도 된다.
 */
export function fakeAgentScript(self: string, d: InboundDeliver): ScenarioScript {
  const { text, author } = d.message;
  if (text.includes("드롭")) return { drop: "bot-loop-protection", reply: "" };
  const others = new Set(
    d.context.participants.filter((p) => p.type === "agent" && !p.isSelf).map((p) => p.handle),
  );
  const calls = new Set(
    [...text.matchAll(/@([a-z0-9_-]{2,32})/g)].map((m) => m[1] ?? "").filter((h) => others.has(h)),
  );
  if (author.type === "agent" && others.has(author.handle)) calls.add(author.handle);
  const quote = [...text.replaceAll("@", "").replace(/\s+/g, " ").trim()].slice(0, QUOTE_MAX).join("");
  const tail = calls.size > 0 ? ` ${[...calls].map((h) => `@${h}`).join(" ")} 이어서 부탁해요.` : "";
  const reply = `**${self}**: 「${quote}」 잘 받았어요.${tail}`;
  return {
    reply,
    deltas: splitDeltas(reply, DELTA_PARTS),
    deltaDelayMs: text.includes("느리게") ? 1_500 : 150,
    ...(text.includes("실패") ? { fail: "fake failure" } : {}),
    ...(text.includes("도구") ? { tool: { name: "Read", args: { path: "README.md" }, result: "ok" } } : {}),
  };
}

/** 가짜 Gateway → createApp(실제 OpenClawAdapter) → listen → 가짜 플러그인 → 대본 → 어댑터 gateway·bridge connected. 실패하면 만든 것을 닫고 던진다 */
export async function startDevFake(opts: DevFakeOptions = {}): Promise<DevFake> {
  const dataDir = opts.dataDir ?? "data";
  const port = opts.port ?? 3000;
  const dbPath = join(dataDir, "dev-fake.sqlite");
  mkdirSync(dataDir, { recursive: true });
  if (!opts.keep) for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });

  const gateway: FakeGateway = await startFakeGateway({ tickIntervalMs: TICK_INTERVAL_MS });
  let app: App | undefined;
  let plugin: FakePlugin | undefined;
  let closing: Promise<void> | undefined;
  // 앱이 먼저 닫혀야 플러그인이 shutdown notice 를 받고, 어댑터가 Gateway 연결을 스스로 끊는다
  const close = () => {
    closing ??= (async () => {
      await app?.close();
      plugin?.close();
      await gateway.close();
    })();
    return closing;
  };
  try {
    app = await createApp(
      loadConfig({
        HOST: "127.0.0.1",
        PORT: String(port),
        APP_ORIGIN: "http://localhost:5173",
        DATA_DIR: dataDir,
        DB_PATH: dbPath,
        LOG_LEVEL: opts.logLevel ?? "info",
        LOCAL_AUTH_TOKEN: DEV_FAKE_LOCAL_TOKEN,
        BETTER_AUTH_SECRET: DEV_FAKE_SECRET,
        BRIDGE_TOKEN: DEV_FAKE_BRIDGE_TOKEN,
        OPENCLAW_TARGET: "dev",
        OPENCLAW_DEV_GATEWAY_URL: gateway.url,
        OPENCLAW_DEV_GATEWAY_TOKEN: gateway.token,
        OPENCLAW_DEVICE_IDENTITY_PATH: join(dataDir, "dev-fake-device.json"),
      }),
      {},
    );
    await app.fastify.listen({ host: "127.0.0.1", port });
    plugin = await startFakePlugin({ bridgeUrl: app.url, token: DEV_FAKE_BRIDGE_TOKEN });
    const agents: Record<string, ScenarioAgent> = {};
    for (const id of AGENT_IDS) agents[id] = ({ delivery }) => fakeAgentScript(id, delivery);
    createScenario({ gateway, plugin, agents });
    // adapter.connect() 는 기다리지 않는다 — 돌려주자마자 discover·전송이 되게
    await waitForAdapterConnected(app);
    return { app, url: app.url, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dev = await startDevFake({
    port: Number(process.env.PORT || 3000),
    dataDir: resolve(import.meta.dirname, "../../../data"),
    keep: process.argv.includes("--keep"),
  });
  dev.app.logger.info(
    { url: dev.url, web: "http://localhost:5173", loginToken: DEV_FAKE_LOCAL_TOKEN },
    "dev:fake 서버 — 웹은 pnpm -F @dodok/web dev, 로그인 토큰은 개발 전용 고정값",
  );
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1); // 두 번째 신호는 기다리지 않는다
    stopping = true;
    void dev.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/**
 * Phase 0 스파이크 3 — 채널 프롬프트 갱신 경로 + 이월 측정 러너 (ADR 0003).
 *
 * 회전(P6 `:g2`)·inboundChannelPrompt(P4 prefix·P5 context) 시나리오는 계획서 10장 #18·#19 로 제거 — 전체 재현은 커밋 752e7f9 시점 코드.
 *
 * 스파이크 2 러너(`bridge-spike.ts`)의 브리지 서버·시나리오 뼈대를 복사해 넓혔다(스파이크 코드라 중복 허용).
 *   질문 1 P0~P3  채널 systemPrompt 갱신이 이미 도는(재개되는) claude-cli 세션에 언제 반영되는가
 *   질문 2 T·TI   components v1 위반(ToolInputError)이 모델 런(T)·직접 호출(TI, 런 없음)에서 어떻게 보이는가
 *   질문 3 H      chat.history 커서 증분({kind:"delta"} / {kind:"reset"})
 *   질문 4 W      chat.send + originatingChannel "dodok" 대체 경로의 응답 배달
 * 관찰은 마스킹해 `data/spike-3-observations-<label>.json` 에, CLI 전체 출력은 `data/spike-3-cli.log` 에 남긴다.
 *
 * 환경(.env): OPENCLAW_DEV_GATEWAY_URL, OPENCLAW_DEV_GATEWAY_TOKEN, BRIDGE_URL, BRIDGE_TOKEN.
 * 원격 Gateway 변수(OPENCLAW_GATEWAY_*)는 읽지 않는다.
 *
 * 실행: `DODOK_SPIKE_MAX_RUNS=10 pnpm -F @dodok/openclaw-adapter spike:prompt`
 *   DODOK_SPIKE_MAX_RUNS      **누적** 모델 런 상한(기본 0). 사용 기록은 `data/spike-3-run-ledger.json` 이라 다시 띄워도 이어서 센다
 *   DODOK_SPIKE_SCENARIOS     쉼표 목록(기본 P0,P1,P2,P3,T,TI,W,H). SETUP(플러그인 재설치·채널 설정 초기화)은 적을 때만
 *   DODOK_SPIKE_LABEL         관찰 파일 접미사(기본 main)
 *   DODOK_SPIKE_AGENT         에이전트 id(기본 dev)
 *   DODOK_SPIKE_STOP_GATEWAY  1 이면 끝날 때 dev Gateway 를 내린다
 * 설정 변경·Gateway 재시작은 **그 시나리오가 선택되고 런 예산이 남았을 때만** 한다(스파이크 2 C/D 결함 재발 방지).
 *
 * 이 파일은 스파이크용이라 테스트하지 않는다.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import type { InboundDeliver, InboundDeliverResult, OutboundMessage, Result } from "@dodok/shared";
import type { EventFrame } from "@openclaw/gateway-protocol";
import Fastify from "fastify";
import { Server } from "socket.io";
import { attachBridge, type GatewayBridge } from "../bridge/server";
import { verifyBridgeToken } from "../bridge/session";
import { connectGateway, GatewayPairingRequiredError, type GatewayConnection } from "../gateway/client";

type Json = unknown;

function findRepoRoot(): string {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

const REPO_ROOT = findRepoRoot();
const DATA_DIR = join(REPO_ROOT, "data");
const LABEL = process.env["DODOK_SPIKE_LABEL"] ?? "main";
const OBSERVATIONS_PATH = join(DATA_DIR, `spike-3-observations-${LABEL}.json`);
const LEDGER_PATH = join(DATA_DIR, "spike-3-run-ledger.json");
const CLI_LOG_PATH = join(DATA_DIR, "spike-3-cli.log");
const GATEWAY_LOG_PATH = join(DATA_DIR, "dev-gateway.log");
const GATEWAY_PID_PATH = join(DATA_DIR, "dev-gateway.pid");
const DEV_IDENTITY_PATH = join(DATA_DIR, "openclaw-dev-device.json");
const PLUGIN_DIST = join(REPO_ROOT, "packages/openclaw-plugin/dist");
const PLUGIN_TGZ = join(PLUGIN_DIST, "dodok-openclaw-plugin-0.0.0.tgz");
const OPENCLAW_DEV_STATE = join(process.env["HOME"] ?? "", ".openclaw-dev");
const OPENCLAW_NODE_BIN =
  process.env["OPENCLAW_DEV_NODE_BIN"] ??
  "/Applications/OpenClaw.app/Contents/Resources/node-worker/arm64/bin";

const CHANNEL_ID = process.env["DODOK_SPIKE_CHANNEL_ID"] ?? "0199a6c0-0000-7000-8000-000000000c03";
const TOOL_CHANNEL_ID = process.env["DODOK_SPIKE_TOOL_CHANNEL_ID"] ?? "0199a6c0-0000-7000-8000-000000000c04";
const AGENT = process.env["DODOK_SPIKE_AGENT"] ?? "dev";
const MAX_RUNS = Number(process.env["DODOK_SPIKE_MAX_RUNS"] ?? "0");
const SCENARIOS = new Set(
  (process.env["DODOK_SPIKE_SCENARIOS"] ?? "P0,P1,P2,P3,T,TI,W,H")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const STOP_GATEWAY = process.env["DODOK_SPIKE_STOP_GATEWAY"] === "1";
const RUN_TIMEOUT_MS = 120_000;
const HELLO_TIMEOUT_MS = 180_000;

const env = parseEnv(readFileSync(join(REPO_ROOT, ".env"), "utf8"));
function envValue(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} 이 .env 에 없다`);
  return value;
}
const DEV_GATEWAY_URL = envValue("OPENCLAW_DEV_GATEWAY_URL");
const DEV_GATEWAY_TOKEN = envValue("OPENCLAW_DEV_GATEWAY_TOKEN");
const BRIDGE_URL = new URL(envValue("BRIDGE_URL"));
const BRIDGE_TOKEN = envValue("BRIDGE_TOKEN");
const GATEWAY_PORT = Number(new URL(DEV_GATEWAY_URL).port);
const SECRETS = [DEV_GATEWAY_TOKEN, BRIDGE_TOKEN];

const BASE_KEY = `agent:${AGENT}:dodok:channel:${CHANNEL_ID}`;
const TOOL_KEY = `agent:${AGENT}:dodok:channel:${TOOL_CHANNEL_ID}`;
const WORDS = { P1: "AMBER", P3: "COBALT" } as const;
const ALL_WORDS = Object.values(WORDS);
const ASK = `@${AGENT} What is the code word? Reply with just the word.`;
const codePrompt = (word: string): string =>
  `In this channel the secret code word is ${word}. When anyone asks for the code word, answer with exactly that word.`;

// ── 마스킹 ──────────────────────────────────────────────────────────────────────
const SECRET_KEYS = new Set(["token", "deviceToken", "signature", "publicKey", "nonce", "password"]);
const BASE64ISH = /^[A-Za-z0-9+/_-]{40,}={0,2}$/;

function scrub(text: string): string {
  let out = text;
  for (const secret of SECRETS) out = out.split(secret).join(`<masked:${secret.length}>`);
  return out;
}

function maskValue(value: Json, keyHint?: string, limit = 2000): Json {
  if (typeof value === "string") {
    if (keyHint && SECRET_KEYS.has(keyHint)) return `<masked:${value.length}>`;
    if (BASE64ISH.test(value)) return `<masked:${value.length}>`;
    const scrubbed = scrub(value);
    return scrubbed.length > limit ? `${scrubbed.slice(0, limit)}…<truncated:${scrubbed.length}>` : scrubbed;
  }
  // 배열 원소에도 키 힌트를 넘긴다 (ADR 0001 8.1 지적)
  if (Array.isArray(value)) return value.map((entry) => maskValue(entry, keyHint, limit));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, Json> = {};
    for (const [key, entry] of Object.entries(value as Record<string, Json>))
      out[key] = maskValue(entry, key, limit);
    return out;
  }
  return value;
}

function describeError(error: unknown): Json {
  const e = error as { name?: string; message?: string; code?: string; details?: Json };
  return maskValue({
    name: e?.name,
    message: e?.message ?? String(error),
    code: e?.code,
    details: e?.details,
  });
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(stepMs);
  }
}

function sha256File(path: string): string | null {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

// ── 누적 런 원장 ───────────────────────────────────────────────────────────────
type Ledger = { runs: Array<{ scenario: string; runId: string; at: string; label: string }> };

function readLedger(): Ledger {
  if (!existsSync(LEDGER_PATH)) return { runs: [] };
  return JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as Ledger;
}

function budgetLeft(): number {
  return MAX_RUNS - readLedger().runs.length;
}

function recordRun(scenario: string, runId: string): void {
  const ledger = readLedger();
  ledger.runs.push({ scenario, runId, at: new Date().toISOString(), label: LABEL });
  writeFileSync(LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

// ── dev Gateway 로그·CLI·수명 ────────────────────────────────────────────────────
/** dev Gateway 로그에서 새로 붙은 줄만 읽는다 (ANSI 제거) */
class LogTail {
  #offset: number;
  constructor(readonly path: string) {
    this.#offset = existsSync(path) ? statSync(path).size : 0;
  }
  read(): string[] {
    if (!existsSync(this.path)) return [];
    const size = statSync(this.path).size;
    if (size <= this.#offset) return [];
    const fd = openSync(this.path, "r");
    const buffer = Buffer.alloc(size - this.#offset);
    readSync(fd, buffer, 0, buffer.length, this.#offset);
    closeSync(fd);
    this.#offset = size;
    // oxlint-disable-next-line no-control-regex
    return buffer
      .toString("utf8")
      .replace(/\[[0-9;]*m/g, "")
      .split("\n")
      .filter(Boolean);
  }
}

const LOG_KEEP =
  /dodok|cli (exec|argv|turn|live session|env auth)|session.?reset|drift|config change|hot reload|restart|tools-invoke|ToolInputError|originat|sendText|chat\.send/i;
const logTail = new LogTail(GATEWAY_LOG_PATH);
const gatewayLines: { at: number; line: string }[] = [];

function pumpLog(): void {
  for (const line of logTail.read()) {
    if (LOG_KEEP.test(line)) gatewayLines.push({ at: Date.now(), line: scrub(line).slice(0, 4000) });
  }
}

function openclawEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${OPENCLAW_NODE_BIN}:${process.env["PATH"] ?? ""}`,
    ...extra,
  };
  delete childEnv["OPENCLAW_GATEWAY_URL"];
  childEnv["OPENCLAW_GATEWAY_TOKEN"] = DEV_GATEWAY_TOKEN;
  return childEnv;
}

type CliRecord = { args: string[]; status: number | null; stdoutTail: string[]; stderrTail: string[] };

/** `openclaw --dev …` — 전체 출력은 CLI 로그 파일에, 관찰에는 꼬리만 */
function cli(args: string[]): { record: CliRecord; stdout: string } {
  const res = spawnSync("openclaw", ["--dev", ...args], {
    env: openclawEnv(),
    encoding: "utf8",
    timeout: 120_000,
  });
  const stdout = scrub(res.stdout ?? "");
  const stderr = scrub(res.stderr ?? "");
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(
    CLI_LOG_PATH,
    `\n===== ${new Date().toISOString()} [${LABEL}] openclaw --dev ${args.join(" ")} → exit ${res.status}\n--- stdout\n${stdout}\n--- stderr\n${stderr}\n`,
    "utf8",
  );
  console.log(`  openclaw --dev ${args.join(" ")} → exit ${res.status}`);
  const tail = (text: string): string[] => text.trim().split("\n").slice(-6);
  return { record: { args, status: res.status, stdoutTail: tail(stdout), stderrTail: tail(stderr) }, stdout };
}

function listeningPids(): number[] {
  const res = spawnSync("lsof", ["-nP", `-iTCP:${GATEWAY_PORT}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  return (res.stdout ?? "")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function commandOf(pid: number): string {
  return (spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout ?? "").trim();
}

async function startDevGateway(reason: string): Promise<Json> {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(GATEWAY_LOG_PATH, `\n===== spike-3 gateway start (${reason}) ${new Date().toISOString()}\n`);
  const fd = openSync(GATEWAY_LOG_PATH, "a");
  const t0 = Date.now();
  // ADR 0002 2절과 같은 기동. 토큰은 env(OPENCLAW_GATEWAY_TOKEN)로 넘겨 ps 에 남기지 않는다.
  // OPENCLAW_CLI_BACKEND_LOG_OUTPUT=1 — `cli argv:`(시스템 프롬프트 인자 길이)·CLI stdout 을 로그에 남긴다
  const child = spawn(
    "openclaw",
    [
      "--dev",
      "gateway",
      "run",
      "--dev",
      "--auth",
      "token",
      "--port",
      String(GATEWAY_PORT),
      "--bind",
      "loopback",
    ],
    { detached: true, stdio: ["ignore", fd, fd], env: openclawEnv({ OPENCLAW_CLI_BACKEND_LOG_OUTPUT: "1" }) },
  );
  child.unref();
  closeSync(fd);
  writeFileSync(GATEWAY_PID_PATH, `${child.pid ?? ""}\n`, "utf8");
  const listening = await waitFor(() => listeningPids().length > 0, 90_000);
  const record = { event: "start", reason, launcherPid: child.pid, listening, afterMs: Date.now() - t0 };
  console.log(`dev Gateway 기동(${reason}) → ${JSON.stringify(record)}`);
  return record;
}

async function stopDevGateway(reason: string): Promise<Json> {
  const t0 = Date.now();
  const pids = new Set(listeningPids());
  if (existsSync(GATEWAY_PID_PATH)) {
    const launcher = Number(readFileSync(GATEWAY_PID_PATH, "utf8").trim());
    if (Number.isInteger(launcher) && launcher > 0 && /openclaw/.test(commandOf(launcher)))
      pids.add(launcher);
  }
  const targets = [...pids].map((pid) => ({ pid, command: commandOf(pid).slice(0, 160) }));
  for (const { pid } of targets) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 이미 끝난 프로세스
    }
  }
  let down = await waitFor(() => listeningPids().length === 0, 30_000);
  if (!down) {
    for (const pid of listeningPids()) process.kill(pid, "SIGKILL");
    down = await waitFor(() => listeningPids().length === 0, 10_000);
  }
  const record = { event: "stop", reason, targets, down, afterMs: Date.now() - t0 };
  console.log(`dev Gateway 종료(${reason}) → ${JSON.stringify(record)}`);
  return record;
}

// ── 관찰 저장 ───────────────────────────────────────────────────────────────────
type OutboundRecord = { at: number; message: OutboundMessage };
type GatewayEventRecord = { at: number; event: string; payload: Json };

type TurnRecord = {
  name: string;
  description: string;
  sessionKey: string;
  setup: Json[];
  request: Json;
  sentAt: string;
  startResponse?: Json;
  startAfterMs?: number;
  runId?: string;
  finishedBy?: "chat-final" | "session-end" | "dispatch-result" | "timeout" | "no-run" | "skipped";
  finishedAfterMs?: number;
  abortedByTimeout: boolean;
  outbound: Json[];
  gatewayEvents: Json[];
  gatewayLog: string[];
  verdict: Record<string, Json>;
};

const observations = {
  startedAt: new Date().toISOString(),
  label: LABEL,
  scenarios: [...SCENARIOS],
  maxRuns: MAX_RUNS,
  ledgerAtStart: readLedger().runs.length,
  channelId: CHANNEL_ID,
  toolChannelId: TOOL_CHANNEL_ID,
  agent: AGENT,
  keys: { base: BASE_KEY, tool: TOOL_KEY },
  setup: null as Json,
  gatewayLifecycle: [] as Json[],
  hello: [] as Json[],
  observer: [] as Json[],
  bridgeSideEvents: [] as Json[],
  turns: [] as TurnRecord[],
  history: null as Json,
  errors: [] as string[],
  finishedAt: null as string | null,
  ledgerAtEnd: 0,
};

function writeObservations(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OBSERVATIONS_PATH, `${JSON.stringify(observations, null, 2)}\n`, "utf8");
}

const outboundLog: OutboundRecord[] = [];
const gatewayEvents: GatewayEventRecord[] = [];

// ── Gateway 관찰 연결 (operator.admin 도 요청한다) ──────────────────────────────
const OBSERVER_SCOPES = ["operator.read", "operator.write", "operator.admin"];
let observer: GatewayConnection | null = null;

async function connectObserver(reason: string, extraKeys: string[] = []): Promise<void> {
  if (observer) await observer.stop().catch(() => undefined);
  observer = null;
  const attempts: Json[] = [];
  const t0 = Date.now();
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const conn = await connectGateway({
        url: DEV_GATEWAY_URL,
        token: DEV_GATEWAY_TOKEN,
        deviceIdentityPath: DEV_IDENTITY_PATH,
        clientDisplayName: "dodok-spike-3",
        clientVersion: "0.0.0",
        instanceId: "dodok-spike-3",
        role: "operator",
        scopes: OBSERVER_SCOPES,
        caps: [],
        onEvent: (frame: EventFrame) => {
          gatewayEvents.push({
            at: Date.now(),
            event: frame.event,
            payload: maskValue(frame.payload as Json),
          });
        },
      });
      const hello = conn.hello as unknown as { auth?: Json; server?: Json };
      const subscriptions: Json[] = [];
      subscriptions.push(
        await conn.request("sessions.subscribe", {}, { timeoutMs: 15_000 }).catch(describeError),
      );
      for (const key of [BASE_KEY, TOOL_KEY, ...extraKeys]) {
        subscriptions.push({
          key,
          result: await conn
            .request("sessions.messages.subscribe", { agentId: AGENT, key }, { timeoutMs: 15_000 })
            .catch(describeError),
        });
      }
      observer = conn;
      observations.observer.push({
        reason,
        connected: true,
        afterMs: Date.now() - t0,
        attempts,
        scopesRequested: OBSERVER_SCOPES,
        helloAuth: maskValue(hello.auth),
        server: maskValue(hello.server),
        subscriptions: maskValue(subscriptions),
      });
      console.log(`Gateway 관찰 연결(${reason}) — hello.auth ${JSON.stringify(maskValue(hello.auth))}`);
      return;
    } catch (error) {
      attempts.push({ attempt, at: Date.now() - t0, error: describeError(error) });
      if (!(error instanceof GatewayPairingRequiredError) && attempt >= 5) break;
      await sleep(3_000);
    }
  }
  observations.observer.push({ reason, connected: false, attempts, scopesRequested: OBSERVER_SCOPES });
  console.log(`Gateway 관찰 연결 실패(${reason}): ${JSON.stringify(attempts.at(-1))}`);
}

async function observerRequest(method: string, params: Json, timeoutMs = 30_000): Promise<Json> {
  if (!observer) return { error: "observer not connected" };
  try {
    return maskValue(await observer.request(method, params, { timeoutMs }), undefined, 6000);
  } catch (error) {
    return { error: describeError(error) };
  }
}

/** 원문이 다음 호출의 입력이 되는 경우(커서 등) — 관찰에는 masked 만 남긴다 */
async function observerRequestRaw(
  method: string,
  params: Json,
  timeoutMs = 30_000,
): Promise<{ raw?: Json; masked: Json }> {
  if (!observer) return { masked: { error: "observer not connected" } };
  try {
    const raw = await observer.request<Json>(method, params, { timeoutMs });
    return { raw, masked: maskValue(raw, undefined, 6000) };
  } catch (error) {
    return { masked: { error: describeError(error) } };
  }
}

// ── 턴 실행 ─────────────────────────────────────────────────────────────────────
function deliverFor(params: { channelId: string; sessionKey: string; text: string }): InboundDeliver {
  const now = new Date().toISOString();
  return {
    deliveryId: randomUUID(),
    kind: "message",
    channelId: params.channelId,
    conversationId: params.channelId,
    agentId: AGENT,
    sessionKey: params.sessionKey,
    runId: randomUUID(),
    message: {
      id: randomUUID(),
      author: { type: "user", handle: "jang", displayName: "장병현" },
      text: params.text,
      attachments: [],
      ts: now,
    },
    context: {
      recentMessages: [],
      participants: [
        { type: "user", handle: "jang", displayName: "장병현", isSelf: false },
        { type: "agent", handle: AGENT, displayName: AGENT, isSelf: true },
      ],
      relayRules: "다른 에이전트를 @멘션하면 그 에이전트가 이어받는다. 최대 4턴.",
    },
    options: {},
  };
}

async function runTurn(params: {
  name: string;
  description: string;
  sessionKey: string;
  setup: Json[];
  request: Json;
  /** 런을 시작한다. runId 가 있으면 런 1회로 센다 */
  start: () => Promise<{ runId?: string; response: Json }>;
  /** 플러그인 `dispatch-result` 줄에서 찾을 값(인바운드면 deliveryId) */
  dispatchMarker?: string;
}): Promise<TurnRecord> {
  const record: TurnRecord = {
    name: params.name,
    description: params.description,
    sessionKey: params.sessionKey,
    setup: params.setup,
    request: params.request,
    sentAt: new Date().toISOString(),
    abortedByTimeout: false,
    outbound: [],
    gatewayEvents: [],
    gatewayLog: [],
    verdict: {},
  };
  observations.turns.push(record);
  if (budgetLeft() <= 0) {
    record.finishedBy = "skipped";
    record.verdict["skipped"] = `누적 런 상한 ${MAX_RUNS} 도달`;
    console.log(`\n[${params.name}] 건너뜀 — 런 상한`);
    writeObservations();
    return record;
  }
  console.log(`\n[${params.name}] ${params.description}`);
  pumpLog();
  const t0 = Date.now();
  const outboundStart = outboundLog.length;
  const eventStart = gatewayEvents.length;
  const lineStart = gatewayLines.length;

  const started = await params.start();
  record.startResponse = maskValue(started.response);
  record.startAfterMs = Date.now() - t0;
  const runId = started.runId;
  if (runId) {
    record.runId = runId;
    recordRun(params.name, runId);
  }
  console.log(`  시작 ${record.startAfterMs}ms ${JSON.stringify(record.startResponse).slice(0, 300)}`);

  const isFinal = (e: GatewayEventRecord): "chat-final" | "session-end" | null => {
    const p = e.payload as { runId?: string; state?: string; phase?: string } | null;
    if (!runId || p?.runId !== runId) return null;
    if (e.event === "chat" && ["final", "error", "aborted"].includes(p?.state ?? "")) return "chat-final";
    if (e.event === "sessions.changed" && p?.phase === "end") return "session-end";
    return null;
  };
  const dispatchDone = (): boolean =>
    Boolean(params.dispatchMarker) &&
    gatewayLines
      .slice(lineStart)
      .some((l) => l.line.includes("dispatch-result") && l.line.includes(params.dispatchMarker ?? ""));

  const deadline = t0 + RUN_TIMEOUT_MS;
  for (;;) {
    pumpLog();
    const final = gatewayEvents.slice(eventStart).map(isFinal).find(Boolean);
    if (final) {
      record.finishedBy = final;
      break;
    }
    if (dispatchDone()) {
      record.finishedBy = runId ? "dispatch-result" : "no-run";
      break;
    }
    if (!runId && Date.now() - t0 > 5_000) {
      record.finishedBy = "no-run";
      break;
    }
    if (Date.now() > deadline) {
      record.finishedBy = "timeout";
      if (runId && observer) {
        record.abortedByTimeout = true;
        record.verdict["abort"] = await observerRequest("chat.abort", {
          sessionKey: params.sessionKey,
          agentId: AGENT,
          runId,
        });
      }
      break;
    }
    await sleep(500);
  }
  record.finishedAfterMs = Date.now() - t0;
  await sleep(4_000); // 최종 전달·툴 send 뒤따르는 outbound 를 잡는다
  pumpLog();
  record.outbound = outboundLog
    .slice(outboundStart)
    .map((o) => maskValue({ afterMs: o.at - t0, message: o.message }));
  record.gatewayEvents = gatewayEvents
    .slice(eventStart)
    .filter((e) => {
      const text = JSON.stringify(e.payload);
      return text.includes(params.sessionKey) || (runId ? text.includes(runId) : false);
    })
    .slice(0, 500)
    .map((e) => ({ ...e, at: e.at - t0 }));
  record.gatewayLog = gatewayLines
    .slice(lineStart)
    .map((l) => `+${l.at - t0}ms ${l.line}`)
    .slice(0, 400);
  console.log(
    `  종료 ${record.finishedBy} ${record.finishedAfterMs}ms, outbound ${record.outbound.length}건, 이벤트 ${record.gatewayEvents.length}건, 로그 ${record.gatewayLog.length}줄`,
  );
  writeObservations();
  return record;
}

async function inboundTurn(
  bridge: GatewayBridge,
  params: { name: string; description: string; setup: Json[]; deliver: InboundDeliver },
): Promise<TurnRecord> {
  const { deliver } = params;
  return runTurn({
    name: params.name,
    description: params.description,
    sessionKey: deliver.sessionKey,
    setup: params.setup,
    request: maskValue(deliver),
    dispatchMarker: deliver.deliveryId,
    start: async () => {
      const ack: Result<InboundDeliverResult> = await bridge.deliverInbound(deliver, RUN_TIMEOUT_MS);
      return { runId: ack.ok ? ack.data.providerRunId : undefined, response: ack };
    },
  });
}

// ── 판정 보조 ───────────────────────────────────────────────────────────────────
function textOfMessage(message: Json): string {
  const m = message as { content?: Json; text?: string } | null;
  if (!m) return "";
  if (typeof m.text === "string") return m.text;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content))
    return m.content
      .map((part) => {
        const p = part as { type?: string; text?: string };
        return typeof p.text === "string" ? p.text : "";
      })
      .join("");
  return "";
}

function repliesOf(record: TurnRecord): { outbound: string[]; chatFinal: string[] } {
  const outbound = record.outbound.map((o) => (o as { message: OutboundMessage }).message.text);
  const chatFinal = record.gatewayEvents
    .filter((e) => {
      const r = e as { event: string; payload: { runId?: string; state?: string } };
      return r.event === "chat" && r.payload?.runId === record.runId && r.payload?.state === "final";
    })
    .map((e) => textOfMessage((e as { payload: { message?: Json } }).payload.message));
  return { outbound, chatFinal };
}

function cliEvidence(record: TurnRecord): Record<string, Json> {
  const lines = record.gatewayLog;
  const pick = (re: RegExp): string[] => lines.filter((l) => re.test(l)).map((l) => l.slice(0, 1200));
  const argv = pick(/cli argv:/);
  return {
    exec: pick(/cli exec:/),
    argvSystemPromptFlags: argv.map(
      (l) => l.match(/--[\w-]*system-prompt[\w-]*(?:\s+<systemPrompt:\d+ chars>|\s+\S+)?/g) ?? [],
    ),
    liveSession: pick(/cli live session/),
    turn: pick(/cli turn:/),
    ingress: pick(/dodok[:\]]\s*ingress/),
  };
}

function sessionMessagesOf(record: TurnRecord): Json[] {
  return record.gatewayEvents
    .filter((e) => (e as { event: string }).event === "session.message")
    .map((e) => {
      const p = (e as { payload: Record<string, Json> }).payload;
      const message = (p["message"] ?? {}) as Record<string, Json>;
      return {
        payloadKeys: Object.keys(p),
        messageKeys: Object.keys(message),
        role: message["role"],
        messageSeq: p["messageSeq"],
        systemishFields: Object.fromEntries(
          Object.entries({ ...p, ...message }).filter(([k]) => /system|prompt|drift|context/i.test(k)),
        ),
        text: textOfMessage(message).slice(0, 1500),
      };
    });
}

function promptVerdict(record: TurnRecord, expected: string): Record<string, Json> {
  const replies = repliesOf(record);
  const all = [...replies.outbound, ...replies.chatFinal].join("\n");
  return {
    expected,
    reflected: new RegExp(`\\b${expected}\\b`, "i").test(all),
    wordsSeen: ALL_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(all)),
    replies,
    cli: cliEvidence(record),
    sessionMessages: sessionMessagesOf(record),
  };
}

async function setSystemPrompt(bridge: GatewayBridge, channelId: string, prompt: string): Promise<Json> {
  const t0 = Date.now();
  const result = await bridge.setConfig({ channelId, config: { systemPrompt: prompt } }, 30_000);
  const afterMs = Date.now() - t0;
  console.log(`  config.set systemPrompt(${prompt.length}자) → ${JSON.stringify(result)} ${afterMs}ms`);
  await sleep(1_500);
  return { bridgeConfigSet: { channelId, systemPromptChars: prompt.length, prompt }, result, afterMs };
}

async function resetSession(key: string): Promise<Json> {
  const ws = await observerRequest("sessions.reset", { key, agentId: AGENT, reason: "reset" });
  const wsError = (ws as { error?: Json }).error;
  if (!wsError) return { via: "ws", response: ws };
  // admin 스코프가 없으면 dev Gateway CLI 로 대체 (로컬 CLI 는 공유 토큰으로 붙는다)
  const viaCli = cli([
    "gateway",
    "call",
    "sessions.reset",
    "--url",
    DEV_GATEWAY_URL,
    "--params",
    JSON.stringify({ key, agentId: AGENT, reason: "reset" }),
    "--json",
  ]);
  return { via: "cli", wsError, cli: viaCli.record };
}

async function reopenPluginConnection(bridge: GatewayBridge): Promise<Json> {
  const t0 = Date.now();
  const closed = await waitFor(() => bridge.current() === undefined, 30_000);
  const session = await bridge.waitForReady(HELLO_TIMEOUT_MS);
  const record = {
    oldSessionClosed: closed,
    helloAfterMs: Date.now() - t0,
    connectionId: session.connectionId,
  };
  observations.hello.push({ reason: "after-restart", ...record, hello: maskValue(session.hello) });
  return record;
}

// ── 시나리오 ────────────────────────────────────────────────────────────────────
async function runSetup(): Promise<void> {
  const setup: Record<string, Json> = {};
  const running = listeningPids();
  if (running.length > 0)
    setup["stopBeforeInstall"] = await stopDevGateway("setup: 플러그인 코드는 재시작 때 바뀐다");
  setup["bundleSha256"] = sha256File(join(PLUGIN_DIST, "index.js"));
  setup["tgzSha256"] = sha256File(PLUGIN_TGZ);
  setup["install"] = cli(["plugins", "install", PLUGIN_TGZ, "--force", "--accept-capabilities"]).record;
  setup["installedBundleSha256"] = sha256File(join(OPENCLAW_DEV_STATE, "extensions/dodok/dist/index.js"));
  setup["installedMatchesBuild"] = setup["installedBundleSha256"] === setup["bundleSha256"];
  const inspect = cli(["plugins", "inspect", "dodok", "--json"]);
  let summary: Json = null;
  try {
    const parsed = JSON.parse(inspect.stdout.slice(inspect.stdout.indexOf("{"))) as Record<string, Json>;
    const plugin = (parsed["plugin"] ?? parsed) as Record<string, Json>;
    summary = maskValue({
      status: plugin["status"],
      version: plugin["version"],
      channelIds: plugin["channelIds"],
      activationReason: plugin["activationReason"],
      trust: parsed["trust"] ?? plugin["trust"],
      topKeys: Object.keys(parsed),
    });
  } catch (error) {
    summary = { parseError: String(error) };
  }
  setup["inspect"] = { ...inspect.record, summary };
  setup["unsetChannels"] = cli(["config", "unset", "channels.dodok.channels"]).record;
  // 매니페스트 채널 항목 스키마가 strict 인지 모르는 키 거부로 확인한다
  setup["rejectUnknownKey"] = cli([
    "config",
    "set",
    `channels.dodok.channels.${CHANNEL_ID}.bogusKey`,
    "true",
    "--strict-json",
  ]).record;
  setup["cleanup"] = cli(["config", "unset", "channels.dodok.channels"]).record;
  observations.setup = setup;
  writeObservations();
}

async function main(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  if (SCENARIOS.has("SETUP")) await runSetup();

  const app = Fastify({ logger: false });
  const io = new Server(app.server, { transports: ["websocket"] });
  const bridgeServer = attachBridge(io, {
    verifyToken: (presented) =>
      verifyBridgeToken(BRIDGE_TOKEN, presented) ? { tokenId: "spike", gatewayId: "spike" } : null,
    acceptGateway: () => true,
    serverVersion: "spike-3",
    ackTimeoutMs: 15_000,
    onHello: (session, hello) => {
      observations.hello.push({ connectionId: session.connectionId, hello: maskValue(hello) });
    },
    onOutboundMessage: async (_session, message) => {
      outboundLog.push({ at: Date.now(), message });
      const summary = message.components
        ? `components ${message.components.blocks.length} blocks`
        : `text (${message.outboundId.split("-").slice(0, 2).join("-")})`;
      console.log(`  ← outbound.message [${message.agentId}] ${summary}: ${message.text.slice(0, 120)}`);
      return { messageId: randomUUID() };
    },
    onClose: (session) =>
      observations.bridgeSideEvents.push({
        at: new Date().toISOString(),
        event: "close",
        connectionId: session.connectionId,
        reason: session.closeReason,
      }),
    onRejected: (reason) =>
      observations.bridgeSideEvents.push({ at: new Date().toISOString(), event: "rejected", reason }),
  });
  // 스파이크는 Gateway 하나 — 브리지 자리도 하나만 쓴다
  const bridge = bridgeServer.forGateway("spike");
  await app.listen({ host: BRIDGE_URL.hostname, port: Number(BRIDGE_URL.port) });
  console.log(`브리지 서버 ${BRIDGE_URL.hostname}:${BRIDGE_URL.port} 네임스페이스 /bridge`);

  try {
    if (listeningPids().length === 0) observations.gatewayLifecycle.push(await startDevGateway("initial"));
    else observations.gatewayLifecycle.push({ event: "already-running", pids: listeningPids() });
    const t0 = Date.now();
    const session = await bridge.waitForReady(HELLO_TIMEOUT_MS);
    console.log(`플러그인 hello (${Date.now() - t0}ms): ${JSON.stringify(session.hello)}`);
    await connectObserver("initial");
    writeObservations();

    // 질문 1 ─ P0: 기존 세션 만들기 (채널 프롬프트 없음)
    if (SCENARIOS.has("P0") && budgetLeft() >= 1) {
      const p0 = await inboundTurn(bridge, {
        name: "P0",
        description: "기존 세션 만들기 — 채널 프롬프트 없이 READY",
        setup: [],
        deliver: deliverFor({
          channelId: CHANNEL_ID,
          sessionKey: BASE_KEY,
          text: `@${AGENT} Reply with exactly: READY`,
        }),
      });
      p0.verdict = { ...promptVerdict(p0, "READY") };
    }

    if (SCENARIOS.has("P1") && budgetLeft() >= 1) {
      const setup = [await setSystemPrompt(bridge, CHANNEL_ID, codePrompt(WORDS.P1))];
      const p1 = await inboundTurn(bridge, {
        name: "P1",
        description: `config.set(${WORDS.P1}) 뒤 그대로 다음 턴`,
        setup,
        deliver: deliverFor({ channelId: CHANNEL_ID, sessionKey: BASE_KEY, text: ASK }),
      });
      p1.verdict = promptVerdict(p1, WORDS.P1);
    }

    if (SCENARIOS.has("P2") && budgetLeft() >= 1) {
      const setup = [{ sessionsReset: await resetSession(BASE_KEY) }];
      await sleep(1_500);
      const p2 = await inboundTurn(bridge, {
        name: "P2",
        description: `sessions.reset 뒤 같은 질문 (systemPrompt=${WORDS.P1})`,
        setup,
        deliver: deliverFor({ channelId: CHANNEL_ID, sessionKey: BASE_KEY, text: ASK }),
      });
      p2.verdict = promptVerdict(p2, WORDS.P1);
    }

    if (SCENARIOS.has("P3") && budgetLeft() >= 1) {
      const setup: Json[] = [await setSystemPrompt(bridge, CHANNEL_ID, codePrompt(WORDS.P3))];
      const stop = await stopDevGateway("P3");
      const start = await startDevGateway("P3");
      observations.gatewayLifecycle.push(stop, start);
      setup.push({ restart: { stop, start }, plugin: await reopenPluginConnection(bridge) });
      await connectObserver("after-restart");
      const p3 = await inboundTurn(bridge, {
        name: "P3",
        description: `config.set(${WORDS.P3}) + dev Gateway 재시작 뒤 같은 질문`,
        setup,
        deliver: deliverFor({ channelId: CHANNEL_ID, sessionKey: BASE_KEY, text: ASK }),
      });
      p3.verdict = promptVerdict(p3, WORDS.P3);
    }

    // 질문 2 ─ ToolInputError
    const reserveForW = SCENARIOS.has("W") ? 2 : 0;
    if (SCENARIOS.has("T") && budgetLeft() - reserveForW >= 1) {
      const prompts = [
        `@${AGENT} Send me a message with SIX buttons in one action row using the components field.`,
        `@${AGENT} I am testing validation. Call the message tool now (action "send", target "channel:${TOOL_CHANNEL_ID}") with a components object whose single actions block holds exactly SIX buttons (ids b1 to b6). Do not reduce the count before the first call.`,
      ];
      for (const [index, text] of prompts.entries()) {
        if (index > 0 && budgetLeft() - reserveForW < 1) break;
        const t = await inboundTurn(bridge, {
          name: `T${index + 1}`,
          description: index === 0 ? "버튼 6개 요청(브리프 문구)" : "버튼 6개 요청(명시 문구로 재시도)",
          setup: [],
          deliver: deliverFor({ channelId: TOOL_CHANNEL_ID, sessionKey: TOOL_KEY, text }),
        });
        const toolEvents = t.gatewayEvents
          .filter((e) => {
            const r = e as { event: string; payload: { stream?: string } };
            return r.event === "agent" && r.payload?.stream === "tool";
          })
          .map((e) => (e as { payload: Json }).payload);
        const pluginToolSends = t.gatewayLog.filter((l) => l.includes("tool-send"));
        t.verdict = {
          toolEvents,
          pluginToolSends,
          outboundComponents: t.outbound.map((o) => {
            const m = (o as { message: OutboundMessage }).message;
            return {
              text: m.text.slice(0, 300),
              blocks: m.components?.blocks.map((b) => ({
                type: b.type,
                items: "items" in b ? (b.items as unknown[]).length : undefined,
              })),
            };
          }),
          replies: repliesOf(t),
          invalidToolSendSeen: pluginToolSends.some((l) => l.includes('"ok":false')),
        };
        if (t.verdict["invalidToolSendSeen"]) break;
      }
    }

    // 질문 2 보강 ─ 모델 없이 message 툴 직접 호출(tools.invoke): ToolInputError 가 원문으로 돌아오는가 (런 없음)
    if (SCENARIOS.has("TI") && observer) {
      const button = (i: number) => ({ type: "button", id: `b${i}`, label: `B${i}` });
      const lineStart = gatewayLines.length;
      const outboundStart = outboundLog.length;
      const invoke = await observerRequest("tools.invoke", {
        name: "message",
        sessionKey: TOOL_KEY,
        agentId: AGENT,
        args: {
          action: "send",
          channel: "dodok",
          to: `channel:${TOOL_CHANNEL_ID}`,
          message: "six buttons",
          components: { blocks: [{ type: "actions", items: [0, 1, 2, 3, 4, 5].map(button) }] },
        },
        idempotencyKey: randomUUID(),
      });
      await sleep(1_500);
      pumpLog();
      observations.turns.push({
        name: "TI",
        description: "tools.invoke message 버튼 6개 (모델 런 없음)",
        sessionKey: TOOL_KEY,
        setup: [],
        request: { tool: "message", buttons: 6 },
        sentAt: new Date().toISOString(),
        startResponse: invoke,
        finishedBy: "no-run",
        abortedByTimeout: false,
        outbound: outboundLog.slice(outboundStart).map((o) => maskValue(o.message)),
        gatewayEvents: [],
        gatewayLog: gatewayLines.slice(lineStart).map((l) => l.line),
        verdict: { response: invoke },
      });
      console.log(`\n[TI] tools.invoke → ${JSON.stringify(invoke).slice(0, 400)}`);
      writeObservations();
    }

    // 질문 4 ─ chat.send + originating*
    if (SCENARIOS.has("W") && observer) {
      const cases = [
        {
          name: "W1",
          description: 'chat.send + originatingChannel "dodok" + originatingTo + deliver:true',
          text: `@${AGENT} Reply with exactly: VIA-WS`,
          extra: {
            originatingChannel: "dodok",
            originatingTo: `channel:${CHANNEL_ID}`,
            originatingAccountId: "default",
            deliver: true,
          },
        },
        {
          name: "W2",
          description: "chat.send, originating* 없이 deliver:true (세션 배달 문맥 상속)",
          text: `@${AGENT} Reply with exactly: VIA-WS-2`,
          extra: { deliver: true },
        },
      ];
      for (const testCase of cases) {
        if (budgetLeft() < 1) break;
        const params = {
          sessionKey: BASE_KEY,
          agentId: AGENT,
          message: testCase.text,
          idempotencyKey: randomUUID(),
          ...testCase.extra,
        };
        const w = await runTurn({
          name: testCase.name,
          description: testCase.description,
          sessionKey: BASE_KEY,
          setup: [],
          request: params,
          start: async () => {
            if (!observer) return { response: { error: "observer not connected" } };
            try {
              const response = (await observer.request("chat.send", params, { timeoutMs: 30_000 })) as {
                runId?: string;
              };
              return { runId: response.runId, response };
            } catch (error) {
              return { response: { error: describeError(error) } };
            }
          },
        });
        w.verdict = {
          replies: repliesOf(w),
          outboundDetail: w.outbound.map((o) => {
            const m = (o as { message: OutboundMessage }).message;
            return {
              outboundId: m.outboundId,
              agentId: m.agentId,
              sessionKey: m.sessionKey,
              runId: m.runId,
              text: m.text,
            };
          }),
          pluginLines: w.gatewayLog.filter((l) => /dodok/i.test(l)),
          cli: cliEvidence(w),
        };
      }
    }

    // 질문 3 ─ chat.history 커서 (런 없음)
    // 커서는 base64 모양이라 maskValue 가 가린다 — 다음 호출에는 반드시 원문(raw)을 넘긴다(1차 실행의 결함)
    if (SCENARIOS.has("H") && observer) {
      const history: Record<string, Json> = {};
      history["sessionsList"] = await observerRequest("sessions.list", {
        agentId: AGENT,
        search: "dodok",
        limit: 20,
      });
      const cursorOf = (raw: Json): string | undefined => {
        const value = (raw as { deltaCursor?: unknown } | null)?.deltaCursor;
        return typeof value === "string" ? value : undefined;
      };
      const summarize = (res: { raw?: Json; masked: Json }): Json => {
        const raw = res.raw as Record<string, Json> | undefined;
        if (!raw) return res.masked;
        const messages = Array.isArray(raw["messages"]) ? raw["messages"] : [];
        return {
          topKeys: Object.keys(raw),
          kind: raw["kind"] ?? null,
          deltaCursorChars: cursorOf(raw)?.length ?? null,
          messageCount: Array.isArray(raw["messages"]) ? messages.length : null,
          messages: messages.map((m) => {
            const message = m as Record<string, Json>;
            const meta = (message["__openclaw"] ?? {}) as Record<string, Json>;
            return {
              role: message["role"],
              keys: Object.keys(message),
              openclawKeys: Object.keys(meta),
              seq: meta["seq"] ?? null,
              importedFrom: meta["importedFrom"] ?? null,
              text: textOfMessage(message).slice(0, 160),
            };
          }),
          masked: res.masked,
        };
      };
      for (const [label, key] of [
        ["base", BASE_KEY],
        ["tool", TOOL_KEY],
      ] as const) {
        const first = await observerRequestRaw("chat.history", { sessionKey: key, agentId: AGENT, limit: 3 });
        const cursor = cursorOf(first.raw);
        const entry: Record<string, Json> = { first: summarize(first) };
        if (cursor)
          entry["sameCursor"] = summarize(
            await observerRequestRaw("chat.history", { sessionKey: key, agentId: AGENT, cursor }),
          );
        entry["bogusCursor"] = summarize(
          await observerRequestRaw("chat.history", {
            sessionKey: key,
            agentId: AGENT,
            cursor: "spike-3-bogus-cursor",
          }),
        );
        history[label] = entry;
      }
      // claude-cli 바인딩이 없는 세션: tool 세션을 리셋하고, 모델 런 없이 chat.inject 로 한 줄씩 더하며 커서 증분을 본다
      const probe: Record<string, Json> = { reset: await resetSession(TOOL_KEY) };
      const c0Res = await observerRequestRaw("chat.history", {
        sessionKey: TOOL_KEY,
        agentId: AGENT,
        limit: 3,
      });
      probe["h0"] = summarize(c0Res);
      const c0 = cursorOf(c0Res.raw);
      if (c0) {
        const same = await observerRequestRaw("chat.history", {
          sessionKey: TOOL_KEY,
          agentId: AGENT,
          cursor: c0,
        });
        probe["c0BeforeInject"] = {
          ...(summarize(same) as object),
          sameCursorReturned: cursorOf(same.raw) === c0,
        };
        probe["inject1"] = await observerRequest("chat.inject", {
          sessionKey: TOOL_KEY,
          agentId: AGENT,
          message: "spike-3 delta probe 1 (injected, no model run)",
          label: "spike-3",
        });
        const d1 = await observerRequestRaw("chat.history", {
          sessionKey: TOOL_KEY,
          agentId: AGENT,
          cursor: c0,
        });
        const c1 = cursorOf(d1.raw);
        probe["c0AfterInject1"] = { ...(summarize(d1) as object), cursorAdvanced: Boolean(c1) && c1 !== c0 };
        probe["inject2"] = await observerRequest("chat.inject", {
          sessionKey: TOOL_KEY,
          agentId: AGENT,
          message: "spike-3 delta probe 2 (injected, no model run)",
          label: "spike-3",
        });
        if (c1)
          probe["c1AfterInject2"] = summarize(
            await observerRequestRaw("chat.history", { sessionKey: TOOL_KEY, agentId: AGENT, cursor: c1 }),
          );
        // 옛 커서(c0)를 다시 쓰면 두 줄이 한꺼번에 오는가
        probe["c0AfterInject2"] = summarize(
          await observerRequestRaw("chat.history", { sessionKey: TOOL_KEY, agentId: AGENT, cursor: c0 }),
        );
        // 커서를 조금 망가뜨리면
        probe["c0Tampered"] = summarize(
          await observerRequestRaw("chat.history", {
            sessionKey: TOOL_KEY,
            agentId: AGENT,
            cursor: `${c0.slice(0, -4)}AAAA`,
          }),
        );
        // limit 과 함께 주면 (스키마는 허용, offset/messageId 만 금지)
        probe["c0WithLimit"] = summarize(
          await observerRequestRaw("chat.history", {
            sessionKey: TOOL_KEY,
            agentId: AGENT,
            cursor: c0,
            limit: 1,
          }),
        );
      }
      probe["afterNoCursor"] = summarize(
        await observerRequestRaw("chat.history", { sessionKey: TOOL_KEY, agentId: AGENT, limit: 5 }),
      );
      history["toolAfterReset"] = probe;
      observations.history = history;
      writeObservations();
    }
  } catch (error) {
    observations.errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    console.error(error);
  } finally {
    pumpLog();
    observations.finishedAt = new Date().toISOString();
    observations.ledgerAtEnd = readLedger().runs.length;
    writeObservations();
    console.log(`\n누적 모델 런 ${observations.ledgerAtEnd}/${MAX_RUNS}. 관찰 기록: ${OBSERVATIONS_PATH}`);
    if (observer) await observer.stop().catch(() => undefined);
    bridgeServer.close();
    io.close();
    await app.close();
    if (STOP_GATEWAY) {
      observations.gatewayLifecycle.push(await stopDevGateway("end"));
      writeObservations();
    }
  }
}

await main();

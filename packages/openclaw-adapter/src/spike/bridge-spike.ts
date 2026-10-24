/**
 * Phase 0 스파이크 2 — 채널 플러그인 실측 러너.
 *
 * 브리지 서버(`../bridge/server`)를 띄우고, dev Gateway 안의 dodok 플러그인이 `hello` 로 붙기를 기다린 뒤
 * 시나리오 A(평문 응답)·B(components)·C(에이전트 작성자 릴레이·봇 루프 보호)·D(config.set → systemPrompt)를 돈다.
 * 관찰(브리지 ack·outbound·Gateway WS 이벤트·플러그인 로그 줄)은 마스킹해 `data/spike-2-observations.json` 에,
 * 콘솔에는 요약만 낸다.
 *
 * 환경(.env): OPENCLAW_DEV_GATEWAY_URL, OPENCLAW_DEV_GATEWAY_TOKEN, BRIDGE_URL, BRIDGE_TOKEN.
 * 원격 Gateway 변수(OPENCLAW_GATEWAY_*)는 읽지 않는다.
 *
 * 실행: `DODOK_SPIKE_MAX_RUNS=8 pnpm -F @dodok/openclaw-adapter spike:bridge`
 *   DODOK_SPIKE_MAX_RUNS  모델 런 상한(기본 0 — hello 만 확인)
 *   DODOK_SPIKE_SCENARIOS 쉼표 목록(기본 A,B,C,D)
 *   DODOK_SPIKE_AGENT     첫 번째 에이전트 id(기본 dev), DODOK_SPIKE_AGENT2 두 번째(기본 fin)
 *
 * 이 파일은 스파이크용이라 테스트하지 않는다.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
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
import { connectGateway, type GatewayConnection } from "../gateway/client";

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
const OBSERVATIONS_PATH = join(REPO_ROOT, "data/spike-2-observations.json");
const GATEWAY_LOG_PATH = join(REPO_ROOT, "data/dev-gateway.log");
const DEV_IDENTITY_PATH = join(REPO_ROOT, "data/openclaw-dev-device.json");
const OPENCLAW_NODE_BIN =
  process.env["OPENCLAW_DEV_NODE_BIN"] ??
  "/Applications/OpenClaw.app/Contents/Resources/node-worker/arm64/bin";

const CHANNEL_ID = process.env["DODOK_SPIKE_CHANNEL_ID"] ?? "0199a6c0-0000-7000-8000-000000000c01";
const AGENT_1 = process.env["DODOK_SPIKE_AGENT"] ?? "dev";
const AGENT_2 = process.env["DODOK_SPIKE_AGENT2"] ?? "fin";
const MAX_RUNS = Number(process.env["DODOK_SPIKE_MAX_RUNS"] ?? "0");
const SCENARIOS = new Set(
  (process.env["DODOK_SPIKE_SCENARIOS"] ?? "A,B,C,D").split(",").map((s) => s.trim()),
);
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
const SECRETS = [DEV_GATEWAY_TOKEN, BRIDGE_TOKEN];

const SECRET_KEYS = new Set(["token", "deviceToken", "signature", "publicKey", "nonce", "password"]);
const BASE64ISH = /^[A-Za-z0-9+/_-]{40,}={0,2}$/;

function scrub(text: string): string {
  let out = text;
  for (const secret of SECRETS) out = out.split(secret).join(`<masked:${secret.length}>`);
  return out;
}

function maskValue(value: Json, keyHint?: string): Json {
  if (typeof value === "string") {
    if (keyHint && SECRET_KEYS.has(keyHint)) return `<masked:${value.length}>`;
    if (BASE64ISH.test(value)) return `<masked:${value.length}>`;
    const scrubbed = scrub(value);
    return scrubbed.length > 2000 ? `${scrubbed.slice(0, 2000)}…<truncated:${scrubbed.length}>` : scrubbed;
  }
  if (Array.isArray(value)) return value.map((entry) => maskValue(entry));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, Json> = {};
    for (const [key, entry] of Object.entries(value as Record<string, Json>))
      out[key] = maskValue(entry, key);
    return out;
  }
  return value;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

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
      .replace(/\[[0-9;]*m/g, "")
      .split("\n")
      .filter(Boolean);
  }
}

type OutboundRecord = { at: number; message: OutboundMessage };
type GatewayEventRecord = { at: number; event: string; payload: Json };

type ScenarioRecord = {
  name: string;
  description: string;
  expectRun: boolean;
  configChanges: Json[];
  inbound: Json;
  sentAt: string;
  ack?: Json;
  ackAfterMs?: number;
  runStarted: boolean;
  finishedBy?: "chat-final" | "dispatch-result" | "timeout" | "no-run";
  finishedAfterMs?: number;
  abortedByTimeout: boolean;
  outbound: Json[];
  gatewayEvents: GatewayEventRecord[];
  pluginLog: string[];
  verdict: Record<string, Json>;
};

type Observations = {
  startedAt: string;
  bridge: { listen: string; namespace: string };
  devGatewayUrl: string;
  channelId: string;
  agents: [string, string];
  maxRuns: number;
  runsUsed: number;
  hello?: Json;
  helloAfterMs?: number;
  helloAck?: Json;
  bridgeSideEvents: Json[];
  gatewayObserver: Json;
  scenarios: ScenarioRecord[];
  finishedAt?: string;
  errors: string[];
  toolInvoke?: Json;
};

const observations: Observations = {
  startedAt: new Date().toISOString(),
  bridge: { listen: `${BRIDGE_URL.hostname}:${BRIDGE_URL.port}`, namespace: BRIDGE_URL.pathname },
  devGatewayUrl: DEV_GATEWAY_URL,
  channelId: CHANNEL_ID,
  agents: [AGENT_1, AGENT_2],
  maxRuns: MAX_RUNS,
  runsUsed: 0,
  bridgeSideEvents: [],
  gatewayObserver: null,
  scenarios: [],
  errors: [],
};

function writeObservations(): void {
  mkdirSync(dirname(OBSERVATIONS_PATH), { recursive: true });
  writeFileSync(OBSERVATIONS_PATH, `${JSON.stringify(observations, null, 2)}\n`, "utf8");
}

const outboundLog: OutboundRecord[] = [];
const gatewayEvents: GatewayEventRecord[] = [];
const logTail = new LogTail(GATEWAY_LOG_PATH);
const pluginLines: { at: number; line: string }[] = [];

function pumpLog(): void {
  for (const line of logTail.read()) {
    if (/dodok/i.test(line)) pluginLines.push({ at: Date.now(), line: scrub(line).slice(0, 4000) });
  }
}

function devConfig(args: string[]): Json {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${OPENCLAW_NODE_BIN}:${process.env["PATH"] ?? ""}`,
  };
  delete childEnv["OPENCLAW_GATEWAY_URL"];
  childEnv["OPENCLAW_GATEWAY_TOKEN"] = DEV_GATEWAY_TOKEN;
  const res = spawnSync("openclaw", ["--dev", "config", ...args], { env: childEnv, encoding: "utf8" });
  const record = {
    args,
    status: res.status,
    stdout: scrub(res.stdout ?? "")
      .trim()
      .split("\n")
      .slice(-4),
    stderr: scrub(res.stderr ?? "")
      .trim()
      .split("\n")
      .slice(-4),
  };
  console.log(`  config ${args.join(" ")} → exit ${res.status}`);
  return record;
}

function baseDeliver(params: {
  agentId: string;
  author: InboundDeliver["message"]["author"];
  text: string;
  recent?: InboundDeliver["context"]["recentMessages"];
}): InboundDeliver {
  const now = new Date().toISOString();
  return {
    deliveryId: randomUUID(),
    kind: "message",
    channelId: CHANNEL_ID,
    conversationId: CHANNEL_ID,
    agentId: params.agentId,
    sessionKey: `agent:${params.agentId}:dodok:channel:${CHANNEL_ID}`,
    runId: randomUUID(),
    message: { id: randomUUID(), author: params.author, text: params.text, attachments: [], ts: now },
    context: {
      recentMessages: params.recent ?? [],
      participants: [
        { type: "user", handle: "jang", displayName: "장병현", isSelf: false },
        { type: "agent", handle: AGENT_1, displayName: AGENT_1, isSelf: params.agentId === AGENT_1 },
        { type: "agent", handle: AGENT_2, displayName: AGENT_2, isSelf: params.agentId === AGENT_2 },
      ],
      relayRules: "다른 에이전트를 @멘션하면 그 에이전트가 이어받는다. 최대 4턴.",
    },
    options: {},
  };
}

const HUMAN = { type: "user" as const, handle: "jang", displayName: "장병현" };

async function runScenario(params: {
  bridge: GatewayBridge;
  observer: GatewayConnection | null;
  name: string;
  description: string;
  deliver: InboundDeliver;
  expectRun: boolean;
  configChanges?: Json[];
}): Promise<ScenarioRecord> {
  const { bridge, observer, deliver } = params;
  const record: ScenarioRecord = {
    name: params.name,
    description: params.description,
    expectRun: params.expectRun,
    configChanges: params.configChanges ?? [],
    inbound: maskValue(deliver),
    sentAt: new Date().toISOString(),
    runStarted: false,
    abortedByTimeout: false,
    outbound: [],
    gatewayEvents: [],
    pluginLog: [],
    verdict: {},
  };
  observations.scenarios.push(record);
  if (observations.runsUsed >= MAX_RUNS) {
    record.finishedBy = "no-run";
    record.verdict["skipped"] = `런 상한 ${MAX_RUNS} 도달`;
    console.log(`\n[${params.name}] 건너뜀 — 런 상한`);
    return record;
  }
  console.log(`\n[${params.name}] ${params.description}`);
  const t0 = Date.now();
  const outboundStart = outboundLog.length;
  const eventStart = gatewayEvents.length;
  const lineStart = pluginLines.length;

  const ack: Result<InboundDeliverResult> = await bridge.deliverInbound(deliver, RUN_TIMEOUT_MS);
  record.ack = maskValue(ack);
  record.ackAfterMs = Date.now() - t0;
  const providerRunId = ack.ok ? ack.data.providerRunId : undefined;
  record.runStarted = Boolean(providerRunId);
  if (providerRunId) observations.runsUsed += 1;
  console.log(`  ack ${record.ackAfterMs}ms ${JSON.stringify(record.ack)}`);

  // 런을 띄운 연결이 아니면 `chat` 이벤트는 오지 않는다 — `sessions.changed` phase:end 가 종료 신호다
  const isFinal = (e: GatewayEventRecord): boolean => {
    const p = e.payload as { runId?: string; state?: string; phase?: string } | null;
    if (!providerRunId || p?.runId !== providerRunId) return false;
    return (
      (e.event === "chat" && ["final", "error", "aborted"].includes(p?.state ?? "")) ||
      (e.event === "sessions.changed" && p?.phase === "end")
    );
  };
  // Gateway 로거는 `dodok:<event>` 접두사를 `[dodok] <event>` 로 바꿔 찍는다
  const dispatchDone = (): boolean =>
    pluginLines
      .slice(lineStart)
      .some((l) => l.line.includes("dispatch-result") && l.line.includes(deliver.deliveryId));

  const deadline = t0 + RUN_TIMEOUT_MS;
  for (;;) {
    pumpLog();
    if (gatewayEvents.slice(eventStart).some(isFinal)) {
      record.finishedBy = "chat-final";
      break;
    }
    if (dispatchDone()) {
      record.finishedBy = providerRunId ? "dispatch-result" : "no-run";
      break;
    }
    if (!ack.ok && Date.now() - t0 > 5_000) {
      record.finishedBy = "no-run";
      break;
    }
    if (Date.now() > deadline) {
      record.finishedBy = "timeout";
      if (providerRunId && observer) {
        record.abortedByTimeout = true;
        try {
          await observer.request(
            "chat.abort",
            { sessionKey: deliver.sessionKey, agentId: deliver.agentId, runId: providerRunId },
            { timeoutMs: 15_000 },
          );
        } catch (error) {
          observations.errors.push(`${params.name} chat.abort: ${String(error)}`);
        }
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
    .filter(
      (e) =>
        JSON.stringify(e.payload).includes(deliver.sessionKey) ||
        JSON.stringify(e.payload).includes(deliver.runId),
    )
    .slice(0, 400)
    .map((e) => ({ ...e, at: e.at - t0 }));
  record.pluginLog = pluginLines
    .slice(lineStart)
    .map((l) => `+${l.at - t0}ms ${l.line}`)
    .slice(0, 300);
  console.log(
    `  종료 ${record.finishedBy} ${record.finishedAfterMs}ms, outbound ${record.outbound.length}건, 이벤트 ${record.gatewayEvents.length}건, 플러그인 로그 ${record.pluginLog.length}줄`,
  );
  writeObservations();
  return record;
}

function outboundsOf(record: ScenarioRecord): OutboundMessage[] {
  return record.outbound.map((o) => (o as { message: OutboundMessage }).message);
}

async function main(): Promise<void> {
  const app = Fastify({ logger: false });
  const io = new Server(app.server, { transports: ["websocket"] });
  const bridgeServer = attachBridge(io, {
    verifyToken: (presented) =>
      verifyBridgeToken(BRIDGE_TOKEN, presented) ? { tokenId: "spike", gatewayId: "spike" } : null,
    acceptGateway: () => true,
    serverVersion: "spike-2",
    ackTimeoutMs: 15_000,
    onHello: (session, hello) => {
      observations.hello = maskValue(hello);
      observations.helloAck = { connectionId: session.connectionId };
    },
    onOutboundMessage: async (_session, message) => {
      outboundLog.push({ at: Date.now(), message });
      const summary = message.components ? `components ${message.components.blocks.length} blocks` : "text";
      console.log(`  ← outbound.message [${message.agentId}] ${summary}: ${message.text.slice(0, 120)}`);
      return { messageId: randomUUID() };
    },
    onTyping: (_s, p) =>
      observations.bridgeSideEvents.push({ at: new Date().toISOString(), event: "outbound.typing", p }),
    onStatus: (_s, status) =>
      observations.bridgeSideEvents.push({ at: new Date().toISOString(), event: "status", status }),
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
  console.log(
    `브리지 서버 ${BRIDGE_URL.hostname}:${BRIDGE_URL.port} 네임스페이스 /bridge — 플러그인 hello 대기`,
  );

  let observer: GatewayConnection | null = null;
  try {
    const t0 = Date.now();
    const session = await bridge.waitForReady(HELLO_TIMEOUT_MS);
    observations.helloAfterMs = Date.now() - t0;
    console.log(`플러그인 hello: ${JSON.stringify(session.hello)}`);
    writeObservations();

    if (MAX_RUNS > 0) {
      try {
        observer = await connectGateway({
          url: DEV_GATEWAY_URL,
          token: DEV_GATEWAY_TOKEN,
          deviceIdentityPath: DEV_IDENTITY_PATH,
          clientDisplayName: "dodok-spike-2",
          clientVersion: "0.0.0",
          instanceId: "dodok-spike-2",
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          caps: [],
          onEvent: (frame: EventFrame) => {
            gatewayEvents.push({
              at: Date.now(),
              event: frame.event,
              payload: maskValue(frame.payload as Json),
            });
          },
        });
        const subscriptions: Json[] = [];
        subscriptions.push(await observer.request("sessions.subscribe", {}, { timeoutMs: 15_000 }));
        for (const agentId of [AGENT_1, AGENT_2]) {
          const key = `agent:${agentId}:dodok:channel:${CHANNEL_ID}`;
          try {
            subscriptions.push(
              await observer.request("sessions.messages.subscribe", { agentId, key }, { timeoutMs: 15_000 }),
            );
          } catch (error) {
            subscriptions.push({ key, error: String(error) });
          }
        }
        observations.gatewayObserver = { connected: true, subscriptions: maskValue(subscriptions) };
      } catch (error) {
        observations.gatewayObserver = { connected: false, error: String(error) };
        console.log(`Gateway 관찰 연결 실패(계속 진행): ${String(error)}`);
      }
    }

    let aReply = "PONG";
    if (SCENARIOS.has("A")) {
      const a = await runScenario({
        bridge,
        observer,
        name: "A",
        description: "사람 → 에이전트1 평문 응답",
        deliver: baseDeliver({
          agentId: AGENT_1,
          author: HUMAN,
          text: `@${AGENT_1} Reply with exactly: PONG`,
        }),
        expectRun: true,
      });
      const replies = outboundsOf(a);
      aReply = replies.at(-1)?.text ?? aReply;
      a.verdict = {
        outboundCount: replies.length,
        pong: replies.some((m) => m.text.includes("PONG")),
        runIdMatchesOurs: replies.every((m) => m.runId === (a.inbound as InboundDeliver).runId),
        providerRunIdEqualsRunId: replies.every((m) => m.providerRunId === m.runId),
      };
    }

    if (SCENARIOS.has("T") && observer) {
      // 모델 없이 message 툴을 직접 부른다 (Gateway tools.invoke) — handleAction·components 검증·실패 응답 모양
      const sessionKey = `agent:${AGENT_1}:dodok:channel:${CHANNEL_ID}`;
      const button = (i: number) => ({ type: "button", id: `b${i}`, label: `B${i}` });
      const cases: Array<{ name: string; args: Record<string, Json> }> = [
        {
          name: "T1 valid components",
          args: {
            action: "send",
            channel: "dodok",
            to: `channel:${CHANNEL_ID}`,
            message: "Pick one",
            components: { blocks: [{ type: "actions", items: [button(0)] }] },
          },
        },
        {
          name: "T2 six buttons (v1 위반)",
          args: {
            action: "send",
            channel: "dodok",
            to: `channel:${CHANNEL_ID}`,
            message: "too many",
            components: { blocks: [{ type: "actions", items: [0, 1, 2, 3, 4, 5].map(button) }] },
          },
        },
        { name: "T3 text only", args: { action: "send", channel: "dodok", message: "no target given" } },
      ];
      const results: Json[] = [];
      for (const testCase of cases) {
        const lineStart = pluginLines.length;
        const outboundStart = outboundLog.length;
        let response: Json;
        try {
          response = await observer.request(
            "tools.invoke",
            {
              name: "message",
              sessionKey,
              agentId: AGENT_1,
              args: testCase.args,
              idempotencyKey: randomUUID(),
            },
            { timeoutMs: 30_000 },
          );
        } catch (error) {
          response = { thrown: String(error) };
        }
        await sleep(1_500);
        pumpLog();
        results.push(
          maskValue({
            name: testCase.name,
            args: testCase.args,
            response,
            outbound: outboundLog.slice(outboundStart).map((o) => o.message),
            pluginLog: pluginLines.slice(lineStart).map((l) => l.line),
          }),
        );
        console.log(`\n[${testCase.name}] → ${JSON.stringify(maskValue(response)).slice(0, 300)}`);
      }
      observations.toolInvoke = results;
      writeObservations();
    }

    if (SCENARIOS.has("B")) {
      const prompts = [
        `@${AGENT_1} Send me a message with one button labeled OK using the components field.`,
        `@${AGENT_1} Use the message tool now with action "send", to "channel:${CHANNEL_ID}", message "Pick one", and a components object that has one actions block containing one button (type "button", id "ok", label "OK"). Do not answer in plain text.`,
      ];
      for (const [index, text] of prompts.entries()) {
        const b = await runScenario({
          bridge,
          observer,
          name: `B${index + 1}`,
          description:
            index === 0 ? "components 버튼 요청(브리프 문구)" : "components 버튼 요청(명시 문구로 재시도)",
          deliver: baseDeliver({ agentId: AGENT_1, author: HUMAN, text }),
          expectRun: true,
        });
        const withComponents = outboundsOf(b).filter((m) => m.components);
        b.verdict = {
          outboundCount: outboundsOf(b).length,
          withComponents: withComponents.length,
          components: maskValue(withComponents.map((m) => m.components)),
          toolSendLogged: b.pluginLog.some((l) => l.includes("dodok:tool-send")),
        };
        if (withComponents.length > 0) break;
      }
    }

    const budgetLeft = (): number => MAX_RUNS - observations.runsUsed;
    if (SCENARIOS.has("C") && budgetLeft() >= 2) {
      const recent = [
        {
          author: HUMAN,
          text: `@${AGENT_1} Reply with exactly: PONG`,
          ts: new Date(Date.now() - 60_000).toISOString(),
        },
        {
          author: { type: "agent" as const, handle: AGENT_1, displayName: AGENT_1 },
          text: aReply,
          ts: new Date().toISOString(),
        },
      ];
      const agentAuthor = { type: "agent" as const, handle: AGENT_1, displayName: AGENT_1 };
      const c1 = await runScenario({
        bridge,
        observer,
        name: "C1",
        description: "에이전트1 작성 → 에이전트2 멘션 릴레이 (봇 루프 보호 기본값)",
        deliver: baseDeliver({
          agentId: AGENT_2,
          author: agentAuthor,
          text: `@${AGENT_2} ${aReply} — I got PONG from the human. Reply with exactly: ACK`,
          recent,
        }),
        expectRun: true,
      });
      c1.verdict = { relayRan: c1.runStarted, replies: outboundsOf(c1).map((m) => m.text.slice(0, 200)) };

      const tight = { maxEventsPerWindow: 1, windowSeconds: 600, cooldownSeconds: 600 };
      const change2 = devConfig([
        "set",
        `channels.dodok.channels.${CHANNEL_ID}.botLoopProtection`,
        JSON.stringify(tight),
        "--strict-json",
      ]);
      await sleep(3_000);
      const c2 = await runScenario({
        bridge,
        observer,
        name: "C2",
        description: `같은 봇 쌍 두 번째 이벤트, 채널 botLoopProtection=${JSON.stringify(tight)}`,
        deliver: baseDeliver({
          agentId: AGENT_2,
          author: agentAuthor,
          text: `@${AGENT_2} Reply with exactly: ACK2`,
          recent,
        }),
        expectRun: false,
        configChanges: [change2],
      });
      c2.verdict = {
        suppressed: !c2.runStarted,
        dispatchResultLine: c2.pluginLog.find((l) => l.includes("dodok:dispatch-result")) ?? null,
      };

      const change3 = devConfig([
        "set",
        `channels.dodok.channels.${CHANNEL_ID}.botLoopProtection`,
        JSON.stringify({ enabled: false }),
        "--strict-json",
      ]);
      await sleep(3_000);
      const c3 = await runScenario({
        bridge,
        observer,
        name: "C3",
        description: "같은 봇 쌍, 채널 botLoopProtection.enabled=false (쿨다운 중)",
        deliver: baseDeliver({
          agentId: AGENT_2,
          author: agentAuthor,
          text: `@${AGENT_2} Reply with exactly: ACK3`,
          recent,
        }),
        expectRun: true,
        configChanges: [change3],
      });
      c3.verdict = {
        ranWithProtectionOff: c3.runStarted,
        replies: outboundsOf(c3).map((m) => m.text.slice(0, 200)),
      };
      devConfig(["unset", `channels.dodok.channels.${CHANNEL_ID}.botLoopProtection`]);
    }

    if (SCENARIOS.has("D") && budgetLeft() >= 1) {
      const prompt =
        "In this channel the secret code word is TANGERINE. When anyone asks for the code word, answer with exactly that word.";
      const t0d = Date.now();
      const setResult = await bridge.setConfig(
        { channelId: CHANNEL_ID, config: { systemPrompt: prompt } },
        30_000,
      );
      const setAfterMs = Date.now() - t0d;
      console.log(`\n[D] config.set → ${JSON.stringify(setResult)} (${setAfterMs}ms)`);
      await sleep(2_000);
      pumpLog();
      const d = await runScenario({
        bridge,
        observer,
        name: "D",
        description: "브리지 config.set(systemPrompt) 직후 같은 채널 런",
        deliver: baseDeliver({
          agentId: AGENT_1,
          author: HUMAN,
          text: `@${AGENT_1} What is the code word? Reply with only the word.`,
        }),
        expectRun: true,
        configChanges: [{ bridgeConfigSet: maskValue(setResult), afterMs: setAfterMs }],
      });
      d.verdict = {
        configSet: maskValue(setResult),
        reflected: outboundsOf(d).some((m) => /TANGERINE/i.test(m.text)),
        replies: outboundsOf(d).map((m) => m.text.slice(0, 200)),
      };
    }

    if (SCENARIOS.has("R") && observer && MAX_RUNS - observations.runsUsed >= 1) {
      // D 에서 기존(재개된) claude-cli 세션은 바뀐 systemPrompt 를 못 봤다 — sessions.reset 뒤에는 보이는가
      const key = `agent:${AGENT_1}:dodok:channel:${CHANNEL_ID}`;
      let reset: Json;
      try {
        reset = await observer.request(
          "sessions.reset",
          { key, agentId: AGENT_1, reason: "reset" },
          { timeoutMs: 30_000 },
        );
      } catch (error) {
        reset = { error: String(error) };
      }
      console.log(`\n[R] sessions.reset → ${JSON.stringify(maskValue(reset)).slice(0, 300)}`);
      const r = await runScenario({
        bridge,
        observer,
        name: "R",
        description: "sessions.reset 직후 같은 채널 런 (systemPrompt 는 D 에서 이미 설정됨)",
        deliver: baseDeliver({
          agentId: AGENT_1,
          author: HUMAN,
          text: `@${AGENT_1} What is the code word? Reply with only the word.`,
        }),
        expectRun: true,
        configChanges: [{ sessionsReset: maskValue(reset) }],
      });
      r.verdict = {
        reflected: outboundsOf(r).some((m) => /TANGERINE/i.test(m.text)),
        replies: outboundsOf(r).map((m) => m.text.slice(0, 200)),
      };
    }
  } catch (error) {
    observations.errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    console.error(error);
  } finally {
    pumpLog();
    observations.finishedAt = new Date().toISOString();
    writeObservations();
    console.log(`\n모델 런 ${observations.runsUsed}/${MAX_RUNS}. 관찰 기록: ${OBSERVATIONS_PATH}`);
    if (observer) await observer.stop().catch(() => undefined);
    bridgeServer.close();
    io.close();
    await app.close();
  }
}

await main();

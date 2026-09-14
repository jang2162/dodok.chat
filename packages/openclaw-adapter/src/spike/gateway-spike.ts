/**
 * Phase 0 스파이크 1 — 원격 Gateway WS API 실측.
 *
 * 계획서 3.1절이 가정한 것을 실제 Gateway 에 대고 확인한다: `hello-ok.features` 전체,
 * `chat.send` 요청·응답, `chat`/`agent`/`session.tool` 이벤트의 실물 모양.
 * 관찰은 마스킹해 `data/spike-1-observations.json` 에 남기고 콘솔에는 요약만 낸다.
 *
 * 이 파일은 스파이크용이라 테스트하지 않는다. 실행: `pnpm -F @dodok/openclaw-adapter spike:gateway`
 */
import type { EventFrame } from "@openclaw/gateway-protocol";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { connectGateway, GatewayConnection, GatewayPairingRequiredError } from "../gateway/client";

/** `.env` 와 `data/` 는 워크트리 루트에 있다 — 패키지 디렉터리에서 실행돼도 찾아 올라간다. */
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
const OBSERVATIONS_PATH = join(REPO_ROOT, "data/spike-1-observations.json");
const CLIENT_DISPLAY_NAME = "dodok-spike";
const REQUESTED_SCOPES = ["operator.read", "operator.write", "operator.approvals"];
const REQUESTED_CAPS = ["tool-events", "approvals", "session-scoped-events"];
const PAIRING_POLL_INTERVAL_MS = 20_000;
const PAIRING_DEADLINE_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 120_000;
const MAX_CHAT_SENDS = 3;

type Json = unknown;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 토큰·서명·긴 base64 류는 값이 아니라 길이만 남긴다. */
const SECRET_KEYS = new Set([
  "token",
  "deviceToken",
  "bootstrapToken",
  "password",
  "signature",
  "publicKey",
  "privateKeyPem",
  "publicKeyPem",
  "approvalRuntimeToken",
  "agentRuntimeIdentityToken",
  "nonce",
  "systemProvenanceReceipt",
]);
const BASE64ISH = /^[A-Za-z0-9+/_-]{40,}={0,2}$/;

function maskValue(value: Json, keyHint?: string): Json {
  if (typeof value === "string") {
    if (keyHint && SECRET_KEYS.has(keyHint)) return `<masked:${value.length}>`;
    if (BASE64ISH.test(value)) return `<masked:${value.length}>`;
    return value.length > 400 ? `${value.slice(0, 400)}…<truncated:${value.length}>` : value;
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

type ConnectAttempt = {
  at: string;
  attempt: number;
  detailCode?: string;
  errorName: string;
  message: string;
  pairing?: { deviceId?: string; reason?: string; requestId?: string };
};

type ChatRunRecord = {
  abortedByTimeout: boolean;
  events: { at: number; event: string; payload: Json }[];
  finishedAfterMs: number | null;
  params: Json;
  prompt: string;
  response: Json;
  run: number;
};

type Observations = {
  agentId: string;
  chatRuns: ChatRunRecord[];
  clientPackages: Record<string, string>;
  connectAttempts: ConnectAttempt[];
  deviceIdPrefix: string;
  eventsSeen: Record<string, number>;
  gatewayHost: string;
  helloOk: Json;
  pairing: { approvedAtIso?: string; required: boolean; requestId?: string } | null;
  requested: { caps: string[]; maxProtocol: number; minProtocol: number; role: string; scopes: string[] };
  sessionKey: string;
  sessionsMessagesSubscribe: Json;
  sessionsSubscribe: Json;
  startedAt: string;
  status: "blocked-on-pairing" | "connected" | "failed";
};

function writeObservations(observations: Observations): void {
  mkdirSync(dirname(OBSERVATIONS_PATH), { recursive: true });
  writeFileSync(OBSERVATIONS_PATH, `${JSON.stringify(observations, null, 2)}\n`, "utf8");
  console.log(`\n관찰 기록: ${OBSERVATIONS_PATH}`);
}

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 이 .env 에 없다`);
  return value;
}

function timestampSlug(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function printPairingInstruction(requestId: string | undefined): void {
  const target = requestId ?? "<requestId>";
  console.log(
    [
      "",
      "────────────────────────────────────────────────────────────────",
      " Gateway 가 이 디바이스의 페어링 승인을 요구한다. 사람이 해야 한다:",
      "",
      `   Gateway 호스트에서:  openclaw devices approve ${target}`,
      "   또는 Control UI → Devices 에서 해당 요청을 승인",
      "",
      " 승인하면 이 스크립트가 20초 간격으로 다시 붙는다(최대 10분).",
      "────────────────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
}

async function connectWithPairingWait(params: {
  identityPath: string;
  observations: Observations;
  token: string;
  url: string;
}): Promise<GatewayConnection | null> {
  const deadline = Date.now() + PAIRING_DEADLINE_MS;
  let attempt = 0;
  let instructionPrinted = false;

  for (;;) {
    attempt += 1;
    try {
      const connection = await connectGateway({
        caps: REQUESTED_CAPS,
        clientDisplayName: CLIENT_DISPLAY_NAME,
        clientVersion: "0.0.0",
        deviceIdentityPath: params.identityPath,
        instanceId: CLIENT_DISPLAY_NAME,
        role: "operator",
        scopes: REQUESTED_SCOPES,
        token: params.token,
        url: params.url,
      });
      if (attempt > 1 && params.observations.pairing) {
        params.observations.pairing.approvedAtIso = new Date().toISOString();
      }
      return connection;
    } catch (error) {
      const pairing = error instanceof GatewayPairingRequiredError ? error : null;
      const details = (error as { details?: { code?: string } }).details;
      const record: ConnectAttempt = {
        at: new Date().toISOString(),
        attempt,
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        ...(typeof details?.code === "string" ? { detailCode: details.code } : {}),
        ...(pairing
          ? {
              pairing: {
                ...(pairing.deviceId ? { deviceId: pairing.deviceId } : {}),
                ...(pairing.reason ? { reason: pairing.reason } : {}),
                ...(pairing.requestId ? { requestId: pairing.requestId } : {}),
              },
            }
          : {}),
      };
      params.observations.connectAttempts.push(record);
      console.log(
        `connect 시도 ${attempt} 실패: ${record.errorName} / ${record.detailCode ?? "(detail 없음)"} / ${record.message}`,
      );

      if (!pairing) throw error;

      params.observations.pairing = {
        required: true,
        ...(pairing.requestId ? { requestId: pairing.requestId } : {}),
      };
      if (!instructionPrinted) {
        printPairingInstruction(pairing.requestId);
        instructionPrinted = true;
      }
      if (Date.now() + PAIRING_POLL_INTERVAL_MS > deadline) {
        console.log("10분 안에 승인되지 않았다. 여기서 멈춘다.");
        return null;
      }
      await sleep(PAIRING_POLL_INTERVAL_MS);
    }
  }
}

async function runChatSend(params: {
  agentId: string;
  connection: GatewayConnection;
  observations: Observations;
  prompt: string;
  run: number;
  sessionKey: string;
}): Promise<void> {
  const { agentId, connection, observations, prompt, run, sessionKey } = params;
  const events: ChatRunRecord["events"] = [];
  const startedAt = Date.now();
  let finishedAfterMs: number | null = null;
  let seenRunId: string | undefined;
  let settleRun: () => void = () => undefined;
  const finished = new Promise<void>((done) => {
    settleRun = done;
  });

  const unsubscribe = connection.subscribe((frame: EventFrame) => {
    const name = (frame as { event?: string }).event ?? "(unnamed)";
    observations.eventsSeen[name] = (observations.eventsSeen[name] ?? 0) + 1;
    const payload = (frame as { payload?: unknown }).payload as Record<string, unknown> | undefined;
    const payloadSessionKey = payload?.sessionKey ?? payload?.key;
    const belongsToRun =
      payloadSessionKey === sessionKey || (seenRunId !== undefined && payload?.runId === seenRunId);
    if (!belongsToRun && name !== "tick" && name !== "presence" && name !== "health") {
      events.push({
        at: Date.now() - startedAt,
        event: `${name} (다른 세션/전역)`,
        payload: maskValue(payload),
      });
    }
    if (!belongsToRun) return;

    if (typeof payload?.runId === "string") seenRunId = payload.runId;
    events.push({ at: Date.now() - startedAt, event: name, payload: maskValue(payload) });

    if (
      name === "chat" &&
      (payload?.state === "final" || payload?.state === "error" || payload?.state === "aborted")
    ) {
      finishedAfterMs = Date.now() - startedAt;
      settleRun();
    }
  });

  const sendParams = {
    agentId,
    idempotencyKey: `dodok-spike-${sessionKey}-${run}`,
    message: prompt,
    sessionKey,
  };
  console.log(`\n[chat.send ${run}/${MAX_CHAT_SENDS}] ${prompt}`);
  let response: Json;
  try {
    response = await connection.request("chat.send", sendParams, { timeoutMs: 60_000 });
    console.log(`  응답: ${JSON.stringify(maskValue(response)).slice(0, 400)}`);
  } catch (error) {
    response = { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    console.log(`  chat.send 실패: ${JSON.stringify(response)}`);
  }
  if (typeof (response as { runId?: unknown } | undefined)?.runId === "string") {
    seenRunId = (response as { runId: string }).runId;
  }

  let abortedByTimeout = false;
  await Promise.race([finished, sleep(RUN_TIMEOUT_MS)]);
  if (finishedAfterMs === null) {
    abortedByTimeout = true;
    console.log("  120초 안에 final 이 오지 않았다 → chat.abort");
    try {
      const aborted = await connection.request("chat.abort", { agentId, sessionKey }, { timeoutMs: 15_000 });
      events.push({ at: Date.now() - startedAt, event: "(chat.abort 응답)", payload: maskValue(aborted) });
    } catch (error) {
      events.push({
        at: Date.now() - startedAt,
        event: "(chat.abort 실패)",
        payload: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }
  unsubscribe();

  observations.chatRuns.push({
    abortedByTimeout,
    events,
    finishedAfterMs,
    params: maskValue(sendParams),
    prompt,
    response: maskValue(response),
    run,
  });
  console.log(
    `  이벤트 ${events.length}개 수집, final ${finishedAfterMs === null ? "없음" : `${finishedAfterMs}ms`}`,
  );
}

async function main(): Promise<void> {
  process.loadEnvFile(join(REPO_ROOT, ".env"));
  const url = readEnv("OPENCLAW_GATEWAY_URL");
  const token = readEnv("OPENCLAW_GATEWAY_TOKEN");
  const identityPath = resolve(REPO_ROOT, readEnv("OPENCLAW_DEVICE_IDENTITY_PATH"));
  const agentId = process.env.DODOK_SPIKE_AGENT_ID ?? "main";
  const now = new Date();
  const sessionKey = `agent:${agentId}:dodok:spike:${timestampSlug(now)}`;

  const observations: Observations = {
    agentId,
    chatRuns: [],
    clientPackages: {
      "@openclaw/gateway-client": "2026.9.4",
      "@openclaw/gateway-protocol": "2026.9.4",
    },
    connectAttempts: [],
    deviceIdPrefix: "",
    eventsSeen: {},
    gatewayHost: new URL(url).host,
    helloOk: null,
    pairing: null,
    requested: {
      caps: REQUESTED_CAPS,
      maxProtocol: 4,
      minProtocol: 4,
      role: "operator",
      scopes: REQUESTED_SCOPES,
    },
    sessionKey,
    sessionsMessagesSubscribe: null,
    sessionsSubscribe: null,
    startedAt: now.toISOString(),
    status: "failed",
  };

  console.log(`Gateway: wss://${observations.gatewayHost} · agent ${agentId} · session ${sessionKey}`);

  let connection: GatewayConnection | null = null;
  try {
    connection = await connectWithPairingWait({ identityPath, observations, token, url });
  } catch (error) {
    observations.status = "failed";
    console.log(`연결 실패(페어링 외 사유): ${error instanceof Error ? error.message : String(error)}`);
    writeObservations(observations);
    process.exitCode = 1;
    return;
  }

  if (!connection) {
    observations.status = "blocked-on-pairing";
    writeObservations(observations);
    process.exitCode = 2;
    return;
  }

  observations.status = "connected";
  observations.deviceIdPrefix = `${connection.identity.deviceId.slice(0, 12)}…`;
  observations.helloOk = maskValue(connection.hello as unknown as Json);

  const hello = connection.hello;
  console.log(
    [
      "",
      `hello-ok: protocol=${hello.protocol} server.version=${hello.server.version} connId=<masked>`,
      `features.methods=${hello.features.methods.length}개 events=${hello.features.events.length}개 capabilities=${hello.features.capabilities?.length ?? 0}개`,
      `auth.role=${hello.auth.role} auth.method=${hello.auth.method ?? "(없음)"} auth.scopes=${hello.auth.scopes.join(",")}`,
      `auth.deviceTokens=${Array.isArray(hello.auth.deviceTokens) ? hello.auth.deviceTokens.length : 0}개`,
      `policy=${JSON.stringify(hello.policy)}`,
      `snapshot 최상위 키: ${Object.keys(hello.snapshot).join(", ")}`,
      `capabilities: ${(hello.features.capabilities ?? []).join(", ") || "(없음)"}`,
    ].join("\n"),
  );

  try {
    const subscribed = await connection.request("sessions.subscribe", {}, { timeoutMs: 30_000 });
    observations.sessionsSubscribe = maskValue(subscribed as Json);
    console.log(`sessions.subscribe 최상위 필드: ${Object.keys(subscribed as object).join(", ")}`);
  } catch (error) {
    observations.sessionsSubscribe = {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
    console.log(`sessions.subscribe 실패: ${JSON.stringify(observations.sessionsSubscribe)}`);
  }

  try {
    const subscribed = await connection.request(
      "sessions.messages.subscribe",
      { agentId, includeApprovals: true, key: sessionKey },
      { timeoutMs: 30_000 },
    );
    observations.sessionsMessagesSubscribe = maskValue(subscribed as Json);
    console.log(`sessions.messages.subscribe 최상위 필드: ${Object.keys(subscribed as object).join(", ")}`);
  } catch (error) {
    observations.sessionsMessagesSubscribe = {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
    console.log(
      `sessions.messages.subscribe 실패: ${JSON.stringify(observations.sessionsMessagesSubscribe)}`,
    );
  }

  // 실제 모델이 도는 호출이라 기본 2회. DODOK_SPIKE_MAX_RUNS=0 이면 연결·features 관찰만 한다.
  const prompts = [
    "Reply with exactly: PONG",
    "List the files in your workspace using your file tool, then reply DONE.",
  ];
  const maxRuns = Math.min(Number(process.env.DODOK_SPIKE_MAX_RUNS ?? prompts.length), MAX_CHAT_SENDS);
  for (const [index, prompt] of prompts.slice(0, Math.max(0, maxRuns)).entries()) {
    await runChatSend({ agentId, connection, observations, prompt, run: index + 1, sessionKey });
  }

  console.log(`\n관찰된 이벤트 이름: ${JSON.stringify(observations.eventsSeen)}`);
  writeObservations(observations);
  await connection.stop();
}

await main();

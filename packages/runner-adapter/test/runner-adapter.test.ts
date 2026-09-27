import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AdapterEvent,
  AdapterError,
  BridgeAuthGuard,
  dodokSessionKey,
  type InboundDeliver,
  type OutboundMessage,
  type ProviderApproval,
  type RunEventBody,
} from "@dodok/shared";
import { Server } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunnerAdapter, RUNNER_APPROVAL_TTL_MS, type RunnerAdapter } from "../src";
import { connectRunner, type FakeRunner, runnerAgent } from "./helpers/fake-runner-client";

const TOKEN_A = "drn_token-a";
const TOKEN_B = "drn_token-b";
const TOKENS: Record<string, { tokenId: string; label: string }> = {
  [TOKEN_A]: { tokenId: "7a0e2d3c-2d1f-4f5e-9a6b-000000000001", label: "laptop" },
  [TOKEN_B]: { tokenId: "7a0e2d3c-2d1f-4f5e-9a6b-000000000002", label: "desktop" },
};
const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const SESSION_ID = "5f0c8a52-3f7e-4c1b-8d2a-1b2c3d4e5f60";

type LogLine = { level: string; obj: object; msg?: string };

type Harness = {
  adapter: RunnerAdapter;
  url: string;
  events: AdapterEvent[];
  outbound: OutboundMessage[];
  logs: LogLine[];
  blocked: string[];
  runners: FakeRunner[];
  setNow(ms: number): void;
  failOutbound(on: boolean): void;
  runner(token: string, agents?: ReturnType<typeof runnerAgent>[]): Promise<FakeRunner>;
};

let current: { http: HttpServer; io: Server; adapter: RunnerAdapter; runners: FakeRunner[] } | undefined;

async function setup(opts: { fakeTimers?: boolean } = {}): Promise<Harness> {
  // 가짜 시계로 10분을 건너뛰어도 Socket.IO 하트비트가 끊지 않게 핑 간격을 늘린다
  if (opts.fakeTimers) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  const http = createServer();
  const io = new Server(http, { transports: ["websocket"], pingInterval: 3_600_000, pingTimeout: 3_600_000 });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const events: AdapterEvent[] = [];
  const outbound: OutboundMessage[] = [];
  const logs: LogLine[] = [];
  const blocked: string[] = [];
  const runners: FakeRunner[] = [];
  let nowMs = Date.parse("2026-09-27T00:00:00.000Z");
  let outboundFails = false;
  const log = (level: string) => (obj: object, msg?: string) => logs.push({ level, obj, msg });
  const adapter = createRunnerAdapter({
    io,
    verifyToken: (presented) => (typeof presented === "string" ? (TOKENS[presented] ?? null) : null),
    clientAddress: (socket) => socket.handshake.address,
    authGuard: new BridgeAuthGuard({ maxFailures: 3 }),
    onBlocked: (address) => blocked.push(address),
    now: () => nowMs,
    serverVersion: "test-server",
    logger: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
    channelName: (channelId) => (channelId === CH ? "general" : undefined),
    onOutbound: async (m) => {
      if (outboundFails) throw new Error("db is locked");
      outbound.push(m);
      return { messageId: randomUUID() };
    },
    tokenCount: () => 2,
  });
  adapter.onEvent((e) => events.push(e));
  await adapter.connect();
  current = { http, io, adapter, runners };
  return {
    adapter,
    url,
    events,
    outbound,
    logs,
    blocked,
    runners,
    setNow: (ms) => {
      nowMs = ms;
    },
    failOutbound: (on) => {
      outboundFails = on;
    },
    async runner(token, agents = [runnerAgent("coder")]) {
      const r = await connectRunner(url, token, agents);
      runners.push(r);
      return r;
    },
  };
}

afterEach(async () => {
  if (current) {
    for (const r of current.runners) r.close();
    await current.adapter.close();
    current.io.close();
    await new Promise<void>((resolve) => current?.http.close(() => resolve()));
    current = undefined;
  }
  vi.useRealTimers();
});

async function until(check: () => boolean, label = "condition"): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function waitDisconnect(r: FakeRunner): Promise<void> {
  return r.socket.disconnected
    ? Promise.resolve()
    : new Promise((resolve) => r.socket.once("disconnect", () => resolve()));
}

function deliver(over: Partial<InboundDeliver> = {}): InboundDeliver {
  const agentId = over.agentId ?? "coder";
  return {
    deliveryId: randomUUID(),
    kind: "message",
    channelId: CH,
    agentId,
    sessionKey: dodokSessionKey(agentId, CH),
    runId: randomUUID(),
    message: {
      id: randomUUID(),
      author: { type: "user", handle: "mia", displayName: "Mia" },
      text: "@coder 테스트를 돌려 줘",
      attachments: [],
      ts: "2026-09-27T00:00:00.000Z",
    },
    context: {
      recentMessages: [],
      participants: [
        { type: "user", handle: "mia", displayName: "Mia", isSelf: false },
        { type: "agent", handle: "coder", displayName: "Coder", isSelf: true },
      ],
      relayRules: "릴레이는 세 번까지",
      channelPrompt: "답은 항상 한국어로 한다",
    },
    options: {},
    ...over,
  };
}

function runEvents(h: Harness, runId: string): RunEventBody[] {
  return h.events.flatMap((e) => (e.kind === "run_event" && e.runId === runId ? [e.event] : []));
}

function signals(h: Harness, runId: string): string[] {
  return h.events.flatMap((e) => (e.kind === "run_signal" && e.runId === runId ? [e.signal.kind] : []));
}

function approvals(h: Harness): ProviderApproval[] {
  return h.events.flatMap((e) => (e.kind === "approval" ? [e.approval] : []));
}

async function readyRunner(
  h: Harness,
  token = TOKEN_A,
  agents = [runnerAgent("coder")],
): Promise<FakeRunner> {
  const r = await h.runner(token, agents);
  const res = await r.hello();
  expect(res.ok).toBe(true);
  return r;
}

async function startRun(
  h: Harness,
  r: FakeRunner,
  over: Partial<InboundDeliver> = {},
): Promise<InboundDeliver> {
  const input = deliver(over);
  await h.adapter.send(input, { providerSessionId: SESSION_ID });
  await until(() => r.runStarts.some((s) => s.deliver.runId === input.runId), "run.start");
  return input;
}

function rejection(p: Promise<unknown>): Promise<AdapterError> {
  return p.then(
    () => {
      throw new Error("expected rejection");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(AdapterError);
      return error as AdapterError;
    },
  );
}

describe("핸드셰이크", () => {
  it("틀린 토큰은 연결을 거절하고, 가드가 막은 주소는 옳은 토큰도 거절한다", async () => {
    const h = await setup();
    await expect(h.runner("drn_wrong")).rejects.toThrow("UNAUTHORIZED");
    await expect(h.runner("drn_wrong")).rejects.toThrow("UNAUTHORIZED");
    await expect(h.runner("drn_wrong")).rejects.toThrow("UNAUTHORIZED");
    expect(h.blocked).toHaveLength(1);
    await expect(h.runner(TOKEN_A)).rejects.toThrow("RATE_LIMITED");
    // 토큰 원문은 어느 로그에도 없다
    expect(JSON.stringify(h.logs)).not.toContain("drn_");
  });

  it("프로토콜이 다르면 PROTOCOL_MISMATCH 로 답하고 끊는다", async () => {
    const h = await setup();
    const r = await h.runner(TOKEN_A);
    const closed = waitDisconnect(r);
    const res = await r.hello({ runnerProtocol: 2 });
    expect(res).toMatchObject({ ok: false, code: "PROTOCOL_MISMATCH" });
    await closed;
    expect(h.adapter.status().runners.connected).toBe(0);
  });

  it("hello 모양이 틀리면 PROTOCOL_MISMATCH 로 답하고 끊는다", async () => {
    const h = await setup();
    const r = await h.runner(TOKEN_A);
    const closed = waitDisconnect(r);
    const res = await r.hello({ agents: [runnerAgent("Coder")] });
    expect(res).toMatchObject({ ok: false, code: "PROTOCOL_MISMATCH" });
    await closed;
  });

  it("붙은 뒤 10초 안에 hello 가 없으면 끊는다", async () => {
    const h = await setup({ fakeTimers: true });
    const r = await h.runner(TOKEN_A);
    await vi.advanceTimersByTimeAsync(9_900);
    expect(r.socket.connected).toBe(true);
    const closed = waitDisconnect(r);
    await vi.advanceTimersByTimeAsync(200);
    await closed;
  });

  it("hello 를 받으면 모르는 능력은 버리고 status·setup 을 알린다", async () => {
    const h = await setup();
    const r = await h.runner(TOKEN_A);
    const res = await r.hello({ bundleSha256: "not-a-sha" });
    expect(res).toEqual({ ok: true, serverVersion: "test-server", conflicts: [] });
    expect(h.adapter.status()).toEqual({ provider: "claude", runners: { connected: 1, tokens: 2 } });
    const detail = h.adapter.setupDetail();
    expect(detail.provider).toBe("claude");
    const [conn] = detail.runners;
    expect(conn).toMatchObject({
      tokenId: TOKENS[TOKEN_A]?.tokenId,
      label: "laptop",
      runnerVersion: "0.0.0",
      sdkVersion: "0.3.283",
      claudeCodeVersion: "2.1.283",
      bundleSha256: null,
      capabilities: ["threads", "interrupt", "approvals"],
      connectedAt: "2026-09-27T00:00:00.000Z",
      agents: [{ id: "coder", name: "Coder", model: "sonnet", workdirLabel: "coder-repo", conflict: false }],
    });
    expect(h.events.some((e) => e.kind === "status")).toBe(true);
    expect(h.events.some((e) => e.kind === "setup")).toBe(true);
  });
});

describe("러너 여러 대", () => {
  it("같은 토큰의 두 번째 연결은 먼저 붙은 소켓을 끊는다", async () => {
    const h = await setup();
    const first = await readyRunner(h);
    const firstClosed = waitDisconnect(first);
    const second = await readyRunner(h);
    await firstClosed;
    expect(second.socket.connected).toBe(true);
    expect(h.adapter.status().runners.connected).toBe(1);
    // 뒤 연결의 에이전트는 충돌이 아니다 — 앞 연결이 먼저 빠졌다
    expect(h.adapter.setupDetail().runners[0]?.agents[0]?.conflict).toBe(false);
    const input = await startRun(h, second);
    expect(first.runStarts).toHaveLength(0);
    expect(second.runStarts[0]?.deliver.runId).toBe(input.runId);
  });

  it("두 러너가 같은 에이전트를 알리면 뒤 러너 것이 충돌이고, 앞 러너가 끊기면 뒤 러너가 이어받는다", async () => {
    const h = await setup();
    const a = await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    const b = await h.runner(TOKEN_B, [runnerAgent("coder", { model: "opus" }), runnerAgent("writer")]);
    expect(await b.hello()).toMatchObject({ ok: true, conflicts: ["coder"] });
    expect(h.logs.some((l) => l.level === "warn" && JSON.stringify(l.obj).includes("coder"))).toBe(true);

    const agents = await h.adapter.listAgents();
    expect(agents).toEqual([
      { providerAgentId: "coder", name: "Coder", hint: "laptop · coder-repo · sonnet" },
      { providerAgentId: "writer", name: "Writer", hint: "desktop · writer-repo · sonnet" },
    ]);
    expect(h.adapter.setupDetail().runners[1]?.agents.map((x) => [x.id, x.conflict])).toEqual([
      ["coder", true],
      ["writer", false],
    ]);

    await startRun(h, a);
    expect(b.runStarts).toHaveLength(0);

    const aClosed = waitDisconnect(a);
    a.close();
    await aClosed;
    await until(() => h.adapter.status().runners.connected === 1, "runner a gone");
    const input = await startRun(h, b);
    expect(b.runStarts[0]?.deliver.runId).toBe(input.runId);
    expect(h.adapter.setupDetail().runners[0]?.agents.map((x) => x.conflict)).toEqual([false, false]);
    expect((await h.adapter.listAgents())[0]).toMatchObject({
      providerAgentId: "coder",
      hint: "desktop · coder-repo · opus",
    });
  });

  it("supports 는 그 에이전트를 가진 러너의 능력을 본다", async () => {
    const h = await setup();
    await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    const b = await h.runner(TOKEN_B, [runnerAgent("writer")]);
    await b.hello({ capabilities: ["interrupt"] });
    expect(h.adapter.supports("coder", "threads")).toBe(true);
    expect(h.adapter.supports("writer", "threads")).toBe(false);
    expect(h.adapter.supports("nobody", "threads")).toBe(false);
  });

  it("revokeTokenSessions 는 그 토큰의 연결을 끊고 끊은 수를 돌려준다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const closed = waitDisconnect(r);
    expect(h.adapter.revokeTokenSessions(TOKENS[TOKEN_A]?.tokenId ?? "")).toBe(1);
    await closed;
    expect(h.adapter.revokeTokenSessions(TOKENS[TOKEN_B]?.tokenId ?? "")).toBe(0);
    await until(() => h.adapter.status().runners.connected === 0, "revoked");
  });
});

describe("send", () => {
  it("run.start 에 채널 규칙·턴 사실·세션 id·제목을 싣고, 대기 순번이 있으면 RUN_QUEUED 를 낸다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    r.onRunStart = (p) => ({ runId: p.deliver.runId, admission: "dispatch", queuedPosition: 2 });
    const input = deliver();
    const result = await h.adapter.send(input, { providerSessionId: SESSION_ID });
    expect(result).toEqual({ admission: "dispatch", providerRunId: input.runId });
    const [start] = r.runStarts;
    expect(start?.providerSessionId).toBe(SESSION_ID);
    expect(start?.deliver).toEqual(input);
    expect(start?.channelRulesAppend).toContain('"#general"');
    expect(start?.channelRulesAppend).toContain("답은 항상 한국어로 한다");
    expect(start?.channelRulesAppend).toContain("릴레이는 세 번까지");
    expect(start?.turnFacts).toContain("@mia(사람)");
    expect(start?.turnFacts).toContain("@coder(에이전트, 나)");
    expect(start?.sessionTitle).toBe("general · Coder");
    await until(() => runEvents(h, input.runId).length > 0, "RUN_QUEUED");
    expect(runEvents(h, input.runId)).toEqual([{ type: "RUN_QUEUED", runId: input.runId, position: 2 }]);
  });

  it("스레드 런의 턴 사실은 스레드 자리를 말한다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const root = randomUUID();
    await startRun(h, r, { threadId: root, sessionKey: dodokSessionKey("coder", CH, root) });
    expect(r.runStarts[0]?.turnFacts).toContain("스레드");
  });

  it("그 에이전트를 가진 러너가 없으면 ADAPTER_UNAVAILABLE", async () => {
    const h = await setup();
    await readyRunner(h, TOKEN_A, [runnerAgent("writer")]);
    const error = await rejection(h.adapter.send(deliver(), { providerSessionId: SESSION_ID }));
    expect(error.code).toBe("ADAPTER_UNAVAILABLE");
  });

  it("drop 이면 그대로 돌려주고 그 런을 잊는다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    r.onRunStart = (p) => ({ runId: p.deliver.runId, admission: "drop", reason: "busy" });
    const input = deliver();
    expect(await h.adapter.send(input, { providerSessionId: SESSION_ID })).toEqual({
      admission: "drop",
      reason: "busy",
    });
    r.send("run.event", {
      runId: input.runId,
      event: { type: "STEP_STARTED", runId: input.runId, stepName: "x" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runEvents(h, input.runId)).toEqual([]);
  });

  it("ack 가 15초 안에 없으면 ADAPTER_UNAVAILABLE", async () => {
    const h = await setup({ fakeTimers: true });
    const r = await readyRunner(h);
    r.onRunStart = () => undefined;
    const pending = rejection(h.adapter.send(deliver(), { providerSessionId: SESSION_ID }));
    await until(() => r.runStarts.length === 1, "run.start");
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).code).toBe("ADAPTER_UNAVAILABLE");
  });

  it("ack 를 기다리는 사이 러너가 끊기면 곧바로 ADAPTER_UNAVAILABLE", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    r.onRunStart = () => undefined;
    const input = deliver();
    const pending = rejection(h.adapter.send(input, { providerSessionId: SESSION_ID }));
    await until(() => r.runStarts.length === 1, "run.start");
    r.close();
    expect((await pending).code).toBe("ADAPTER_UNAVAILABLE");
    // send 가 던졌으므로 오케스트레이터가 닫는다 — 어댑터가 따로 RUN_ERROR 를 내지 않는다
    expect(runEvents(h, input.runId)).toEqual([]);
  });

  it("providerSessionId 가 없으면 보내지 않는다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const error = await rejection(h.adapter.send(deliver()));
    expect(error.code).toBe("INTERNAL");
    expect(r.runStarts).toHaveLength(0);
  });
});

describe("런 이벤트", () => {
  it("텍스트·도구 이벤트를 run_event 로 옮기고 상태 신호를 낸다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId } = await startRun(h, r);
    const frames: RunEventBody[] = [
      { type: "TEXT_MESSAGE_START", runId, messageId: "msg_1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", runId, messageId: "msg_1", delta: "안녕" },
      { type: "TEXT_MESSAGE_END", runId, messageId: "msg_1" },
      { type: "TOOL_CALL_START", runId, toolCallId: "toolu_1", toolCallName: "Bash" },
      { type: "TOOL_CALL_ARGS", runId, toolCallId: "toolu_1", delta: '{"command":"ls"}' },
      { type: "TOOL_CALL_END", runId, toolCallId: "toolu_1" },
      { type: "TOOL_CALL_RESULT", runId, toolCallId: "toolu_1", content: "a.ts", ok: true },
    ];
    for (const event of frames) r.send("run.event", { runId, event });
    await until(() => runEvents(h, runId).length === frames.length, "events");
    expect(runEvents(h, runId)).toEqual(frames);
    expect(signals(h, runId)).toEqual(["gateway_started", "text_delta", "tool_start", "tool_end"]);
    const toolEnd = h.events.find((e) => e.kind === "run_signal" && e.signal.kind === "tool_end");
    expect(toolEnd).toMatchObject({ signal: { kind: "tool_end", openTools: 0 } });
  });

  it("스키마 밖·수명·승인 이벤트와 runId 가 어긋난 이벤트는 버리고 warn 한다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId } = await startRun(h, r);
    const other = randomUUID();
    const bad: unknown[] = [
      { runId, event: { type: "TEXT_MESSAGE_CONTENT", runId, messageId: "m", delta: "" } },
      { runId, event: { type: "NOPE", runId } },
      { runId, event: { type: "RUN_FINISHED", runId, messageIds: [] } },
      { runId, event: { type: "RUN_ERROR", runId, message: "x" } },
      { runId, event: { type: "RUN_STARTED", runId, threadId: CH, agentId: CH, sessionKey: "k" } },
      { runId, event: { type: "RUN_ABORTED", runId, by: "user" } },
      { runId, event: { type: "RUN_QUEUED", runId, position: 1 } },
      {
        runId,
        event: {
          type: "APPROVAL_REQUESTED",
          runId,
          approvalId: other,
          kind: "tool",
          title: "t",
          severity: "warning",
          allowedDecisions: ["deny"],
          expiresAt: "2026-09-27T00:10:00.000Z",
        },
      },
      {
        runId,
        event: { type: "APPROVAL_RESOLVED", runId, approvalId: other, decision: "deny", reason: "user" },
      },
      { runId, event: { type: "CUSTOM", runId, name: "dodok.usage", value: { costUsd: 9 } } },
      { runId, event: { type: "STEP_STARTED", runId: other, stepName: "x" } },
      { runId: other, event: { type: "STEP_STARTED", runId: other, stepName: "x" } },
    ];
    for (const frame of bad) r.send("run.event", frame);
    r.send("run.event", { runId, event: { type: "STEP_STARTED", runId, stepName: "last" } });
    await until(() => runEvents(h, runId).length === 1, "last event");
    expect(runEvents(h, runId)).toEqual([{ type: "STEP_STARTED", runId, stepName: "last" }]);
    expect(h.logs.filter((l) => l.level === "warn").length).toBeGreaterThanOrEqual(bad.length);
  });

  it("다른 러너의 런에 보낸 이벤트는 버린다", async () => {
    const h = await setup();
    const a = await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    const b = await readyRunner(h, TOKEN_B, [runnerAgent("writer")]);
    const { runId } = await startRun(h, a);
    b.send("run.event", { runId, event: { type: "STEP_STARTED", runId, stepName: "evil" } });
    a.send("run.event", { runId, event: { type: "STEP_STARTED", runId, stepName: "ok" } });
    await until(() => runEvents(h, runId).length === 1, "event");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runEvents(h, runId)).toEqual([{ type: "STEP_STARTED", runId, stepName: "ok" }]);
  });

  it("run.final 은 최종 답을 메시지로 만들고 dodok.usage 와 종료 신호를 낸다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const input = await startRun(h, r);
    const { runId } = input;
    r.send("run.final", {
      runId,
      text: "다 돌렸습니다",
      stopReason: "end_turn",
      usage: { inputTokens: 120, outputTokens: 30 },
      costUsd: 0.12,
      costKind: "subscription_estimate",
    });
    await until(() => signals(h, runId).includes("gateway_final"), "final");
    expect(h.outbound).toHaveLength(1);
    expect(h.outbound[0]).toMatchObject({
      channelId: CH,
      agentId: "coder",
      sessionKey: input.sessionKey,
      runId,
      replyToInboundId: input.message.id,
      text: "다 돌렸습니다",
      attachmentIds: [],
    });
    expect(h.outbound[0]?.threadId).toBeUndefined();
    expect(runEvents(h, runId)).toContainEqual({
      type: "CUSTOM",
      runId,
      name: "dodok.usage",
      value: {
        inputTokens: 120,
        outputTokens: 30,
        costUsd: 0.12,
        costKind: "subscription_estimate",
        model: "sonnet",
      },
    });
    // 정본이 저장된 뒤에 종료를 알린다 — 오케스트레이터가 finalizing 을 거치지 않고 끝낸다
    const final = h.events.find((e) => e.kind === "run_signal" && e.signal.kind === "gateway_final");
    expect(final).toEqual({ kind: "run_signal", runId, signal: { kind: "gateway_final" } });
    expect(h.events.some((e) => e.kind === "canonical")).toBe(false);
  });

  it("최종 답 저장이 실패하면 스냅숏을 실은 종료 신호로 넘긴다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId } = await startRun(h, r);
    h.failOutbound(true);
    r.send("run.final", { runId, text: "답", stopReason: "end_turn", costKind: "api" });
    await until(() => signals(h, runId).includes("gateway_final"), "final");
    const final = h.events.find((e) => e.kind === "run_signal" && e.signal.kind === "gateway_final");
    expect(final).toEqual({
      kind: "run_signal",
      runId,
      signal: { kind: "gateway_final" },
      snapshotText: "답",
    });
  });

  it("빈 최종 답은 메시지를 만들지 않는다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId } = await startRun(h, r);
    r.send("run.final", { runId, text: "  ", stopReason: "end_turn", costKind: "api" });
    await until(() => signals(h, runId).includes("gateway_final"), "final");
    expect(h.outbound).toHaveLength(0);
  });

  it("run.error 는 코드 그대로 RUN_ERROR 와 오류 신호가 된다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId } = await startRun(h, r);
    r.send("run.error", { runId, code: "PROVIDER_AUTH", message: "not logged in" });
    await until(() => signals(h, runId).includes("gateway_error"), "error");
    expect(runEvents(h, runId)).toEqual([
      { type: "RUN_ERROR", runId, code: "PROVIDER_AUTH", message: "not logged in" },
    ]);
    expect(h.events).toContainEqual({
      kind: "run_signal",
      runId,
      signal: { kind: "gateway_error", code: "PROVIDER_AUTH", message: "not logged in" },
    });
  });

  it("abort 는 run.abort 를 보내고, 중지된 런의 최종 답은 올리지 않는다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId, sessionKey } = await startRun(h, r);
    await h.adapter.abort(runId, sessionKey);
    await until(() => r.aborts.length === 1, "abort");
    expect(r.aborts).toEqual([{ runId }]);
    r.send("run.final", {
      runId,
      text: "중간까지",
      stopReason: "interrupted",
      costUsd: 0.01,
      costKind: "api",
    });
    await until(() => runEvents(h, runId).some((e) => e.type === "CUSTOM"), "usage");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.outbound).toHaveLength(0);
  });

  it("outbound.post 는 onOutbound 로 메시지를 만들고 messageId 로 답한다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId, sessionKey } = await startRun(h, r);
    const post = {
      outboundId: "post-1",
      channelId: CH,
      agentId: "coder",
      sessionKey,
      runId,
      text: "중간 보고",
      ts: "2026-09-27T00:00:01.000Z",
    };
    const ack = await r.post(post);
    expect(ack).toMatchObject({ ok: true });
    expect(h.outbound).toEqual([{ ...post, attachmentIds: [] }]);
    // 다른 에이전트 이름으로는 못 쓴다
    const denied = await r.post({
      ...post,
      outboundId: "post-2",
      agentId: "writer",
      sessionKey: dodokSessionKey("writer", CH),
    });
    expect(denied).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const invalid = await r.post({ text: "x" });
    expect(invalid).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(h.outbound).toHaveLength(1);
  });
});

describe("승인", () => {
  async function requestApproval(
    h: Harness,
    r: FakeRunner,
    runId: string,
    sessionKey: string,
    canAllowAlways = true,
  ) {
    r.send("approval.requested", {
      providerApprovalId: "perm-1",
      runId,
      sessionKey,
      toolCallId: "toolu_9",
      toolName: "Write",
      summary: "src/a.ts",
      canAllowAlways,
    });
    await until(() => approvals(h).length === 1, "approval");
    return approvals(h)[0] as ProviderApproval;
  }

  it("요청은 pending 승인이 되고 allow-always 결정은 러너로 간다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId, sessionKey } = await startRun(h, r);
    const pending = await requestApproval(h, r, runId, sessionKey);
    expect(pending).toMatchObject({
      kind: "tool",
      sessionKey,
      providerAgentId: "coder",
      channelId: CH,
      toolCallId: "toolu_9",
      toolName: "Write",
      title: "Write",
      detail: "src/a.ts",
      severity: "warning",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      status: "pending",
      createdAt: "2026-09-27T00:00:00.000Z",
      expiresAt: "2026-09-27T00:10:00.000Z",
    });
    expect(pending.providerApprovalId).not.toBe("perm-1");
    const resolved = await h.adapter.resolveApproval(pending.providerApprovalId, "tool", "allow-always");
    expect(resolved).toMatchObject({ status: "allowed", decision: "allow-always", reason: "user" });
    await until(() => r.resolves.length === 1, "resolve");
    expect(r.resolves).toEqual([{ providerApprovalId: "perm-1", decision: "allow-always" }]);
  });

  it("항상 허용을 못 하는 도구는 결정 둘만 보인다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId, sessionKey } = await startRun(h, r);
    const pending = await requestApproval(h, r, runId, sessionKey, false);
    expect(pending.allowedDecisions).toEqual(["allow-once", "deny"]);
    const error = await rejection(
      h.adapter.resolveApproval(pending.providerApprovalId, "tool", "allow-always"),
    );
    expect(error.code).toBe("VALIDATION");
  });

  it("10분 동안 결정이 없으면 러너에 deny 를 보내고 만료로 닫으며, 뒤늦은 결정은 EXPIRED", async () => {
    expect(RUNNER_APPROVAL_TTL_MS).toBe(600_000);
    const h = await setup({ fakeTimers: true });
    const r = await readyRunner(h);
    const { runId, sessionKey } = await startRun(h, r);
    const pending = await requestApproval(h, r, runId, sessionKey);
    await vi.advanceTimersByTimeAsync(RUNNER_APPROVAL_TTL_MS - 100);
    expect(r.resolves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    await until(() => r.resolves.length === 1, "expiry deny");
    expect(r.resolves).toEqual([{ providerApprovalId: "perm-1", decision: "deny", reason: "expired" }]);
    expect(approvals(h).at(-1)).toMatchObject({
      providerApprovalId: pending.providerApprovalId,
      status: "expired",
      decision: "deny",
      reason: "timeout",
    });
    const error = await rejection(
      h.adapter.resolveApproval(pending.providerApprovalId, "tool", "allow-once"),
    );
    expect(error.code).toBe("EXPIRED");
    expect(r.resolves).toHaveLength(1);
  });

  it("approval.withdrawn 은 같은 승인을 철회로 닫는다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId, sessionKey } = await startRun(h, r);
    const pending = await requestApproval(h, r, runId, sessionKey);
    r.send("approval.withdrawn", { providerApprovalId: "perm-1" });
    await until(() => approvals(h).length === 2, "withdrawn");
    expect(approvals(h)[1]).toMatchObject({
      providerApprovalId: pending.providerApprovalId,
      status: "cancelled",
      reason: "run-aborted",
    });
  });

  it("다른 세션 키로 온 승인 요청은 버린다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId } = await startRun(h, r);
    r.send("approval.requested", {
      providerApprovalId: "perm-x",
      runId,
      sessionKey: dodokSessionKey("coder", randomUUID()),
      toolCallId: "t",
      toolName: "Bash",
      summary: "rm",
      canAllowAlways: false,
    });
    r.send("run.event", { runId, event: { type: "STEP_STARTED", runId, stepName: "after" } });
    await until(() => runEvents(h, runId).length === 1, "after");
    expect(approvals(h)).toEqual([]);
  });
});

describe("러너 끊김", () => {
  it("런 도중 끊기면 그 런은 ADAPTER_UNAVAILABLE, 떠 있던 승인은 철회, 뒤 결정은 ADAPTER_UNAVAILABLE", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId, sessionKey } = await startRun(h, r);
    r.send("approval.requested", {
      providerApprovalId: "perm-1",
      runId,
      sessionKey,
      toolCallId: "toolu_1",
      toolName: "Bash",
      summary: "npm test",
      canAllowAlways: true,
    });
    await until(() => approvals(h).length === 1, "approval");
    const id = approvals(h)[0]?.providerApprovalId ?? "";
    h.events.length = 0;
    r.close();
    await until(() => signals(h, runId).includes("gateway_error"), "run closed");
    expect(runEvents(h, runId)).toEqual([
      { type: "RUN_ERROR", runId, code: "ADAPTER_UNAVAILABLE", message: "runner disconnected" },
    ]);
    expect(h.events).toContainEqual({
      kind: "run_signal",
      runId,
      signal: { kind: "gateway_error", code: "ADAPTER_UNAVAILABLE", message: "runner disconnected" },
    });
    expect(approvals(h)).toEqual([expect.objectContaining({ providerApprovalId: id, status: "cancelled" })]);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        kind: "status",
        status: { provider: "claude", runners: { connected: 0, tokens: 2 } },
      }),
    );
    expect(h.events.some((e) => e.kind === "setup")).toBe(true);
    const error = await rejection(h.adapter.resolveApproval(id, "tool", "allow-once"));
    expect(error.code).toBe("ADAPTER_UNAVAILABLE");
  });
});

describe("나머지 계약", () => {
  it("능력·세션 리셋·채널 설정", async () => {
    const h = await setup();
    expect(h.adapter.provider).toBe("claude");
    expect(h.adapter.capabilities()).toEqual({
      sessionReset: true,
      agentsList: true,
      configSet: true,
      promptEveryRun: true,
      serverSessionIds: true,
    });
    expect(await h.adapter.resetSession(dodokSessionKey("coder", CH))).toEqual({});
    expect(await h.adapter.syncChannelConfig(CH, { systemPrompt: "x" })).toEqual({ applied: "live" });
    expect(h.adapter.sessionKeyFor("coder", CH)).toBe(dodokSessionKey("coder", CH));
    expect(h.adapter.status()).toEqual({ provider: "claude", runners: { connected: 0, tokens: 2 } });
  });
});

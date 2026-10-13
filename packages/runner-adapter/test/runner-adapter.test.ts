import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AdapterEvent,
  AdapterError,
  artifactUrl,
  BridgeAuthGuard,
  type ControlResult,
  dodokSessionKey,
  formatReactionFacts,
  type InboundDeliver,
  OutboundMessage,
  type ProviderApproval,
  type RunEventBody,
  type RunnerControlCall,
} from "@dodok/shared";
import { Server } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunnerAdapter,
  RUNNER_APPROVAL_TTL_MS,
  type RunnerAdapter,
  type RunnerAdapterOptions,
} from "../src";
import { FRAME_BUCKET, RUN_FREE_APPROVALS } from "../src/runner-adapter";
import { connectRunner, type FakeRunner, runnerAgent } from "./helpers/fake-runner-client";

const TOKEN_A = "drn_token-a";
const TOKEN_B = "drn_token-b";
/** 러너 A 의 연결 id(= 토큰 id) — 이벤트·send 결과에 실린다. 승인·설정 동기화가 받는 연결 자리에도 쓴다(러너 어댑터는 보지 않는다) */
const RUNNER_A_CONNECTION = "7a0e2d3c-2d1f-4f5e-9a6b-000000000001";
const TOKENS: Record<string, { tokenId: string; label: string }> = {
  [TOKEN_A]: { tokenId: RUNNER_A_CONNECTION, label: "laptop" },
  [TOKEN_B]: { tokenId: "7a0e2d3c-2d1f-4f5e-9a6b-000000000002", label: "desktop" },
};
const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const CH2 = "01a09fc9-d204-7551-89d6-38544d07a103";
const SESSION_ID = "5f0c8a52-3f7e-4c1b-8d2a-1b2c3d4e5f60";

type LogLine = { level: string; obj: object; msg?: string };

type Harness = {
  adapter: RunnerAdapter;
  url: string;
  events: AdapterEvent[];
  outbound: OutboundMessage[];
  /** onOutbound 이 받은 연결 id — outbound 와 같은 순서 */
  outboundConnections: string[];
  logs: LogLine[];
  blocked: string[];
  runners: FakeRunner[];
  setNow(ms: number): void;
  setChannelName(channelId: string, name: string): void;
  failOutbound(on: boolean): void;
  /** frameLimit.onLimited 가 받은 것 — [주소, 프레임, 버린 수] */
  limited: Array<[string, string, number]>;
  /** 등록된 claude 에이전트의 묶인 토큰 id(null 이면 묶임 없음) — bindings 옵션이 읽고 claim 이 쓴다 */
  bound: Map<string, string | null>;
  /** onControlCall 이 받은 것 — [연결 id, 호출] */
  controlCalls: Array<[string, RunnerControlCall]>;
  runner(token: string, agents?: ReturnType<typeof runnerAgent>[]): Promise<FakeRunner>;
};

let current: { http: HttpServer; io: Server; adapter: RunnerAdapter; runners: FakeRunner[] } | undefined;

/** 소켓마다 새 버킷 — 각 버킷은 처음 n 번만 통과한다(시간으로 차지 않는다) */
type FrameAllowance = { events: number; control: number };

async function setup(
  opts: {
    fakeTimers?: boolean;
    frames?: FrameAllowance;
    bound?: Record<string, string | null>;
    /** 서버의 제어 도구 처리 — 기본은 받은 호출을 그대로 data 로 돌려준다. null 이면 옵션을 주지 않는다 */
    control?: RunnerAdapterOptions["onControlCall"] | null;
  } = {},
): Promise<Harness> {
  // 가짜 시계로 10분을 건너뛰어도 Socket.IO 하트비트가 끊지 않게 핑 간격을 늘린다
  if (opts.fakeTimers) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  const http = createServer();
  const io = new Server(http, { transports: ["websocket"], pingInterval: 3_600_000, pingTimeout: 3_600_000 });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const events: AdapterEvent[] = [];
  const outbound: OutboundMessage[] = [];
  const outboundConnections: string[] = [];
  const logs: LogLine[] = [];
  const blocked: string[] = [];
  const runners: FakeRunner[] = [];
  let nowMs = Date.parse("2026-09-27T00:00:00.000Z");
  let outboundFails = false;
  const channelNames = new Map([[CH, "general"]]);
  const limited: Array<[string, string, number]> = [];
  const bound = new Map<string, string | null>(Object.entries(opts.bound ?? {}));
  const controlCalls: Array<[string, RunnerControlCall]> = [];
  const control =
    opts.control === null
      ? undefined
      : (opts.control ??
        (async (_id: string, call: RunnerControlCall): Promise<ControlResult> => ({ ok: true, data: call })));
  const frames = opts.frames ?? { events: Number.POSITIVE_INFINITY, control: Number.POSITIVE_INFINITY };
  const allowance = (n: number) => {
    let left = n;
    return { take: () => left-- > 0 };
  };
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
    channelName: (channelId) => channelNames.get(channelId),
    onOutbound: async (m, connectionId) => {
      if (outboundFails) throw new Error("db is locked");
      outbound.push(m);
      outboundConnections.push(connectionId);
      return { messageId: randomUUID() };
    },
    tokenCount: () => 2,
    ...(control === undefined
      ? {}
      : {
          onControlCall: (connectionId: string, call: RunnerControlCall) => {
            controlCalls.push([connectionId, call]);
            return control(connectionId, call);
          },
        }),
    bindings: {
      boundToken: (agentId) => bound.get(agentId) ?? null,
      claim: (agentId, tokenId) => {
        if (!bound.has(agentId) || bound.get(agentId) !== null) return false;
        bound.set(agentId, tokenId);
        return true;
      },
    },
    frameLimit: {
      buckets: () => ({ events: allowance(frames.events), control: allowance(frames.control) }),
      onLimited: (address, frame, dropped) => limited.push([address, frame, dropped]),
    },
  });
  adapter.onEvent((e) => events.push(e));
  await adapter.connect();
  current = { http, io, adapter, runners };
  return {
    adapter,
    url,
    events,
    outbound,
    outboundConnections,
    logs,
    blocked,
    runners,
    setNow: (ms) => {
      nowMs = ms;
    },
    setChannelName: (channelId, name) => {
      channelNames.set(channelId, name);
    },
    failOutbound: (on) => {
      outboundFails = on;
    },
    limited,
    bound,
    controlCalls,
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

/** 러너(socket.io-client)가 받은 끊김 사유 — 이미 끊겼으면 빈 문자열 */
function waitDisconnect(r: FakeRunner): Promise<string> {
  return r.socket.disconnected
    ? Promise.resolve("")
    : new Promise((resolve) => r.socket.once("disconnect", (reason) => resolve(reason)));
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
  await h.adapter.send(input, { connectionId: null, providerSessionId: SESSION_ID });
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

  it("붙은 뒤 10초 안에 hello 가 없으면 전송만 끊는다 — 러너는 transport close 로 받아 다시 붙는다 [R4]", async () => {
    const h = await setup({ fakeTimers: true });
    const r = await h.runner(TOKEN_A);
    await vi.advanceTimersByTimeAsync(9_900);
    expect(r.socket.connected).toBe(true);
    const closed = waitDisconnect(r);
    await vi.advanceTimersByTimeAsync(200);
    expect(await closed).toBe("transport close");
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
    // 교체된 러너는 다시 붙지 않고 끝난다 [R4]
    expect(await firstClosed).toBe("io server disconnect");
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

    const agents = await h.adapter.listAgents(null);
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
    expect((await h.adapter.listAgents(null))[0]).toMatchObject({
      providerAgentId: "coder",
      hint: "desktop · coder-repo · opus",
    });
  });

  it("같은 토큰으로 다시 붙은 러너는 옛 자리를 잇는다 — 충돌한 뒤 러너가 에이전트를 가져가지 않는다", async () => {
    const h = await setup();
    const a = await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    const b = await h.runner(TOKEN_B, [runnerAgent("coder", { model: "opus" })]);
    expect(await b.hello()).toMatchObject({ ok: true, conflicts: ["coder"] });
    const aClosed = waitDisconnect(a);
    const a2 = await h.runner(TOKEN_A, [runnerAgent("coder")]);
    expect(await a2.hello()).toMatchObject({ ok: true, conflicts: [] });
    await aClosed;
    expect(h.adapter.setupDetail().runners.map((c) => [c.label, c.agents[0]?.conflict])).toEqual([
      ["laptop", false],
      ["desktop", true],
    ]);
    expect(h.logs.some((l) => l.msg === "runner agent taken over")).toBe(false);
    const input = await startRun(h, a2);
    expect(a2.runStarts[0]?.deliver.runId).toBe(input.runId);
    expect(b.runStarts).toHaveLength(0);
  });

  it("supports: threads 를 알린 러너의 에이전트는 true", async () => {
    const h = await setup();
    await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    expect(h.adapter.supports("coder", null, "threads")).toBe(true);
  });

  it("supports: 그 에이전트를 가진 러너가 threads 를 안 알렸으면 false", async () => {
    const h = await setup();
    const b = await h.runner(TOKEN_B, [runnerAgent("writer")]);
    await b.hello({ capabilities: ["interrupt"] });
    expect(h.adapter.supports("writer", null, "threads")).toBe(false);
  });

  it("supports: 그 에이전트를 가진 러너가 없으면 true — 옛 러너로 닫지 않고 send 가 ADAPTER_UNAVAILABLE 로 닫게", async () => {
    const h = await setup();
    expect(h.adapter.supports("coder", null, "threads")).toBe(true);
    const b = await h.runner(TOKEN_B, [runnerAgent("writer")]);
    await b.hello({ capabilities: ["interrupt"] });
    expect(h.adapter.supports("nobody", null, "threads")).toBe(true);
    const error = await rejection(
      h.adapter.send(deliver({ agentId: "nobody" }), { connectionId: null, providerSessionId: SESSION_ID }),
    );
    expect(error.code).toBe("ADAPTER_UNAVAILABLE");
  });

  it("close() 는 전송만 끊는다 — 붙은 러너·hello 전 러너 모두 transport close 로 받아 다시 붙는다 [R4]", async () => {
    const h = await setup();
    const ready = await readyRunner(h);
    const early = await h.runner(TOKEN_B);
    const reasons = Promise.all([waitDisconnect(ready), waitDisconnect(early)]);
    await h.adapter.close();
    expect(await reasons).toEqual(["transport close", "transport close"]);
  });

  it("revokeTokenSessions 는 그 토큰의 연결을 끊고 끊은 수를 돌려준다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const closed = waitDisconnect(r);
    expect(h.adapter.revokeTokenSessions(TOKENS[TOKEN_A]?.tokenId ?? "")).toBe(1);
    // 폐기된 러너는 다시 붙지 않고 끝난다 [R4]
    expect(await closed).toBe("io server disconnect");
    expect(h.adapter.revokeTokenSessions(TOKENS[TOKEN_B]?.tokenId ?? "")).toBe(0);
    await until(() => h.adapter.status().runners.connected === 0, "revoked");
  });
});

describe("send", () => {
  it("run.start 에 채널 규칙·턴 사실·세션 id·제목을 싣고, 대기 순번이 있으면 RUN_QUEUED 를 내고 결과에 queued 를 싣는다 [최종 리뷰 I1]", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    r.onRunStart = (p) => ({ runId: p.deliver.runId, admission: "dispatch", queuedPosition: 2 });
    const input = deliver();
    const result = await h.adapter.send(input, { connectionId: null, providerSessionId: SESSION_ID });
    expect(result).toEqual({
      admission: "dispatch",
      providerRunId: input.runId,
      connectionId: RUNNER_A_CONNECTION,
      queued: true,
    });
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

  it("deliver.context.reactions 와 reactionsOmitted 가 턴 사실 끝에 블록으로 붙고, 없으면 블록이 없다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const reactions = [
      {
        messageId: randomUUID(),
        excerpt: "테스트 결과",
        emoji: "👍" as const,
        by: "mia",
        at: "2026-09-27T00:01:00.000Z",
      },
    ];
    const plain = deliver();
    await h.adapter.send(plain, { connectionId: null, providerSessionId: SESSION_ID });
    await until(() => r.runStarts.some((s) => s.deliver.runId === plain.runId), "run.start");
    const base = r.runStarts[0]?.turnFacts ?? "";
    expect(base).not.toContain("반응(");

    const base2 = deliver();
    const withReactions = { ...base2, context: { ...base2.context, reactions, reactionsOmitted: 2 } };
    await h.adapter.send(withReactions, { connectionId: null, providerSessionId: SESSION_ID });
    await until(() => r.runStarts.some((s) => s.deliver.runId === withReactions.runId), "run.start 2");
    const start = r.runStarts.find((s) => s.deliver.runId === withReactions.runId);
    expect(start?.turnFacts).toBe(`${base}\n${formatReactionFacts(reactions, 2)}`);
    expect(start?.turnFacts).toContain("(외 2개)");
  });

  it("그 에이전트를 가진 러너가 없으면 ADAPTER_UNAVAILABLE", async () => {
    const h = await setup();
    await readyRunner(h, TOKEN_A, [runnerAgent("writer")]);
    const error = await rejection(
      h.adapter.send(deliver(), { connectionId: null, providerSessionId: SESSION_ID }),
    );
    expect(error.code).toBe("ADAPTER_UNAVAILABLE");
  });

  it("drop 이면 그대로 돌려주고 그 런을 잊는다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    r.onRunStart = (p) => ({ runId: p.deliver.runId, admission: "drop", reason: "busy" });
    const input = deliver();
    expect(await h.adapter.send(input, { connectionId: null, providerSessionId: SESSION_ID })).toEqual({
      admission: "drop",
      reason: "busy",
      connectionId: RUNNER_A_CONNECTION,
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
    const pending = rejection(
      h.adapter.send(deliver(), { connectionId: null, providerSessionId: SESSION_ID }),
    );
    await until(() => r.runStarts.length === 1, "run.start");
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).code).toBe("ADAPTER_UNAVAILABLE");
  });

  it("ack 를 기다리는 사이 러너가 끊기면 곧바로 ADAPTER_UNAVAILABLE", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    r.onRunStart = () => undefined;
    const input = deliver();
    const pending = rejection(h.adapter.send(input, { connectionId: null, providerSessionId: SESSION_ID }));
    await until(() => r.runStarts.length === 1, "run.start");
    r.close();
    expect((await pending).code).toBe("ADAPTER_UNAVAILABLE");
    // send 가 던졌으므로 오케스트레이터가 닫는다 — 어댑터가 따로 RUN_ERROR 를 내지 않는다
    expect(runEvents(h, input.runId)).toEqual([]);
  });

  it("PROBE-8: dispatch ack 와 끊김이 같은 틱이면 send 가 dispatch 를 돌려줘도 RUN_ERROR 가 한 번 나간다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    r.onRunStart = (p) => {
      queueMicrotask(() => r.socket.disconnect());
      return { runId: p.deliver.runId, admission: "dispatch" };
    };
    const input = deliver();
    expect(await h.adapter.send(input, { connectionId: null, providerSessionId: SESSION_ID })).toEqual({
      admission: "dispatch",
      providerRunId: input.runId,
      connectionId: RUNNER_A_CONNECTION,
    });
    await until(() => signals(h, input.runId).includes("gateway_error"), "run error");
    await until(() => h.adapter.status().runners.connected === 0, "runner gone");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runEvents(h, input.runId)).toEqual([
      { type: "RUN_ERROR", runId: input.runId, code: "ADAPTER_UNAVAILABLE", message: "runner disconnected" },
    ]);
    expect(signals(h, input.runId)).toEqual(["gateway_error"]);
  });

  it("sessionTitle 은 코드 포인트로 자른다 — 서로게이트 쌍을 반으로 가르지 않는다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    h.setChannelName(CH2, `${"a".repeat(119)}😀😀`);
    await startRun(h, r, { channelId: CH2, sessionKey: dodokSessionKey("coder", CH2) });
    expect(r.runStarts[0]?.sessionTitle).toBe("a".repeat(119));
  });

  it("providerSessionId 가 없으면 보내지 않는다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const error = await rejection(h.adapter.send(deliver(), { connectionId: null }));
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

  it("hello 전 소켓의 프레임은 어느 러너의 것으로도 넘기지 않는다", async () => {
    const h = await setup();
    const a = await readyRunner(h);
    const { runId } = await startRun(h, a);
    const stranger = await h.runner(TOKEN_B);
    stranger.send("run.event", { runId, event: { type: "STEP_STARTED", runId, stepName: "evil" } });
    stranger.send("run.final", { runId, text: "가로챔", stopReason: "end_turn", costKind: "api" });
    a.send("run.event", { runId, event: { type: "STEP_STARTED", runId, stepName: "ok" } });
    await until(() => runEvents(h, runId).length === 1, "own event");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runEvents(h, runId)).toEqual([{ type: "STEP_STARTED", runId, stepName: "ok" }]);
    expect(signals(h, runId)).toEqual(["gateway_started"]);
    expect(h.outbound).toHaveLength(0);
  });

  it("모르는 프레임 이름은 버리고 소켓마다 1분에 한 줄 warn 한다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const unknownWarns = () => h.logs.filter((l) => l.msg === "runner sent an unknown frame — dropped");
    r.send("nope.frame", { x: 1 });
    r.send("nope.frame", { x: 2 });
    r.send("other.frame", {});
    await until(() => unknownWarns().length === 1, "first warn");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(unknownWarns()).toHaveLength(1);
    expect(unknownWarns()[0]?.obj).toMatchObject({ event: "nope.frame" });
    h.setNow(Date.parse("2026-09-27T00:01:00.000Z"));
    r.send("third.frame", {});
    await until(() => unknownWarns().length === 2, "second warn");
    expect(unknownWarns()[1]?.obj).toMatchObject({ event: "third.frame", suppressed: 2 });
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
    expect(final).toEqual({
      kind: "run_signal",
      runId,
      connectionId: RUNNER_A_CONNECTION,
      signal: { kind: "gateway_final" },
    });
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
      connectionId: RUNNER_A_CONNECTION,
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
      connectionId: RUNNER_A_CONNECTION,
      signal: { kind: "gateway_error", code: "PROVIDER_AUTH", message: "not logged in" },
    });
  });

  it("abort 는 run.abort 를 보내고, 중지된 턴의 최종 답은 메시지 없이 중지 신호 한 번이 된다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId, sessionKey } = await startRun(h, r);
    await h.adapter.abort(runId, sessionKey, null);
    await until(() => r.aborts.length === 1, "abort");
    expect(r.aborts).toEqual([{ runId }]);
    r.send("run.final", { runId, text: "", stopReason: "aborted", costUsd: 0.01, costKind: "api" });
    await until(() => signals(h, runId).length > 0, "stop signal");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.outbound).toHaveLength(0);
    expect(signals(h, runId)).toEqual(["gateway_aborted"]);
    expect(runEvents(h, runId)).toEqual([
      {
        type: "CUSTOM",
        runId,
        name: "dodok.usage",
        value: { costUsd: 0.01, costKind: "api", model: "sonnet" },
      },
      { type: "RUN_ABORTED", runId, by: "user" },
    ]);
  });

  it("서버가 중지한 런이면 stopReason 이 무엇이든 중간 답을 올리지 않는다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId, sessionKey } = await startRun(h, r);
    await h.adapter.abort(runId, sessionKey, null);
    r.send("run.final", { runId, text: "중간까지", stopReason: "end_turn", costKind: "api" });
    await until(() => signals(h, runId).length > 0, "stop signal");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.outbound).toHaveLength(0);
    expect(signals(h, runId)).toEqual(["gateway_aborted"]);
    expect(runEvents(h, runId).filter((e) => e.type === "RUN_ABORTED")).toEqual([
      { type: "RUN_ABORTED", runId, by: "user" },
    ]);
  });

  it("서버 abort 없이 러너 쪽에서 중지된 턴(aborted final)도 메시지 없이 중지 신호 한 번이다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId } = await startRun(h, r);
    r.send("run.final", { runId, text: "중간까지", stopReason: "aborted", costKind: "api" });
    await until(() => signals(h, runId).length > 0, "stop signal");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.outbound).toHaveLength(0);
    expect(signals(h, runId)).toEqual(["gateway_aborted"]);
    expect(runEvents(h, runId).filter((e) => e.type === "RUN_ABORTED")).toEqual([
      { type: "RUN_ABORTED", runId, by: "user" },
    ]);
  });

  it("러너를 끄느라 멈춘 턴(runner_shutdown final)은 중지가 아니라 ADAPTER_UNAVAILABLE 오류로 닫는다 — 채널에 「다시 실행」이 뜨게", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId } = await startRun(h, r);
    r.send("run.final", {
      runId,
      text: "중간까지",
      stopReason: "runner_shutdown",
      costUsd: 0.01,
      costKind: "api",
    });
    await until(() => signals(h, runId).length > 0, "stop signal");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.outbound).toHaveLength(0);
    expect(signals(h, runId)).toEqual(["gateway_error"]);
    expect(runEvents(h, runId)).toEqual([
      {
        type: "CUSTOM",
        runId,
        name: "dodok.usage",
        value: { costUsd: 0.01, costKind: "api", model: "sonnet" },
      },
      { type: "RUN_ERROR", runId, code: "ADAPTER_UNAVAILABLE", message: "runner stopped" },
    ]);
    expect(h.events).toContainEqual({
      kind: "run_signal",
      runId,
      connectionId: RUNNER_A_CONNECTION,
      signal: { kind: "gateway_error", code: "ADAPTER_UNAVAILABLE", message: "runner stopped" },
    });
  });

  it("서버가 먼저 중지한 런은 러너가 꺼지며 runner_shutdown 으로 닫아도 사람 중지 그대로다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId, sessionKey } = await startRun(h, r);
    await h.adapter.abort(runId, sessionKey, null);
    r.send("run.final", {
      runId,
      text: "",
      stopReason: "runner_shutdown",
      costKind: "subscription_estimate",
    });
    await until(() => signals(h, runId).length > 0, "stop signal");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(signals(h, runId)).toEqual(["gateway_aborted"]);
    expect(runEvents(h, runId)).toEqual([{ type: "RUN_ABORTED", runId, by: "user" }]);
  });

  it("최종 답이 10만 자를 넘으면 코드 포인트 경계로 잘라 꼬리를 붙인다 — 저장 상한에 걸려 답이 사라지지 않게 [최종 리뷰 M1]", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId } = await startRun(h, r);
    // 자르는 자리에 서로게이트 쌍이 걸치게 — 반쪽이 남으면 안 된다
    const long = "가".repeat(99_980) + "😀".repeat(20);
    r.send("run.final", { runId, text: long, stopReason: "end_turn", costKind: "api" });
    await until(() => signals(h, runId).includes("gateway_final"), "final");
    const text = h.outbound[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(100_000);
    expect(text.endsWith("(길어서 잘렸습니다)")).toBe(true);
    expect(text.startsWith("가".repeat(99_980))).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
    expect(OutboundMessage.safeParse(h.outbound[0]).success).toBe(true);
  });

  it("10만 자 딱 맞는 최종 답은 그대로, 넘는 답의 저장 실패 스냅숏도 잘린 글이다 [최종 리뷰 M1]", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const first = await startRun(h, r);
    const exact = "a".repeat(100_000);
    r.send("run.final", { runId: first.runId, text: exact, stopReason: "end_turn", costKind: "api" });
    await until(() => signals(h, first.runId).includes("gateway_final"), "final");
    expect(h.outbound[0]?.text).toBe(exact);

    const second = await startRun(h, r, { channelId: CH2, sessionKey: dodokSessionKey("coder", CH2) });
    h.failOutbound(true);
    r.send("run.final", {
      runId: second.runId,
      text: "b".repeat(100_001),
      stopReason: "end_turn",
      costKind: "api",
    });
    await until(() => signals(h, second.runId).includes("gateway_final"), "final");
    const snapshot = h.events.find(
      (e) => e.kind === "run_signal" && e.runId === second.runId && e.signal.kind === "gateway_final",
    );
    const snapshotText = snapshot?.kind === "run_signal" ? (snapshot.snapshotText ?? "") : "";
    expect(snapshotText.length).toBeLessThanOrEqual(100_000);
    expect(snapshotText.endsWith("(길어서 잘렸습니다)")).toBe(true);
  });

  it("비용·토큰이 하나도 없는 최종(대기열에서 중지된 런)은 dodok.usage 를 내지 않는다 — 환산 표시가 켜지지 않게 [최종 리뷰 M2]", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId } = await startRun(h, r);
    // 러너 abortedFinal() 그대로 — init 을 못 봐 costKind 는 subscription_estimate 기본값
    r.send("run.final", { runId, text: "", stopReason: "aborted", costKind: "subscription_estimate" });
    await until(() => signals(h, runId).length > 0, "stop signal");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runEvents(h, runId)).toEqual([{ type: "RUN_ABORTED", runId, by: "user" }]);
  });

  it("토큰만 있어도 dodok.usage 를 낸다 [최종 리뷰 M2]", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId } = await startRun(h, r);
    r.send("run.final", {
      runId,
      text: "",
      stopReason: "aborted",
      usage: { inputTokens: 5 },
      costKind: "api",
    });
    await until(() => signals(h, runId).length > 0, "stop signal");
    expect(runEvents(h, runId)).toContainEqual({
      type: "CUSTOM",
      runId,
      name: "dodok.usage",
      value: { inputTokens: 5, costKind: "api", model: "sonnet" },
    });
  });

  it("outbound.post 의 outboundId 는 runner-post: 접두사여야 한다 — 최종 답 runner-final:<runId> 를 선점하지 못하게 [최종 리뷰 M4]", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId, sessionKey } = await startRun(h, r);
    const post = {
      channelId: CH,
      agentId: "coder",
      sessionKey,
      runId,
      text: "중간",
      ts: "2026-09-27T00:00:01.000Z",
    };
    for (const outboundId of [`runner-final:${runId}`, "post-1", randomUUID(), "runner-post:"])
      expect(await r.post({ ...post, outboundId })).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(h.outbound).toEqual([]);
    expect(await r.post({ ...post, outboundId: `runner-post:${randomUUID()}` })).toMatchObject({ ok: true });
    r.send("run.final", { runId, text: "최종", stopReason: "end_turn", costKind: "api" });
    await until(() => signals(h, runId).includes("gateway_final"), "final");
    expect(h.outbound.map((m) => m.outboundId)).toEqual([
      expect.stringMatching(/^runner-post:/),
      `runner-final:${runId}`,
    ]);
  });

  it("outbound.post 는 onOutbound 로 메시지를 만들고 messageId 로 답한다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId, sessionKey } = await startRun(h, r);
    const post = {
      outboundId: "runner-post:1",
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
      outboundId: "runner-post:2",
      agentId: "writer",
      sessionKey: dodokSessionKey("writer", CH),
    });
    expect(denied).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const invalid = await r.post({ text: "x" });
    expect(invalid).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(h.outbound).toHaveLength(1);
  });
});

describe("outbound.post 는 그 러너의 열린 런에 묶인다", () => {
  function postFor(input: InboundDeliver, over: Record<string, unknown> = {}) {
    return {
      outboundId: `runner-post:${randomUUID()}`,
      channelId: input.channelId,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      runId: input.runId,
      text: "중간 보고",
      ts: "2026-09-27T00:00:01.000Z",
      ...over,
    };
  }

  async function expectDenied(h: Harness, r: FakeRunner, post: object) {
    expect(await r.post(post)).toMatchObject({ ok: false, code: "FORBIDDEN" });
  }

  it("런의 채널·에이전트·세션 키·스레드·runId 중 하나라도 다르면 거절하고 저장하지 않는다", async () => {
    const h = await setup();
    const r = await readyRunner(h, TOKEN_A, [runnerAgent("coder"), runnerAgent("fin")]);
    const input = await startRun(h, r);
    const root = randomUUID();
    const { runId: _runId, ...withoutRunId } = postFor(input);
    const variants: object[] = [
      // PROBE-1: 다른 채널
      postFor(input, { channelId: CH2 }),
      // PROBE-3: 같은 러너가 맡은 다른 에이전트 이름
      postFor(input, { agentId: "fin" }),
      postFor(input, { sessionKey: dodokSessionKey("coder", CH, root) }),
      postFor(input, { threadId: root }),
      postFor(input, { runId: randomUUID() }),
      withoutRunId,
    ];
    const warnsBefore = h.logs.filter((l) => l.level === "warn").length;
    for (const post of variants) await expectDenied(h, r, post);
    expect(h.outbound).toHaveLength(0);
    expect(h.logs.filter((l) => l.level === "warn").length - warnsBefore).toBe(variants.length);
    // 모든 값이 런과 같으면 받는다
    expect(await r.post(postFor(input))).toMatchObject({ ok: true });
    expect(h.outbound).toHaveLength(1);
  });

  it("스레드 런은 그 스레드 id 를 실어야 받는다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const root = randomUUID();
    const input = await startRun(h, r, { threadId: root, sessionKey: dodokSessionKey("coder", CH, root) });
    // postFor 는 threadId 를 싣지 않는다
    await expectDenied(h, r, postFor(input));
    expect(await r.post(postFor(input, { threadId: root }))).toMatchObject({ ok: true });
    expect(h.outbound).toHaveLength(1);
  });

  it("다른 러너의 살아 있는 런 id 로는 그 런의 값을 모두 맞춰도 못 쓴다", async () => {
    const h = await setup();
    const a = await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    const b = await readyRunner(h, TOKEN_B, [runnerAgent("fin")]);
    const theirs = await startRun(h, b, { agentId: "fin" });
    await expectDenied(h, a, postFor(theirs));
    expect(h.outbound).toHaveLength(0);
  });

  it("PROBE-2: 끝난 런 id 로는 못 쓴다 — 자기 런이든 남의 런이든", async () => {
    const h = await setup();
    const a = await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    const b = await readyRunner(h, TOKEN_B, [runnerAgent("fin")]);
    const mine = await startRun(h, a);
    const theirs = await startRun(h, b, { agentId: "fin" });
    a.send("run.final", { runId: mine.runId, text: "", stopReason: "end_turn", costKind: "api" });
    b.send("run.final", { runId: theirs.runId, text: "", stopReason: "end_turn", costKind: "api" });
    await until(
      () =>
        signals(h, mine.runId).includes("gateway_final") &&
        signals(h, theirs.runId).includes("gateway_final"),
      "finals",
    );
    await expectDenied(h, a, postFor(mine));
    await expectDenied(h, a, postFor(mine, { runId: theirs.runId }));
    expect(h.outbound).toHaveLength(0);
  });

  it("중지한 런에는 못 쓴다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const input = await startRun(h, r);
    await h.adapter.abort(input.runId, input.sessionKey, null);
    await expectDenied(h, r, postFor(input));
    expect(h.outbound).toHaveLength(0);
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
    const resolved = await h.adapter.resolveApproval(
      pending.providerApprovalId,
      "tool",
      "allow-always",
      RUNNER_A_CONNECTION,
    );
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
      h.adapter.resolveApproval(pending.providerApprovalId, "tool", "allow-always", RUNNER_A_CONNECTION),
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
      h.adapter.resolveApproval(pending.providerApprovalId, "tool", "allow-once", RUNNER_A_CONNECTION),
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

  it("중지한 런의 승인 요청은 카드로 만들지 않고 warn 한다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const { runId, sessionKey } = await startRun(h, r);
    await h.adapter.abort(runId, sessionKey, null);
    r.send("approval.requested", {
      providerApprovalId: "perm-late",
      runId,
      sessionKey,
      toolCallId: "t",
      toolName: "Bash",
      summary: "rm",
      canAllowAlways: false,
    });
    const dropped = () => h.logs.filter((l) => l.msg === "runner approval for an aborted run — dropped");
    await until(() => dropped().length === 1, "warn");
    expect(approvals(h)).toEqual([]);
  });

  it("같은 토큰으로 다시 붙은 러너가 옛 승인의 id 를 다시 쓰면 버리고 warn 한다", async () => {
    const h = await setup();
    const first = await readyRunner(h);
    const one = await startRun(h, first);
    await requestApproval(h, first, one.runId, one.sessionKey);
    const second = await readyRunner(h);
    await waitDisconnect(first);
    const two = await startRun(h, second);
    second.send("approval.requested", {
      providerApprovalId: "perm-1",
      runId: two.runId,
      sessionKey: two.sessionKey,
      toolCallId: "toolu_10",
      toolName: "Write",
      summary: "src/b.ts",
      canAllowAlways: true,
    });
    const dropped = () => h.logs.filter((l) => l.msg === "runner approval id already used — dropped");
    await until(() => dropped().length === 1, "warn");
    expect(dropped()[0]?.obj).toMatchObject({ runId: two.runId, providerApprovalId: "perm-1" });
    expect(approvals(h).filter((a) => a.status === "pending")).toHaveLength(1);
  });
});

describe("mayReadAttachment — 러너 토큰의 첨부 읽기 범위(조율자 판정 R5)", () => {
  const TOKEN_A_ID = TOKENS[TOKEN_A]?.tokenId ?? "";
  const TOKEN_B_ID = TOKENS[TOKEN_B]?.tokenId ?? "";
  function image(): InboundDeliver["message"]["attachments"][number] {
    const id = randomUUID();
    return { id, kind: "image", url: artifactUrl(id), name: "shot.png", mime: "image/png", size: 73 };
  }
  function withAttachments(...list: ReturnType<typeof image>[]): Partial<InboundDeliver> {
    const base = deliver();
    return { message: { ...base.message, attachments: list } };
  }

  it("그 토큰의 러너에 열린 런의 deliver 첨부만 true — 다른 토큰·다른 첨부는 false", async () => {
    const h = await setup();
    const a = await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    await readyRunner(h, TOKEN_B, [runnerAgent("fin")]);
    const [shot, other] = [image(), image()];
    await startRun(h, a, withAttachments(shot));
    expect(h.adapter.mayReadAttachment(TOKEN_A_ID, shot.id)).toBe(true);
    expect(h.adapter.mayReadAttachment(TOKEN_B_ID, shot.id)).toBe(false);
    expect(h.adapter.mayReadAttachment(TOKEN_A_ID, other.id)).toBe(false);
  });

  it("런이 run.final·run.error·끊김으로 닫히면 false", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const [f, e, d] = [image(), image(), image()];
    const finalRun = await startRun(h, r, withAttachments(f));
    const errorRun = await startRun(h, r, withAttachments(e));
    await startRun(h, r, withAttachments(d));
    for (const x of [f, e, d]) expect(h.adapter.mayReadAttachment(TOKEN_A_ID, x.id)).toBe(true);

    r.send("run.final", { runId: finalRun.runId, text: "", stopReason: "end_turn", costKind: "api" });
    await until(() => signals(h, finalRun.runId).includes("gateway_final"), "final");
    expect(h.adapter.mayReadAttachment(TOKEN_A_ID, f.id)).toBe(false);

    r.send("run.error", { runId: errorRun.runId, code: "INTERNAL", message: "boom" });
    await until(() => signals(h, errorRun.runId).includes("gateway_error"), "error");
    expect(h.adapter.mayReadAttachment(TOKEN_A_ID, e.id)).toBe(false);
    expect(h.adapter.mayReadAttachment(TOKEN_A_ID, d.id)).toBe(true);

    r.close();
    await until(() => !h.adapter.mayReadAttachment(TOKEN_A_ID, d.id), "disconnect closes the run");
  });

  it("drop 으로 받은 런·forgetRun 한 런의 첨부도 false", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const [dropped, forgotten] = [image(), image()];
    r.onRunStart = (start) => ({ runId: start.deliver.runId, admission: "drop" });
    await h.adapter.send(deliver(withAttachments(dropped)), {
      connectionId: null,
      providerSessionId: SESSION_ID,
    });
    expect(h.adapter.mayReadAttachment(TOKEN_A_ID, dropped.id)).toBe(false);
    r.onRunStart = (start) => ({ runId: start.deliver.runId, admission: "dispatch" });
    const run = await startRun(h, r, withAttachments(forgotten));
    h.adapter.forgetRun?.(run.runId);
    expect(h.adapter.mayReadAttachment(TOKEN_A_ID, forgotten.id)).toBe(false);
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
      connectionId: RUNNER_A_CONNECTION,
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
    const error = await rejection(h.adapter.resolveApproval(id, "tool", "allow-once", RUNNER_A_CONNECTION));
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
    expect(await h.adapter.resetSession(dodokSessionKey("coder", CH), null)).toEqual({});
    expect(await h.adapter.syncChannelConfig(CH, { systemPrompt: "x" }, RUNNER_A_CONNECTION)).toEqual({
      applied: "live",
    });
    expect(h.adapter.sessionKeyFor("coder", CH)).toBe(dodokSessionKey("coder", CH));
    expect(h.adapter.status()).toEqual({ provider: "claude", runners: { connected: 0, tokens: 2 } });
  });
});

describe("러너 프레임 속도 제한 — 소켓마다 버킷, 넘치면 버리고 주소별 1분에 한 번 warn·onLimited", () => {
  const limitWarns = (h: Harness) => h.logs.filter((l) => l.msg === "runner frames rate limited — dropped");

  it("run.event 가 events 버킷을 넘기면 버리고, warn·onLimited 는 1분에 한 번 버린 수와 함께", async () => {
    const h = await setup({ frames: { events: 2, control: 100 } });
    const r = await readyRunner(h);
    const { runId } = await startRun(h, r);
    for (const stepName of ["a", "b", "c", "d"])
      r.send("run.event", { runId, event: { type: "STEP_STARTED", runId, stepName } });
    await until(() => h.limited.length === 1, "onLimited");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runEvents(h, runId)).toEqual([
      { type: "STEP_STARTED", runId, stepName: "a" },
      { type: "STEP_STARTED", runId, stepName: "b" },
    ]);
    expect(h.limited).toEqual([["127.0.0.1", "run.event", 1]]);
    expect(limitWarns(h)).toHaveLength(1);
    expect(limitWarns(h)[0]?.obj).toMatchObject({ address: "127.0.0.1", frame: "run.event", dropped: 1 });

    h.setNow(Date.parse("2026-09-27T00:01:00.000Z"));
    r.send("run.event", { runId, event: { type: "STEP_STARTED", runId, stepName: "e" } });
    await until(() => h.limited.length === 2, "second onLimited");
    // 앞 창에서 말없이 버린 d 까지 센다
    expect(h.limited[1]).toEqual(["127.0.0.1", "run.event", 2]);
    expect(limitWarns(h)).toHaveLength(2);
  });

  it("control 버킷이 비면 outbound.post 는 저장하지 않고 RATE_LIMITED 로 답한다 — run.event 는 제 버킷이라 그대로 흐른다", async () => {
    // hello 가 control 하나를 쓴다
    const h = await setup({ frames: { events: 100, control: 1 } });
    const r = await readyRunner(h);
    const input = await startRun(h, r);
    const ack = await r.post({
      outboundId: `runner-post:${randomUUID()}`,
      channelId: input.channelId,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      runId: input.runId,
      text: "중간 보고",
      ts: "2026-09-27T00:00:01.000Z",
    });
    expect(ack).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(h.outbound).toHaveLength(0);
    r.send("run.event", {
      runId: input.runId,
      event: { type: "STEP_STARTED", runId: input.runId, stepName: "x" },
    });
    await until(() => runEvents(h, input.runId).length === 1, "event");
    expect(h.limited).toEqual([["127.0.0.1", "outbound.post", 1]]);
  });

  /** hello 가 control 하나를 쓰고 넘친 outbound.post 로 control 이 빈 것을 확인한 러너와 그 런 */
  async function drainedControl(h: Harness) {
    const r = await readyRunner(h);
    const input = await startRun(h, r);
    const ack = await r.post({
      outboundId: `runner-post:${randomUUID()}`,
      channelId: input.channelId,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      runId: input.runId,
      text: "중간 보고",
      ts: "2026-09-27T00:00:01.000Z",
    });
    expect(ack).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    return { r, ...input };
  }
  const approvalFrame = (runId: string, sessionKey: string, providerApprovalId: string) => ({
    providerApprovalId,
    runId,
    sessionKey,
    toolCallId: `toolu_${providerApprovalId}`,
    toolName: "Write",
    summary: "src/a.ts",
    canAllowAlways: false,
  });

  it("control 이 빈 뒤에도 열린 런을 가리키는 approval.requested·approval.withdrawn·run.final 은 버킷을 거치지 않는다 — 런이 runMs 까지 매달리지 않는다", async () => {
    const h = await setup({ frames: { events: 100, control: 1 } });
    const { r, runId, sessionKey } = await drainedControl(h);
    r.send("approval.requested", approvalFrame(runId, sessionKey, "perm-1"));
    await until(() => approvals(h).length === 1, "approval");
    expect(approvals(h)[0]).toMatchObject({ status: "pending", toolName: "Write" });
    r.send("approval.withdrawn", { providerApprovalId: "perm-1" });
    await until(() => approvals(h).length === 2, "withdrawn");
    expect(approvals(h)[1]).toMatchObject({ status: "cancelled" });
    r.send("run.final", { runId, text: "끝", stopReason: "end_turn", costKind: "api" });
    await until(() => signals(h, runId).includes("gateway_final"), "final");
    expect(h.outbound.map((m) => m.text)).toEqual(["끝"]);
    expect(h.limited).toEqual([["127.0.0.1", "outbound.post", 1]]);
  });

  it("control 이 빈 뒤에도 열린 런의 run.error 는 런을 닫는다", async () => {
    const h = await setup({ frames: { events: 100, control: 1 } });
    const { r, runId } = await drainedControl(h);
    r.send("run.error", { runId, code: "INTERNAL", message: "boom" });
    await until(() => signals(h, runId).includes("gateway_error"), "error");
    expect(h.limited).toEqual([["127.0.0.1", "outbound.post", 1]]);
  });

  it("열린 런·기다리는 승인을 가리키지 않는 종결·승인 프레임은 control 버킷을 센다", async () => {
    const h = await setup({ frames: { events: 100, control: 1 } });
    const { r, runId, sessionKey } = await drainedControl(h);
    const minute = (n: number) => h.setNow(Date.parse("2026-09-27T00:00:00.000Z") + n * 60_000);
    minute(1);
    r.send("run.final", { runId: randomUUID(), text: "끝", stopReason: "end_turn", costKind: "api" });
    await until(() => h.limited.length === 2, "run.final limited");
    minute(2);
    r.send("run.error", { runId: randomUUID(), code: "INTERNAL", message: "boom" });
    await until(() => h.limited.length === 3, "run.error limited");
    minute(3);
    r.send("approval.withdrawn", { providerApprovalId: "nothing" });
    await until(() => h.limited.length === 4, "withdrawn limited");
    minute(4);
    r.send("approval.requested", approvalFrame(randomUUID(), sessionKey, "perm-x"));
    await until(() => h.limited.length === 5, "requested limited");
    // 이미 쓴 id 를 되풀이하는 요청도 버킷을 센다 — 버킷 밖이면 되풀이마다 warn 줄이 생긴다
    r.send("approval.requested", approvalFrame(runId, sessionKey, "perm-1"));
    await until(() => approvals(h).length === 1, "approval");
    minute(5);
    r.send("approval.requested", approvalFrame(runId, sessionKey, "perm-1"));
    await until(() => h.limited.length === 6, "duplicate limited");
    // 서버가 중지한 런의 새 요청도 — 처리가 카드 없이 버리고 warn 한다
    await h.adapter.abort(runId, sessionKey, null);
    minute(6);
    r.send("approval.requested", approvalFrame(runId, sessionKey, "perm-2"));
    await until(() => h.limited.length === 7, "aborted run limited");
    expect(h.limited.map(([, frame]) => frame)).toEqual([
      "outbound.post",
      "run.final",
      "run.error",
      "approval.withdrawn",
      "approval.requested",
      "approval.requested",
      "approval.requested",
    ]);
    expect(
      approvals(h)
        .filter((a) => a.status === "pending")
        .map((a) => a.toolCallId),
    ).toEqual(["toolu_perm-1"]);
  });

  it(`한 런이 버킷 밖으로 받은 승인 요청이 ${RUN_FREE_APPROVALS}개면 그다음 approval.requested 는 control 버킷을 센다`, async () => {
    const h = await setup({ frames: { events: 100, control: 1 } });
    const { r, runId, sessionKey } = await drainedControl(h);
    h.setNow(Date.parse("2026-09-27T00:01:00.000Z"));
    for (let i = 0; i <= RUN_FREE_APPROVALS; i++)
      r.send("approval.requested", approvalFrame(runId, sessionKey, `perm-${i}`));
    await until(() => h.limited.length === 2, "limited");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(approvals(h)).toHaveLength(RUN_FREE_APPROVALS);
    expect(h.limited[1]).toEqual(["127.0.0.1", "approval.requested", 1]);
  });

  it(`버킷 밖 승인 요청은 런마다 누계 ${RUN_FREE_APPROVALS}개 — 요청·철회를 되풀이해도 그다음 요청은 control 버킷을 센다`, async () => {
    const h = await setup({ frames: { events: 100, control: 1 } });
    const { r, runId, sessionKey } = await drainedControl(h);
    h.setNow(Date.parse("2026-09-27T00:01:00.000Z"));
    for (let i = 0; i < RUN_FREE_APPROVALS; i++) {
      r.send("approval.requested", approvalFrame(runId, sessionKey, `cyc-${i}`));
      r.send("approval.withdrawn", { providerApprovalId: `cyc-${i}` });
    }
    r.send("approval.requested", approvalFrame(runId, sessionKey, `cyc-${RUN_FREE_APPROVALS}`));
    await until(() => h.limited.length === 2, "limited");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(approvals(h)).toHaveLength(RUN_FREE_APPROVALS * 2);
    expect(approvals(h).filter((a) => a.status === "pending")).toHaveLength(RUN_FREE_APPROVALS);
    expect(h.limited[1]).toEqual(["127.0.0.1", "approval.requested", 1]);
  });

  it("열린 런을 가리켜도 처리기가 버릴 프레임(계약 위반·세션 키 불일치·모르는 오류 코드·끝난 승인의 철회)은 control 버킷을 센다", async () => {
    const h = await setup({ frames: { events: 100, control: 1 } });
    const { r, runId, sessionKey } = await drainedControl(h);
    const minute = (n: number) => h.setNow(Date.parse("2026-09-27T00:00:00.000Z") + n * 60_000);
    minute(1);
    // stopReason·costKind 가 없다
    r.send("run.final", { runId, text: "끝" });
    await until(() => h.limited.length === 2, "invalid run.final limited");
    minute(2);
    r.send("approval.requested", {
      ...approvalFrame(runId, sessionKey, "perm-1"),
      sessionKey: dodokSessionKey("coder", randomUUID()),
    });
    await until(() => h.limited.length === 3, "session mismatch limited");
    minute(3);
    r.send("run.error", { runId, code: "NOPE", message: "boom" });
    await until(() => h.limited.length === 4, "unknown code limited");
    minute(4);
    r.send("approval.withdrawn", { providerApprovalId: 7 });
    await until(() => h.limited.length === 5, "invalid withdrawn limited");
    minute(5);
    const { toolName: _, ...noToolName } = approvalFrame(runId, sessionKey, "perm-2");
    r.send("approval.requested", noToolName);
    await until(() => h.limited.length === 6, "invalid requested limited");
    // 끝난 승인의 철회는 기다리는 승인이 아니다
    r.send("approval.requested", approvalFrame(runId, sessionKey, "perm-3"));
    r.send("approval.withdrawn", { providerApprovalId: "perm-3" });
    await until(() => approvals(h).length === 2, "withdrawn");
    minute(6);
    r.send("approval.withdrawn", { providerApprovalId: "perm-3" });
    await until(() => h.limited.length === 7, "settled withdrawn limited");
    expect(h.limited.map(([, frame]) => frame)).toEqual([
      "outbound.post",
      "run.final",
      "approval.requested",
      "run.error",
      "approval.withdrawn",
      "approval.requested",
      "approval.withdrawn",
    ]);
    expect(approvals(h).map((a) => a.status)).toEqual(["pending", "cancelled"]);
    expect(signals(h, runId)).toEqual([]);
  });

  it("다른 러너의 열린 런을 가리키는 run.final·approval.requested 는 control 버킷을 센다", async () => {
    const h = await setup({ frames: { events: 100, control: 1 } });
    const b = await readyRunner(h, TOKEN_B, [runnerAgent("writer")]);
    const other = await startRun(h, b, { agentId: "writer", sessionKey: dodokSessionKey("writer", CH) });
    const { r } = await drainedControl(h);
    const minute = (n: number) => h.setNow(Date.parse("2026-09-27T00:00:00.000Z") + n * 60_000);
    minute(1);
    r.send("run.final", { runId: other.runId, text: "끝", stopReason: "end_turn", costKind: "api" });
    await until(() => h.limited.length === 2, "run.final limited");
    minute(2);
    r.send("approval.requested", approvalFrame(other.runId, other.sessionKey, "perm-1"));
    await until(() => h.limited.length === 3, "approval.requested limited");
    expect(h.limited.map(([, frame]) => frame)).toEqual(["outbound.post", "run.final", "approval.requested"]);
    expect(signals(h, other.runId)).toEqual([]);
    expect(approvals(h)).toEqual([]);
  });

  it("버킷을 거치지 않는 프레임은 control 을 쓰지 않는다 — 그 뒤 outbound.post 가 통과한다", async () => {
    // hello 가 하나, 남은 하나를 post 가 쓴다
    const h = await setup({ frames: { events: 100, control: 2 } });
    const r = await readyRunner(h);
    const input = await startRun(h, r);
    const second = await startRun(h, r);
    r.send("approval.requested", approvalFrame(input.runId, input.sessionKey, "perm-1"));
    r.send("approval.withdrawn", { providerApprovalId: "perm-1" });
    r.send("run.error", { runId: second.runId, code: "INTERNAL", message: "boom" });
    await until(() => signals(h, second.runId).includes("gateway_error"), "error");
    const ack = await r.post({
      outboundId: `runner-post:${randomUUID()}`,
      channelId: input.channelId,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      runId: input.runId,
      text: "중간 보고",
      ts: "2026-09-27T00:00:01.000Z",
    });
    expect(ack).toMatchObject({ ok: true });
    expect(approvals(h).map((a) => a.status)).toEqual(["pending", "cancelled"]);
    expect(h.limited).toEqual([]);
  });

  it("control 버킷이 세는 프레임은 hello·outbound.post·control.call 과 처리기가 받아들이지 않을 종결·승인 프레임과 누계를 넘은 승인 요청, events 는 run.event 뿐", () => {
    expect(FRAME_BUCKET).toEqual({
      hello: "control",
      "run.event": "events",
      "run.final": "control",
      "run.error": "control",
      "outbound.post": "control",
      "approval.requested": "control",
      "approval.withdrawn": "control",
      "control.call": "control",
    });
  });

  it("버킷은 소켓마다 — 다른 러너는 자기 버킷을 쓴다", async () => {
    const h = await setup({ frames: { events: 1, control: 100 } });
    const a = await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    const b = await readyRunner(h, TOKEN_B, [runnerAgent("writer")]);
    const one = await startRun(h, a);
    const two = await startRun(h, b, { agentId: "writer", sessionKey: dodokSessionKey("writer", CH) });
    a.send("run.event", {
      runId: one.runId,
      event: { type: "STEP_STARTED", runId: one.runId, stepName: "a" },
    });
    b.send("run.event", {
      runId: two.runId,
      event: { type: "STEP_STARTED", runId: two.runId, stepName: "b" },
    });
    await until(() => runEvents(h, one.runId).length === 1 && runEvents(h, two.runId).length === 1, "events");
    expect(h.limited).toEqual([]);
  });
});

describe("에이전트↔러너 토큰 묶임 — 묶인 에이전트는 그 토큰의 러너만 맡는다", () => {
  const A_ID = TOKENS[TOKEN_A]?.tokenId ?? "";
  const B_ID = TOKENS[TOKEN_B]?.tokenId ?? "";

  it("B 에 묶인 coder 는 먼저 붙은 A 가 알려도 B 가 맡고, A 의 coder 가 충돌이다", async () => {
    const h = await setup({ bound: { coder: B_ID } });
    const a = await h.runner(TOKEN_A, [runnerAgent("coder")]);
    expect(await a.hello()).toMatchObject({ ok: true, conflicts: ["coder"] });
    const b = await h.runner(TOKEN_B, [runnerAgent("coder")]);
    expect(await b.hello()).toMatchObject({ ok: true, conflicts: [] });
    expect(
      h.adapter
        .setupDetail()
        .runners.map((c) => [c.label, c.agents.map((x) => [x.conflict, x.boundTokenId])]),
    ).toEqual([
      ["laptop", [[true, B_ID]]],
      ["desktop", [[false, B_ID]]],
    ]);
    expect(h.adapter.servingTokenId("coder")).toBe(B_ID);
    const input = await startRun(h, b);
    expect(b.runStarts[0]?.deliver.runId).toBe(input.runId);
    expect(a.runStarts).toHaveLength(0);
  });

  it("묶인 토큰의 러너가 없으면 다른 토큰 러너가 알려도 맡지 않는다 — send 는 ADAPTER_UNAVAILABLE, 목록에도 없다", async () => {
    const h = await setup({ bound: { coder: B_ID } });
    await readyRunner(h, TOKEN_A, [runnerAgent("coder"), runnerAgent("writer")]);
    const error = await rejection(
      h.adapter.send(deliver(), { connectionId: null, providerSessionId: SESSION_ID }),
    );
    expect(error.code).toBe("ADAPTER_UNAVAILABLE");
    expect(h.adapter.servingTokenId("coder")).toBeUndefined();
    expect((await h.adapter.listAgents(null)).map((x) => x.providerAgentId)).toEqual(["writer"]);
  });

  it("묶임 없는 등록 에이전트는 처음 알린 러너에 묶이고, 그 러너가 빠져도 다른 토큰 러너가 이어받지 않는다", async () => {
    const h = await setup({ bound: { coder: null } });
    const a = await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    expect(h.bound.get("coder")).toBe(A_ID);
    expect(h.logs.some((l) => l.msg === "runner agent bound")).toBe(true);
    const b = await h.runner(TOKEN_B, [runnerAgent("coder")]);
    expect(await b.hello()).toMatchObject({ ok: true, conflicts: ["coder"] });

    const aClosed = waitDisconnect(a);
    a.close();
    await aClosed;
    await until(() => h.adapter.status().runners.connected === 1, "runner a gone");
    expect(h.bound.get("coder")).toBe(A_ID);
    expect(h.adapter.setupDetail().runners[0]?.agents[0]?.conflict).toBe(true);
    const error = await rejection(
      h.adapter.send(deliver(), { connectionId: null, providerSessionId: SESSION_ID }),
    );
    expect(error.code).toBe("ADAPTER_UNAVAILABLE");
    expect(b.runStarts).toHaveLength(0);

    // 같은 토큰으로 돌아오면 다시 맡는다
    const a2 = await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    const input = await startRun(h, a2);
    expect(a2.runStarts[0]?.deliver.runId).toBe(input.runId);
  });

  it("미등록 id 는 묶지 않는다 — 옛 규칙(먼저 hello 한 러너)", async () => {
    const h = await setup();
    await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    expect(h.bound.has("coder")).toBe(false);
    expect(h.adapter.setupDetail().runners[0]?.agents[0]?.boundTokenId).toBeNull();
    expect(h.adapter.servingTokenId("coder")).toBe(A_ID);
  });

  it("러너가 빠진 뒤 이어받은 러너가 그사이 등록된(묶임 없는) 에이전트를 묶는다", async () => {
    const h = await setup();
    const a = await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    await readyRunner(h, TOKEN_B, [runnerAgent("coder")]);
    h.bound.set("coder", null); // A 가 붙은 뒤 등록됐는데 묶임이 비었다(등록 때 맡는 러너를 못 봤다)
    const aClosed = waitDisconnect(a);
    a.close();
    await aClosed;
    await until(() => h.bound.get("coder") === B_ID, "claimed by b");
  });

  it("묶임을 읽다 던지면 아무 러너도 맡지 않는다 — 다른 토큰 러너로 새지 않는다", async () => {
    const h = await setup();
    await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    h.bound.set("coder", A_ID);
    const original = h.bound.get.bind(h.bound);
    h.bound.get = (key: string) => {
      if (key === "coder") throw new Error("db is locked");
      return original(key);
    };
    expect(h.adapter.servingTokenId("coder")).toBeUndefined();
    expect(h.adapter.setupDetail().runners[0]?.agents[0]).toMatchObject({
      conflict: true,
      boundTokenId: null,
    });
    expect(h.logs.some((l) => l.level === "error" && l.msg === "runner agent binding lookup failed")).toBe(
      true,
    );
  });
});

describe("연결 id — 러너 토큰 id 가 send 결과·이벤트·정본에 실린다(멀티 Gateway 스펙 「어댑터 계약」 절)", () => {
  it("묶임 없는 에이전트(연결 null)는 먼저 알린 러너가 맡고, 그 러너의 토큰 id 가 결과·이벤트·정본 훅에 실린다", async () => {
    const h = await setup();
    const r = await readyRunner(h, TOKEN_B);
    const tokenB = TOKENS[TOKEN_B]?.tokenId ?? "";
    const input = await startRun(h, r);
    const { runId } = input;
    r.send("run.event", {
      runId,
      event: { type: "TEXT_MESSAGE_START", runId, messageId: "m1", role: "assistant" },
    });
    r.send("run.final", { runId, text: "끝", stopReason: "end_turn", costKind: "subscription_estimate" });
    await until(() => signals(h, runId).includes("gateway_final"), "final");
    const ofRun = h.events.flatMap((e) =>
      (e.kind === "run_event" || e.kind === "run_signal") && e.runId === runId ? [e.connectionId] : [],
    );
    expect(ofRun.length).toBeGreaterThan(0);
    expect(new Set(ofRun)).toEqual(new Set([tokenB]));
    expect(h.outboundConnections).toEqual([tokenB]);
  });

  it("send 결과의 connectionId 는 맡은 러너의 토큰 id, 다른 토큰을 연결로 주면 ADAPTER_UNAVAILABLE", async () => {
    const h = await setup();
    await readyRunner(h, TOKEN_B);
    const tokenB = TOKENS[TOKEN_B]?.tokenId ?? "";
    const result = await h.adapter.send(deliver(), { connectionId: tokenB, providerSessionId: SESSION_ID });
    expect(result).toMatchObject({ admission: "dispatch", connectionId: tokenB });
    const error = await rejection(
      h.adapter.send(deliver(), { connectionId: RUNNER_A_CONNECTION, providerSessionId: SESSION_ID }),
    );
    expect(error.code).toBe("ADAPTER_UNAVAILABLE");
  });

  it("listAgents 는 연결을 주면 그 토큰의 러너가 알린 것만, null 이면 전부", async () => {
    const h = await setup();
    await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    await readyRunner(h, TOKEN_B, [runnerAgent("writer")]);
    const ids = async (connectionId: string | null) =>
      (await h.adapter.listAgents(connectionId)).map((a) => a.providerAgentId).sort();
    expect(await ids(null)).toEqual(["coder", "writer"]);
    expect(await ids(RUNNER_A_CONNECTION)).toEqual(["coder"]);
    expect(await ids(TOKENS[TOKEN_B]?.tokenId ?? "")).toEqual(["writer"]);
  });
});

describe("control.call", () => {
  const call = (runId: string, over: Record<string, unknown> = {}) => ({
    callId: randomUUID(),
    runId,
    tool: "get_channel",
    args: { channelId: CH },
    ...over,
  });
  const emit = (r: FakeRunner, payload: unknown) =>
    r.socket.emitWithAck("control.call", payload) as Promise<ControlResult>;

  it("그 러너의 열린 런이면 서버 콜백(연결 id = 러너 토큰 id)으로 가고 ack 가 그 결과다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const input = await startRun(h, r);
    const payload = call(input.runId);
    expect(await emit(r, payload)).toEqual({ ok: true, data: payload });
    expect(h.controlCalls).toEqual([[RUNNER_A_CONNECTION, payload]]);
  });

  it("콜백이 늦게 끝나면(확인 카드 대기) ack 도 그때까지 미룬다", async () => {
    let finish!: (result: ControlResult) => void;
    const h = await setup({
      control: () =>
        new Promise<ControlResult>((resolve) => {
          finish = resolve;
        }),
    });
    const r = await readyRunner(h);
    const input = await startRun(h, r);
    let acked: ControlResult | undefined;
    const pending = emit(r, call(input.runId, { tool: "update_channel" })).then((result) => {
      acked = result;
      return result;
    });
    await until(() => h.controlCalls.length === 1, "control callback");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(acked).toBeUndefined();
    finish({ ok: false, error: { code: "EXPIRED", message: "카드가 만료됐습니다" } });
    expect(await pending).toEqual({ ok: false, error: { code: "EXPIRED", message: "카드가 만료됐습니다" } });
  });

  it("남의 런·모르는 런·끝난 런의 이름이면 콜백을 부르지 않고 NOT_FOUND [Review Focus 4]", async () => {
    const h = await setup();
    const a = await readyRunner(h, TOKEN_A, [runnerAgent("coder")]);
    const b = await readyRunner(h, TOKEN_B, [runnerAgent("fin")]);
    const theirs = await startRun(h, b, { agentId: "fin", sessionKey: dodokSessionKey("fin", CH) });
    const mine = await startRun(h, a);
    a.send("run.final", { runId: mine.runId, text: "답", stopReason: "end_turn", costKind: "api" });
    await until(() => signals(h, mine.runId).includes("gateway_final"), "final");
    for (const runId of [theirs.runId, randomUUID(), mine.runId])
      expect(await emit(a, call(runId))).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(h.controlCalls).toEqual([]);
  });

  it("모양이 틀리면 VALIDATION, 콜백이 던지면 INTERNAL", async () => {
    const h = await setup({
      control: async () => {
        throw new Error("db is locked");
      },
    });
    const r = await readyRunner(h);
    const input = await startRun(h, r);
    expect(await emit(r, { runId: input.runId, tool: "get_channel" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    expect(await emit(r, call(input.runId))).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });

  it("서버가 제어 도구를 처리하지 않으면(콜백 없음) ADAPTER_UNAVAILABLE", async () => {
    const bare = await setup({ control: null });
    const r2 = await readyRunner(bare);
    const input2 = await startRun(bare, r2);
    expect(await emit(r2, call(input2.runId))).toMatchObject({
      ok: false,
      error: { code: "ADAPTER_UNAVAILABLE" },
    });
  });

  it("control 버킷을 센다 — 비면 콜백 없이 RATE_LIMITED", async () => {
    // hello 가 control 하나를 쓴다
    const h = await setup({ frames: { events: 100, control: 1 } });
    const r = await readyRunner(h);
    const input = await startRun(h, r);
    expect(await emit(r, call(input.runId))).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(h.controlCalls).toEqual([]);
    expect(h.limited).toEqual([["127.0.0.1", "control.call", 1]]);
  });

  it("모르는 프레임으로 warn 하지 않는다", async () => {
    const h = await setup();
    const r = await readyRunner(h);
    const input = await startRun(h, r);
    await emit(r, call(input.runId));
    expect(h.logs.filter((l) => l.msg?.includes("unknown frame"))).toEqual([]);
  });
});

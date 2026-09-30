import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  RUNNER_NAMESPACE,
  RUNNER_PROTOCOL,
  RunnerApprovalRequested,
  RunnerApprovalWithdrawn,
  RunnerHello,
  RunnerOutboundPost,
  type RunnerOutboundAck,
  RunnerRunAck,
  RunnerRunError,
  RunnerRunEvent,
  RunnerRunFinal,
  type RunnerClientToServerEvents,
  type RunnerHelloResult,
  type RunnerServerToClientEvents,
} from "@dodok/shared";
import { Server, type Socket } from "socket.io";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedRunnerConfig } from "../src/config";
import { createRunBridge, startRunnerConnection, type RunnerConnection } from "../src/connection";
import { createFakeSdk, script, type FakeSdk } from "./helpers/fake-query";
import { AGENT, RUN_ID, runStart } from "./helpers/fixtures";

// 태스크 3 의 러너 어댑터 대신 shared 러너 계약(RUNNER_NAMESPACE·이벤트 Zod)으로 말하는 가짜 서버.
// 실제 어댑터와 붙이는 시험은 태스크 3 병합 뒤 따로 한다
const TOKEN = "drn_test_token_value_0123456789abcdefghijklmn";
const RUN_2 = "0192f000-0000-7000-8000-00000000a002";
const SESSION_2 = "0192f000-0000-4000-8000-00000000e002";

type ServerSocket = Socket<RunnerClientToServerEvents, RunnerServerToClientEvents>;

type FakeServer = {
  url: string;
  hellos: RunnerHello[];
  events: RunnerRunEvent[];
  finals: RunnerRunFinal[];
  errors: RunnerRunError[];
  posts: RunnerOutboundPost[];
  approvals: RunnerApprovalRequested[];
  withdrawn: RunnerApprovalWithdrawn[];
  postAck: RunnerOutboundAck;
  sockets: ServerSocket[];
  helloResult: RunnerHelloResult;
  /** n 번째(0부터) 핸드셰이크를 미들웨어에서 거절할 사유 — 없으면 토큰만 본다 */
  reject?: (attempt: number) => string | undefined;
  handshakes: number;
  close(): Promise<void>;
};

async function startFakeServer(): Promise<FakeServer> {
  const http: HttpServer = createServer();
  const io = new Server<RunnerClientToServerEvents, RunnerServerToClientEvents>(http);
  const server: FakeServer = {
    url: "",
    hellos: [],
    events: [],
    finals: [],
    errors: [],
    posts: [],
    approvals: [],
    withdrawn: [],
    postAck: { ok: true, messageId: "0192f000-0000-7000-8000-0000000000aa" },
    sockets: [],
    helloResult: { ok: true, serverVersion: "test", conflicts: [] },
    handshakes: 0,
    close: async () => {
      await io.close();
    },
  };
  const ns = io.of(RUNNER_NAMESPACE);
  ns.use((socket, next) => {
    const attempt = server.handshakes++;
    const reason = server.reject?.(attempt);
    if (reason) return next(new Error(reason));
    next(socket.handshake.auth.token === TOKEN ? undefined : new Error("UNAUTHORIZED"));
  });
  ns.on("connection", (socket) => {
    server.sockets.push(socket);
    socket.on("hello", (p, ack) => {
      server.hellos.push(RunnerHello.parse(p));
      ack(server.helloResult);
    });
    socket.on("run.event", (p) => void server.events.push(RunnerRunEvent.parse(p)));
    socket.on("run.final", (p) => void server.finals.push(RunnerRunFinal.parse(p)));
    socket.on("run.error", (p) => void server.errors.push(RunnerRunError.parse(p)));
    socket.on("outbound.post", (p, ack) => {
      server.posts.push(RunnerOutboundPost.parse(p));
      ack(server.postAck);
    });
    socket.on("approval.requested", (p) => void server.approvals.push(RunnerApprovalRequested.parse(p)));
    socket.on("approval.withdrawn", (p) => void server.withdrawn.push(RunnerApprovalWithdrawn.parse(p)));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  server.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
  return server;
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("기다린 조건이 오지 않았다");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(
  opts: {
    maxConcurrentRuns?: number;
    token?: string;
    stopWaitMs?: number;
    reject?: FakeServer["reject"];
    /** onFatal 이 불린 그 순간을 보려고 — fatal 목록에 넣은 뒤 부른다 */
    onFatal?: (code: number) => void;
  } = {},
) {
  const server = await startFakeServer();
  server.reject = opts.reject;
  cleanups.push(() => server.close());
  const fake: FakeSdk = createFakeSdk();
  const logs: string[] = [];
  const fatal: number[] = [];
  const config: ResolvedRunnerConfig = {
    serverUrl: server.url,
    claudeConfigDir: "/home/u/.dodok-runner/claude",
    maxConcurrentRuns: opts.maxConcurrentRuns ?? 3,
    agents: [AGENT],
  };
  const conn: RunnerConnection = startRunnerConnection({
    config,
    token: opts.token ?? TOKEN,
    sdk: fake,
    versions: {
      runnerVersion: "0.0.0",
      sdkVersion: "0.3.283",
      claudeCodeVersion: "2.1.283",
      bundleSha256: null,
    },
    baseEnv: { PATH: "/usr/bin" },
    logger: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
    },
    onFatal: (code) => {
      fatal.push(code);
      opts.onFatal?.(code);
    },
    backoff: { minMs: 20, maxMs: 50 },
    closeGraceMs: 30,
    ...(opts.stopWaitMs === undefined ? {} : { stopWaitMs: opts.stopWaitMs }),
  });
  cleanups.push(() => conn.stop());
  return { server, fake, logs, fatal, conn };
}

const sendStart = (socket: ServerSocket, start: ReturnType<typeof runStart>) =>
  socket
    .timeout(2000)
    .emitWithAck("run.start", start)
    .then((a) => RunnerRunAck.parse(a));

describe("startRunnerConnection", () => {
  it("붙으면 hello — 에이전트는 라벨만, 경로 원문·토큰 없음", async () => {
    const { server, logs } = await setup();
    await waitFor(() => server.hellos.length === 1);
    const hello = server.hellos[0]!;
    expect(hello).toMatchObject({
      runnerProtocol: RUNNER_PROTOCOL,
      runnerVersion: "0.0.0",
      sdkVersion: "0.3.283",
      claudeCodeVersion: "2.1.283",
      bundleSha256: null,
      agents: [{ id: "coder", name: "코더", model: "sonnet", workdirLabel: "my-repo" }],
    });
    expect(hello.capabilities).toEqual(["threads", "interrupt", "approvals", "attachments"]);
    expect(JSON.stringify(hello)).not.toContain(AGENT.workdir);
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(AGENT.workdir);
  });

  it("run.start → 가짜 query 대본 → 서버가 run.event·run.final 을 받는다", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.sockets.length === 1 && server.hellos.length === 1);
    fake.script(script.init(), ...script.textTurn("msg_1", ["안녕 ", "하세요"]));
    const ack = await sendStart(server.sockets[0]!, runStart());
    expect(ack).toEqual({ runId: RUN_ID, admission: "dispatch" });
    await waitFor(() => server.finals.length === 1);
    expect(server.events.map((e) => e.event.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
    ]);
    expect(server.events.every((e) => e.runId === RUN_ID && e.event.runId === RUN_ID)).toBe(true);
    expect(server.finals[0]).toMatchObject({
      runId: RUN_ID,
      text: "안녕 하세요",
      costKind: "subscription_estimate",
    });
    expect(fake.calls[0]!.options.cwd).toBe(AGENT.workdir);
  });

  it("hello 거절(PROTOCOL_MISMATCH) → 사유를 남기고 종료 코드 2, 다시 붙지 않는다", async () => {
    const server = await startFakeServer();
    cleanups.push(() => server.close());
    server.helloResult = { ok: false, code: "PROTOCOL_MISMATCH", message: "runner protocol 2 != 1" };
    const fake = createFakeSdk();
    const logs: string[] = [];
    const fatal: number[] = [];
    const conn = startRunnerConnection({
      config: { serverUrl: server.url, claudeConfigDir: "/c", maxConcurrentRuns: 1, agents: [AGENT] },
      token: TOKEN,
      sdk: fake,
      versions: { runnerVersion: "0.0.0", sdkVersion: "x", claudeCodeVersion: "y", bundleSha256: null },
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
      onFatal: (code) => fatal.push(code),
      backoff: { minMs: 10, maxMs: 20 },
    });
    cleanups.push(() => conn.stop());
    await waitFor(() => fatal.length === 1);
    expect(fatal).toEqual([2]);
    expect(logs.join("\n")).toMatch(/PROTOCOL_MISMATCH/);
    expect(logs.join("\n")).toMatch(/판본/);
    await new Promise((r) => setTimeout(r, 80));
    expect(server.hellos).toHaveLength(1);
  });

  it("계약 밖 hello 거절 코드(RATE_LIMITED 등)는 끝내지 않고 백오프로 다시 붙는다 — hello 거절은 판본 불일치뿐 [최종 리뷰 M3]", async () => {
    const { server, fatal, logs } = await setup();
    server.helloResult = {
      ok: false,
      code: "RATE_LIMITED",
      message: "slow down",
    } as unknown as RunnerHelloResult;
    await waitFor(() => server.hellos.length >= 2);
    expect(fatal).toEqual([]);
    expect(logs.join("\n")).toMatch(/hello 실패/);
    server.helloResult = { ok: true, serverVersion: "test", conflicts: [] };
    const before = server.hellos.length;
    await waitFor(() => logs.some((l) => l.includes("연결됨")));
    expect(server.hellos.length).toBeGreaterThan(before);
    expect(fatal).toEqual([]);
  });

  it("전송이 끊기면(transport close) 도는 런의 interrupt 가 불린다(Review Focus 1) — 그리고 다시 붙는다", async () => {
    const { server, fake, fatal } = await setup();
    await waitFor(() => server.hellos.length === 1);
    fake.script(script.messageStart("msg_1"), { waitInterrupt: [] }, { hang: true });
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => fake.calls.length === 1);
    // 엔진 소켓을 닫는다 — 서버 종료(러너 어댑터 close 는 DISCONNECT 패킷 없이 전송만 닫는다)·재시작·네트워크 끊김과
    // 같은 클라이언트 사유(transport close)
    server.sockets[0]!.conn.close();
    await waitFor(() => fake.calls[0]!.interrupts === 1);
    // 유예 뒤 close 까지 — CLI 가 남지 않는다
    await waitFor(() => fake.calls[0]!.closes >= 1);
    await waitFor(() => server.hellos.length === 2);
    expect(fatal).toEqual([]);
    // 끊긴 사이 낸 final 은 새 연결로 몰려 나가지 않는다(서버는 그 런을 ADAPTER_UNAVAILABLE 로 닫았다)
    await new Promise((r) => setTimeout(r, 40));
    expect(server.finals).toEqual([]);
    expect(server.errors).toEqual([]);
  });

  it("서버가 끊으면(io server disconnect) 다시 붙지 않고 사유를 남긴 뒤 종료 코드 2 — 같은 토큰의 두 러너가 서로 밀어내지 않는다(리뷰 I2)", async () => {
    const { server, fake, fatal, logs } = await setup();
    await waitFor(() => server.hellos.length === 1);
    fake.script(script.messageStart("msg_1"), { waitInterrupt: [] }, { hang: true });
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => fake.calls.length === 1);
    server.sockets[0]!.disconnect(true);
    await waitFor(() => fatal.length === 1);
    expect(fatal).toEqual([2]);
    expect(fake.calls[0]!.interrupts).toBe(1);
    expect(logs.join("\n")).toContain(
      "서버가 이 러너 연결을 끊었습니다 — 같은 토큰으로 다른 러너가 붙었거나 토큰이 폐기됐습니다",
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(server.hellos).toHaveLength(1);
  });

  it("서버가 끊으면 stop() 처럼 도는 CLI 가 턴을 닫을 때까지 기다린 뒤 종료한다 — 곧바로 끝나면 CLI 가 고아로 남는다 [최종 리뷰 P1]", async () => {
    const finishedAtFatal: boolean[] = [];
    let call: FakeSdk["calls"][number] | undefined;
    const { server, fake, fatal } = await setup({
      onFatal: () => finishedAtFatal.push(call?.finished ?? false),
    });
    await waitFor(() => server.hellos.length === 1);
    // interrupt 뒤 턴을 닫는 데 200ms 걸리는 CLI
    fake.script(
      script.messageStart("msg_1"),
      { waitInterrupt: [] },
      { sleep: 200 },
      script.errorResult("error_during_execution", ["x"]),
    );
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => fake.calls.length === 1);
    call = fake.calls[0];
    server.sockets[0]!.disconnect(true);
    await waitFor(() => fatal.length === 1, 3000);
    expect(fatal).toEqual([2]);
    expect(call!.interrupts).toBe(1);
    expect(finishedAtFatal).toEqual([true]);
  });

  it("서버가 끊은 뒤 CLI 가 끝나지 않아도 종료 기다림은 stopWaitMs 까지만 [최종 리뷰 P1]", async () => {
    const { server, fake, fatal } = await setup({ stopWaitMs: 60 });
    await waitFor(() => server.hellos.length === 1);
    fake.script(script.messageStart("msg_1"), { sleep: 1500 });
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => fake.calls.length === 1);
    const t0 = Date.now();
    server.sockets[0]!.disconnect(true);
    await waitFor(() => fatal.length === 1);
    expect(Date.now() - t0).toBeLessThan(600);
    expect(fake.calls[0]!.finished).toBe(false);
  });

  it("설정에 없는 agentId 의 run.start → run.error NOT_FOUND", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    const ack = await sendStart(server.sockets[0]!, runStart({ agentId: "ghost" }));
    // drop 이면 어댑터가 런을 놓아 뒤이은 run.error 를 버린다 — 오류 카드가 사라진다(리뷰 M1)
    expect(ack).toEqual({ runId: RUN_ID, admission: "dispatch" });
    await waitFor(() => server.errors.length === 1);
    expect(server.errors[0]).toMatchObject({ runId: RUN_ID, code: "NOT_FOUND" });
    expect(fake.calls).toEqual([]);
  });

  it("같은 세션이 돌고 있으면 run.error CONFLICT", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    fake.script({ hang: true });
    await sendStart(server.sockets[0]!, runStart());
    expect(await sendStart(server.sockets[0]!, runStart({ runId: RUN_2 }))).toEqual({
      runId: RUN_2,
      admission: "dispatch",
    });
    await waitFor(() => server.errors.length === 1);
    expect(server.errors[0]).toMatchObject({ runId: RUN_2, code: "CONFLICT" });
  });

  it("동시 상한을 넘으면 ack 에 queuedPosition", async () => {
    const { server, fake } = await setup({ maxConcurrentRuns: 1 });
    await waitFor(() => server.hellos.length === 1);
    fake.script({ hang: true });
    expect(await sendStart(server.sockets[0]!, runStart())).toEqual({ runId: RUN_ID, admission: "dispatch" });
    expect(await sendStart(server.sockets[0]!, runStart({ runId: RUN_2, sessionId: SESSION_2 }))).toEqual({
      runId: RUN_2,
      admission: "dispatch",
      queuedPosition: 1,
    });
  });

  it("run.abort → interrupt, 끝난 턴은 run.final aborted 로 알린다 — run.event 로 수명을 내지 않는다(판정 R1)", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    fake.script(script.messageStart("msg_1"), {
      waitInterrupt: [script.errorResult("error_during_execution", ["[ede_diagnostic]"])],
    });
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => fake.calls.length === 1);
    server.sockets[0]!.emit("run.abort", { runId: RUN_ID });
    await waitFor(() => server.finals.length === 1);
    expect(server.finals[0]).toMatchObject({ runId: RUN_ID, text: "", stopReason: "aborted" });
    expect(fake.calls[0]!.interrupts).toBe(1);
    expect(server.events.filter((e) => e.event.type.startsWith("RUN_"))).toEqual([]);
    expect(server.errors).toEqual([]);
  });

  it("대기열에서 중지된 런도 run.final aborted 로 닫는다 — CLI 는 띄우지 않는다", async () => {
    const { server, fake } = await setup({ maxConcurrentRuns: 1 });
    await waitFor(() => server.hellos.length === 1);
    fake.script({ hang: true });
    await sendStart(server.sockets[0]!, runStart());
    await sendStart(server.sockets[0]!, runStart({ runId: RUN_2, sessionId: SESSION_2 }));
    server.sockets[0]!.emit("run.abort", { runId: RUN_2 });
    await waitFor(() => server.finals.length === 1);
    expect(server.finals[0]).toEqual({
      runId: RUN_2,
      text: "",
      stopReason: "aborted",
      costKind: "subscription_estimate",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("틀린·폐기된 토큰(UNAUTHORIZED) — 사유(토큰 발급 안내)를 남기고 종료 코드 2, 다시 붙지 않는다(리뷰 I3)", async () => {
    const wrong = "drn_wrong_token_value_zzzzzzzzzzzzzzzzzzzzzzzzz";
    const { server, logs, fatal } = await setup({ token: wrong });
    await waitFor(() => fatal.length === 1);
    expect(fatal).toEqual([2]);
    expect(logs.join("\n")).toMatch(/UNAUTHORIZED/);
    expect(logs.join("\n")).toMatch(/새 토큰을 발급/);
    expect(logs.join("\n")).not.toContain(wrong);
    await new Promise((r) => setTimeout(r, 100));
    expect(server.handshakes).toBe(1);
    expect(server.hellos).toEqual([]);
  });

  it("RATE_LIMITED 는 끝내지 않고 백오프로 다시 시도한다 — 가드 차단은 1분이라 풀리면 붙는다", async () => {
    const { server, logs, fatal } = await setup({
      reject: (n) => (n < 2 ? "RATE_LIMITED" : undefined),
    });
    await waitFor(() => server.hellos.length === 1);
    expect(fatal).toEqual([]);
    expect(server.handshakes).toBe(3);
    expect(logs.filter((l) => /RATE_LIMITED/.test(l)).length).toBeGreaterThanOrEqual(2);
  });

  it("stop — 도는 런에 interrupt 를 걸고 그 런이 final 을 낼 때까지 기다린 뒤 끊는다(리뷰 M5)", async () => {
    const { server, fake, conn } = await setup();
    await waitFor(() => server.hellos.length === 1);
    // interrupt 뒤 턴을 닫는 데 200ms 걸리는 CLI
    fake.script(
      script.messageStart("msg_1"),
      { waitInterrupt: [] },
      { sleep: 200 },
      script.errorResult("error_during_execution", ["x"]),
    );
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => fake.calls.length === 1);
    await conn.stop();
    expect(fake.calls[0]!.interrupts).toBe(1);
    // 끊기 전에 서버가 이미 받았다 — 기다리지 않았으면 끊긴 뒤라 버려진다
    expect(server.finals).toHaveLength(1);
    // 사람 중지(aborted)와 가른다 — 어댑터가 ADAPTER_UNAVAILABLE(「다시 실행」)로 닫는다
    expect(server.finals[0]).toMatchObject({ runId: RUN_ID, text: "", stopReason: "runner_shutdown" });
    expect(conn.connected).toBe(false);
  });

  it("stop — 대기열의 런도 runner_shutdown 으로 닫는다, CLI 는 띄우지 않는다", async () => {
    const { server, fake, conn } = await setup({ maxConcurrentRuns: 1 });
    await waitFor(() => server.hellos.length === 1);
    fake.script(script.messageStart("msg_1"), {
      waitInterrupt: [script.errorResult("error_during_execution", ["x"])],
    });
    await sendStart(server.sockets[0]!, runStart());
    await sendStart(server.sockets[0]!, runStart({ runId: RUN_2, sessionId: SESSION_2 }));
    await waitFor(() => fake.calls.length === 1);
    await conn.stop();
    expect(fake.calls).toHaveLength(1);
    expect(server.finals.map((f) => [f.runId, f.stopReason])).toEqual([
      [RUN_2, "runner_shutdown"],
      [RUN_ID, "runner_shutdown"],
    ]);
  });

  it("stop — 런이 끝나지 않아도 기다림은 상한까지만", async () => {
    const { server, fake, conn } = await setup({ stopWaitMs: 60 });
    await waitFor(() => server.hellos.length === 1);
    // interrupt 에도 closeGraceMs(30) 뒤 close 에도 끝나지 않는 CLI — sleep 은 close 를 보지 않는다
    fake.script(script.messageStart("msg_1"), { sleep: 1500 });
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => fake.calls.length === 1);
    const t0 = Date.now();
    await conn.stop();
    expect(Date.now() - t0).toBeLessThan(600);
    expect(fake.calls[0]!.closes).toBeGreaterThanOrEqual(1);
    expect(fake.calls[0]!.finished).toBe(false);
    expect(conn.connected).toBe(false);
  });

  it("stop — 다시 붙지 않는다", async () => {
    const { server, conn } = await setup();
    await waitFor(() => server.hellos.length === 1);
    conn.stop();
    await new Promise((r) => setTimeout(r, 80));
    expect(server.hellos).toHaveLength(1);
  });
  it("post 도구 → outbound.post(런의 값 그대로) → 서버 ack 가 도구 결과로", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    fake.script({ callTool: { name: "post", input: { text: "카드" } } }, ...script.textTurn("msg_1", ["끝"]));
    const start = runStart();
    await sendStart(server.sockets[0]!, start);
    await waitFor(() => server.finals.length === 1);
    expect(server.posts).toHaveLength(1);
    expect(server.posts[0]).toMatchObject({
      runId: RUN_ID,
      channelId: start.deliver.channelId,
      agentId: start.deliver.agentId,
      sessionKey: start.deliver.sessionKey,
      text: "카드",
    });
    expect(fake.calls[0]!.toolResults[0]!.content[0]!.text).toBe(
      "보냈습니다(메시지 0192f000-0000-7000-8000-0000000000aa)",
    );
  });

  it("서버의 outbound.post ack 가 계약과 다르면 INTERNAL 로 도구 결과 — 보냈다고 하지 않는다", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    server.postAck = { ok: true } as never;
    fake.script({ callTool: { name: "post", input: { text: "카드" } } }, ...script.textTurn("msg_1", ["끝"]));
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.finals.length === 1);
    expect(fake.calls[0]!.toolResults).toEqual([
      {
        isError: true,
        content: [{ type: "text", text: "보내지 못했습니다(INTERNAL): 서버 응답이 계약과 다릅니다" }],
      },
    ]);
  });

  it("approval.requested → 서버의 approval.resolve 가 결정으로 — 모르는 id·틀린 형식은 버린다", async () => {
    const { server, fake, logs } = await setup();
    await waitFor(() => server.hellos.length === 1);
    fake.script(
      { askPermission: { toolName: "Bash", input: { command: "make" }, toolUseID: "toolu_01" } },
      ...script.textTurn("msg_1", ["끝"]),
    );
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.approvals.length === 1);
    expect(server.approvals[0]).toMatchObject({
      providerApprovalId: "toolu_01",
      runId: RUN_ID,
      summary: "make",
    });
    const socket = server.sockets[0]!;
    socket.emit("approval.resolve", { providerApprovalId: "toolu_other", decision: "allow-once" });
    socket.emit("approval.resolve", { providerApprovalId: "toolu_01", decision: "maybe" } as never);
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.calls[0]!.permissions).toEqual([]);
    expect(logs.join("\n")).toMatch(/approval\.resolve 형식이 틀려/);
    socket.emit("approval.resolve", { providerApprovalId: "toolu_01", decision: "deny", reason: "expired" });
    await waitFor(() => server.finals.length === 1);
    expect(fake.calls[0]!.permissions).toEqual([{ behavior: "deny", message: "승인 시간이 지났습니다" }]);
  });

  it("run.abort 로 멈추면 떠 있던 승인은 approval.withdrawn — 런은 final aborted", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    fake.script(
      script.messageStart("msg_1"),
      { askPermission: { toolName: "Bash", input: { command: "make" }, toolUseID: "toolu_01" } },
      { waitInterrupt: [script.errorResult("error_during_execution", ["x"])] },
    );
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.approvals.length === 1);
    server.sockets[0]!.emit("run.abort", { runId: RUN_ID });
    await waitFor(() => server.finals.length === 1);
    expect(server.withdrawn).toEqual([{ providerApprovalId: "toolu_01" }]);
    expect(server.finals[0]).toMatchObject({ stopReason: "aborted", text: "" });
  });
});

describe("createRunBridge — 런을 시작한 연결 세대가 끊겼으면 보내지 않는다", () => {
  function fakeSocket() {
    const emitted: Array<[string, unknown]> = [];
    const acked: unknown[] = [];
    const socket = {
      emit: (event: string, payload: unknown) => {
        emitted.push([event, payload]);
        return true;
      },
      timeout: () => ({
        emitWithAck: async (_event: string, payload: unknown) => {
          acked.push(payload);
          return { ok: true, messageId: "0192f000-0000-7000-8000-0000000000aa" };
        },
      }),
    };
    return { socket: socket as never, emitted, acked };
  }
  const http = {
    upload: async () => {
      throw new Error("not used");
    },
    download: async () => {
      throw new Error("not used");
    },
  };
  const post = {
    outboundId: "runner-post:x",
    channelId: runStart().deliver.channelId,
    agentId: "coder",
    sessionKey: runStart().deliver.sessionKey,
    runId: RUN_ID,
    replyToInboundId: runStart().deliver.message.id,
    text: "x",
    attachmentIds: [],
    ts: "2026-09-27T02:00:00.000Z",
  };
  const approval = {
    providerApprovalId: "toolu_01",
    runId: RUN_ID,
    sessionKey: runStart().deliver.sessionKey,
    toolCallId: "toolu_01",
    toolName: "Bash",
    summary: "make",
    canAllowAlways: false,
  };

  it("붙어 있으면 post·승인 요청·철회를 보낸다", async () => {
    const f = fakeSocket();
    const bridge = createRunBridge({ socket: f.socket, live: () => true, http, decisions: new Map() });
    expect(await bridge.post(post)).toEqual({ ok: true, messageId: "0192f000-0000-7000-8000-0000000000aa" });
    bridge.requestApproval(approval);
    bridge.withdrawApproval("toolu_01");
    expect(f.acked).toEqual([post]);
    expect(f.emitted).toEqual([
      ["approval.requested", approval],
      ["approval.withdrawn", { providerApprovalId: "toolu_01" }],
    ]);
  });

  it("세대가 끊겼으면 post 는 ADAPTER_UNAVAILABLE, 승인 요청·철회는 버린다 — 새 연결로 새지 않는다", async () => {
    const f = fakeSocket();
    const decisions = new Map<string, () => void>([["toolu_01", () => {}]]);
    const bridge = createRunBridge({ socket: f.socket, live: () => false, http, decisions });
    expect(await bridge.post(post)).toEqual({
      ok: false,
      code: "ADAPTER_UNAVAILABLE",
      message: "서버와 연결이 끊겼습니다",
    });
    bridge.requestApproval(approval);
    bridge.withdrawApproval("toolu_01");
    expect(f.acked).toEqual([]);
    expect(f.emitted).toEqual([]);
    // 기다림은 세대와 상관없이 거둔다
    expect(decisions.size).toBe(0);
  });
});

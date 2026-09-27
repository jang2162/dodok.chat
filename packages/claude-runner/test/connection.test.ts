import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  RUNNER_NAMESPACE,
  RUNNER_PROTOCOL,
  RunnerHello,
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
import { startRunnerConnection, type RunnerConnection } from "../src/connection";
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
    onFatal: (code) => fatal.push(code),
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
    expect(hello.capabilities).toEqual(expect.arrayContaining(["threads", "interrupt"]));
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

  it("전송이 끊기면(transport close) 도는 런의 interrupt 가 불린다(Review Focus 1) — 그리고 다시 붙는다", async () => {
    const { server, fake, fatal } = await setup();
    await waitFor(() => server.hellos.length === 1);
    fake.script(script.messageStart("msg_1"), { waitInterrupt: [] }, { hang: true });
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => fake.calls.length === 1);
    // 엔진 소켓을 닫는다 — 서버 재시작·네트워크 끊김과 같은 클라이언트 사유(transport close)
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
    expect(server.finals[0]).toMatchObject({ runId: RUN_ID, stopReason: "aborted" });
    expect(conn.connected).toBe(false);
  });

  it("stop — 런이 끝나지 않아도 기다림은 상한까지만", async () => {
    const { server, fake, conn } = await setup({ stopWaitMs: 60 });
    await waitFor(() => server.hellos.length === 1);
    // closeGraceMs(30) 뒤 close 에도 끝나지 않는 일 — hang 은 close 로 풀리므로 대신 run 을 묶어 둔다
    fake.script(script.messageStart("msg_1"), { hang: true });
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => fake.calls.length === 1);
    const t0 = Date.now();
    await conn.stop();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(conn.connected).toBe(false);
  });

  it("stop — 다시 붙지 않는다", async () => {
    const { server, conn } = await setup();
    await waitFor(() => server.hellos.length === 1);
    conn.stop();
    await new Promise((r) => setTimeout(r, 80));
    expect(server.hellos).toHaveLength(1);
  });
});

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
    close: async () => {
      await io.close();
    },
  };
  const ns = io.of(RUNNER_NAMESPACE);
  ns.use((socket, next) => {
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

async function setup(opts: { maxConcurrentRuns?: number; token?: string } = {}) {
  const server = await startFakeServer();
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
    fake.script(script.init(), ...script.textTurn("msg_1", ["안녕", "하세요"]));
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
      text: "안녕하세요",
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

  it("서버 쪽에서 소켓을 끊으면 도는 런의 interrupt 가 불린다(Review Focus 1) — 그리고 다시 붙는다", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    fake.script(script.messageStart("msg_1"), { waitInterrupt: [] }, { hang: true });
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => fake.calls.length === 1);
    server.sockets[0]!.disconnect(true);
    await waitFor(() => fake.calls[0]!.interrupts === 1);
    // 유예 뒤 close 까지 — CLI 가 남지 않는다
    await waitFor(() => fake.calls[0]!.closes >= 1);
    await waitFor(() => server.hellos.length === 2);
    // 끊긴 사이 낸 이벤트는 새 연결로 몰려 나가지 않는다
    expect(server.events.filter((e) => e.event.type === "RUN_ABORTED")).toEqual([]);
  });

  it("설정에 없는 agentId 의 run.start → run.error NOT_FOUND", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    const ack = await sendStart(server.sockets[0]!, runStart({ agentId: "ghost" }));
    expect(ack.runId).toBe(RUN_ID);
    await waitFor(() => server.errors.length === 1);
    expect(server.errors[0]).toMatchObject({ runId: RUN_ID, code: "NOT_FOUND" });
    expect(fake.calls).toEqual([]);
  });

  it("같은 세션이 돌고 있으면 run.error CONFLICT", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    fake.script({ hang: true });
    await sendStart(server.sockets[0]!, runStart());
    await sendStart(server.sockets[0]!, runStart({ runId: RUN_2 }));
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

  it("run.abort → interrupt, 끝난 턴은 RUN_ABORTED 로 알린다", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    fake.script(script.messageStart("msg_1"), {
      waitInterrupt: [script.errorResult("error_during_execution", ["[ede_diagnostic]"])],
    });
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => fake.calls.length === 1);
    server.sockets[0]!.emit("run.abort", { runId: RUN_ID });
    await waitFor(() => server.events.some((e) => e.event.type === "RUN_ABORTED"));
    expect(fake.calls[0]!.interrupts).toBe(1);
  });

  it("틀린 토큰 — 거절되면 백오프로 다시 시도하고 로그에 토큰을 싣지 않는다", async () => {
    const wrong = "drn_wrong_token_value_zzzzzzzzzzzzzzzzzzzzzzzzz";
    const { server, logs, fatal } = await setup({ token: wrong });
    await waitFor(() => logs.filter((l) => /UNAUTHORIZED/.test(l)).length >= 2);
    expect(server.hellos).toEqual([]);
    expect(fatal).toEqual([]);
    expect(logs.join("\n")).not.toContain(wrong);
  });

  it("stop — 다시 붙지 않는다", async () => {
    const { server, conn } = await setup();
    await waitFor(() => server.hellos.length === 1);
    conn.stop();
    await new Promise((r) => setTimeout(r, 80));
    expect(server.hellos).toHaveLength(1);
  });
});

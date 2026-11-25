import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_RESULT_UNKNOWN_MESSAGE,
  type ControlResult,
  RUNNER_NAMESPACE,
  RUNNER_PROTOCOL,
  RunnerApprovalRequested,
  RunnerApprovalWithdrawn,
  RunnerControlCall,
  RUNNER_BOT_SOUL_HEADER,
  RunnerCommandsListResult,
  RunnerFsListResult,
  RunnerHello,
  RunnerOutboundPost,
  type RunnerOutboundAck,
  RunnerProjectCheckResult,
  RunnerRunAck,
  RunnerRunError,
  RunnerRunEvent,
  RunnerRunFinal,
  RunnerRunSession,
  RunnerTasksUpdate,
  type RunnerFollowupRequest,
  type RunnerFollowupResult,
  RunnerWorktreeCreateResult,
  RunnerWorktreeRemoveResult,
  type RunnerClientToServerEvents,
  type RunnerHelloResult,
  type RunnerRunAgent,
  type RunnerServerToClientEvents,
} from "@dodok/shared";
import { HELLO_TIMEOUT_MS } from "@dodok/runner-adapter";
import { Server, type Socket } from "socket.io";
import { afterEach, describe, expect, it } from "vitest";
import type { ProgramCeiling, ResolvedRunnerConfig } from "../src/config";
import {
  type BackgroundHooksSlot,
  createBackgroundHooksSlot,
  createRunBridge,
  invalidFields,
  NO_DRIVER_REASON,
  startRunnerConnection,
  type RunnerConnection,
  type RunnerConnectionOptions,
} from "../src/connection";
import type { ProgramDriver } from "../src/driver";
import {
  createClaudeDriver,
  MODELS_TIMEOUT_MEMORY_MS,
  MODELS_TIMEOUT_MS,
  toModelOptions,
} from "../src/drivers/claude";
import { VERSION_TIMEOUT_MS } from "../src/drivers/claude/executable";
import { RUNNER_DISALLOWED_TOOLS } from "../src/drivers/claude/run";
import { createFakeSdk, FAKE_MODELS, script, type FakeSdk } from "./helpers/fake-query";
import type { SdkModelInfo } from "../src/drivers/claude/sdk";
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
  sessions: RunnerRunSession[];
  events: RunnerRunEvent[];
  finals: RunnerRunFinal[];
  errors: RunnerRunError[];
  posts: RunnerOutboundPost[];
  approvals: RunnerApprovalRequested[];
  withdrawn: RunnerApprovalWithdrawn[];
  controls: RunnerControlCall[];
  tasksUpdates: RunnerTasksUpdate[];
  followups: RunnerFollowupRequest[];
  /** run.followup 에 답하는 법 — 없으면 답하지 않는다(시간 초과) */
  onFollowup?: (req: RunnerFollowupRequest, ack: (r: RunnerFollowupResult) => void) => void;
  /** control.call 에 답하는 법 — 없으면 곧바로 ok */
  onControl?: (socket: ServerSocket, ack: (r: ControlResult) => void) => void;
  postAck: RunnerOutboundAck;
  sockets: ServerSocket[];
  helloResult: RunnerHelloResult;
  /** 거절 ack 를 보낸 같은 틱에 연결을 끊는다 — 실제 러너 어댑터(hello 거절 → disconnect(true))와 같게 */
  disconnectAfterReject?: boolean;
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
    sessions: [],
    events: [],
    finals: [],
    errors: [],
    posts: [],
    approvals: [],
    withdrawn: [],
    controls: [],
    tasksUpdates: [],
    followups: [],
    postAck: { ok: true, messageId: "0192f000-0000-7000-8000-0000000000aa" },
    sockets: [],
    // 서버가 백그라운드 작업을 안다 — 표시가 없는 옛 서버는 시험이 helloResult 로 고른다
    helloResult: { ok: true, serverVersion: "test", features: ["backgroundTasks"] },
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
      if (!server.helloResult.ok && server.disconnectAfterReject) socket.disconnect(true);
    });
    socket.on("run.event", (p) => void server.events.push(RunnerRunEvent.parse(p)));
    socket.on("run.final", (p) => void server.finals.push(RunnerRunFinal.parse(p)));
    socket.on("run.error", (p) => void server.errors.push(RunnerRunError.parse(p)));
    socket.on("run.session", (p) => void server.sessions.push(RunnerRunSession.parse(p)));
    socket.on("outbound.post", (p, ack) => {
      server.posts.push(RunnerOutboundPost.parse(p));
      ack(server.postAck);
    });
    socket.on("approval.requested", (p) => void server.approvals.push(RunnerApprovalRequested.parse(p)));
    socket.on("approval.withdrawn", (p) => void server.withdrawn.push(RunnerApprovalWithdrawn.parse(p)));
    socket.on("tasks.update", (p) => void server.tasksUpdates.push(RunnerTasksUpdate.parse(p)));
    socket.on("run.followup", (p, ack) => {
      server.followups.push(p);
      server.onFollowup?.(p, ack);
    });
    socket.on("control.call", (p, ack) => {
      server.controls.push(RunnerControlCall.parse(p));
      if (server.onControl) server.onControl(socket, ack);
      else ack({ ok: true, data: null });
    });
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

/** 루트 src(라벨 「내 저장소들」) 아래 my-repo — 천장 검사가 실제 디렉터리를 realpath 로 본다 */
function tempRoot() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "dodok-conn-")));
  const root = join(base, "src");
  mkdirSync(join(root, "my-repo"), { recursive: true });
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  return { base, root, workdir: join(root, "my-repo") };
}

const CLAUDE_CEILING: ProgramCeiling = {
  configDir: AGENT.configDir,
  maxPermissionMode: "acceptEdits",
  disallowedTools: [],
  allowedToolsCeiling: null,
};

const VERSIONS = { runnerVersion: "0.0.0", sdkVersion: "0.3.283", bundleSha256: null };

async function setup(
  opts: {
    maxConcurrentRuns?: number;
    token?: string;
    stopWaitMs?: number;
    reject?: FakeServer["reject"];
    /** 서버의 hello 답 — 기본은 backgroundTasks 를 아는 서버 */
    helloResult?: FakeServer["helloResult"];
    /** onFatal 이 불린 그 순간을 보려고 — fatal 목록에 넣은 뒤 부른다 */
    onFatal?: (code: number) => void;
    browse?: boolean;
    roots?: ResolvedRunnerConfig["roots"];
    programs?: ResolvedRunnerConfig["programs"];
    /** 만든 claude 드라이버를 바꿔 끼운다(detect 가 던지는 드라이버 등) */
    driver?: (claude: ProgramDriver) => ProgramDriver;
    /** claude 드라이버의 baseEnv — detect 가 평소 자리(HOME/.claude·CLAUDE_CONFIG_DIR)를 여기서 읽는다 */
    baseEnv?: NodeJS.ProcessEnv;
    /** 가짜 SDK 를 붙기 전에 고친다(모델 목록 실패 등) */
    sdk?: (fake: FakeSdk) => void;
    modelsTimeoutMs?: number;
    remoteUpdate?: boolean;
    appMcp?: "off" | "http" | "all";
    appMcpCommands?: string[];
    selfUpdate?: RunnerConnectionOptions["selfUpdate"];
    /** 백그라운드 작업 훅 자리를 드라이버와 연결에 넘긴다 */
    background?: boolean;
    tasksThrottleMs?: number;
    followupAckTimeoutMs?: number;
  } = {},
) {
  const server = await startFakeServer();
  server.reject = opts.reject;
  if (opts.helloResult) server.helloResult = opts.helloResult;
  cleanups.push(() => server.close());
  const fake: FakeSdk = createFakeSdk();
  opts.sdk?.(fake);
  const logs: string[] = [];
  const fatal: number[] = [];
  const dirs = tempRoot();
  const config: ResolvedRunnerConfig = {
    serverUrl: server.url,
    maxConcurrentRuns: opts.maxConcurrentRuns ?? 3,
    roots: opts.roots ?? [{ id: "src", path: dirs.root, label: "내 저장소들" }],
    botsDir: join(dirs.base, "bots"),
    browse: opts.browse ?? true,
    remoteUpdate: opts.remoteUpdate ?? true,
    appMcp: opts.appMcp ?? "http",
    ...(opts.appMcpCommands === undefined ? {} : { appMcpCommands: opts.appMcpCommands }),
    programs: opts.programs ?? { claude: CLAUDE_CEILING },
  };
  const slot: BackgroundHooksSlot | undefined = opts.background ? createBackgroundHooksSlot() : undefined;
  const conn: RunnerConnection = startRunnerConnection({
    config,
    token: opts.token ?? TOKEN,
    ...(slot ? { background: slot } : {}),
    ...(opts.tasksThrottleMs === undefined ? {} : { tasksThrottleMs: opts.tasksThrottleMs }),
    ...(opts.followupAckTimeoutMs === undefined ? {} : { followupAckTimeoutMs: opts.followupAckTimeoutMs }),
    drivers: [
      (opts.driver ?? ((d) => d))(
        createClaudeDriver({
          sdk: fake,
          claudeCodeVersion: "2.1.283",
          baseEnv: opts.baseEnv ?? { PATH: "/usr/bin" },
          closeGraceMs: 30,
          modelsCwd: dirs.root,
          ...(opts.modelsTimeoutMs === undefined ? {} : { modelsTimeoutMs: opts.modelsTimeoutMs }),
          ...(slot ? { hooks: slot.hooks } : {}),
          logger: { info: (m) => logs.push(m) },
        }),
      ),
    ],
    versions: VERSIONS,
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
    ...(opts.stopWaitMs === undefined ? {} : { stopWaitMs: opts.stopWaitMs }),
    ...(opts.selfUpdate === undefined ? {} : { selfUpdate: opts.selfUpdate }),
  });
  cleanups.push(() => conn.stop());
  return { server, fake, logs, fatal, conn, dirs, slot };
}

const sendStart = (socket: ServerSocket, start: ReturnType<typeof runStart>) =>
  socket
    .timeout(2000)
    .emitWithAck("run.start", start)
    .then((a) => RunnerRunAck.parse(a));

describe("startRunnerConnection", () => {
  it("붙으면 hello V2 — 루트는 id·라벨만, 프로그램은 detect 결과·상한, 경로 원문·토큰 없음", async () => {
    const { server, logs, dirs } = await setup();
    await waitFor(() => server.hellos.length === 1);
    const hello = server.hellos[0]!;
    expect(hello).toEqual({
      runnerProtocol: RUNNER_PROTOCOL,
      runnerVersion: "0.0.0",
      sdkVersion: "0.3.283",
      bundleSha256: null,
      capabilities: [
        "threads",
        "interrupt",
        "approvals",
        "attachments",
        "worktrees",
        "commands",
        "bots",
        "botMcp",
        "runnerControl",
      ],
      roots: [{ id: "src", label: "내 저장소들" }],
      browse: true,
      programs: [
        {
          program: "claude",
          available: true,
          version: "2.1.283",
          // 로그인 디렉터리(/home/u/…)가 이 머신에 없다
          auth: "missing",
          login: "dedicated",
          // PATH(/usr/bin)에 claude 가 없다 — SDK 번들 CLI
          cli: "bundled",
          reason: expect.any(String),
          capabilities: ["serverSessionIds", "approvals", "images", "interrupt", "mcpTools", "costs"],
          ceiling: {
            maxPermissionMode: "acceptEdits",
            allowedToolsCeiling: null,
            appMcp: "http",
            appMcpCommands: null,
          },
          models: toModelOptions(FAKE_MODELS),
        },
      ],
    });
    // 직렬화한 hello 어디에도 루트·로그인 디렉터리의 절대 경로가 없다(완료 기준 4)
    const raw = JSON.stringify(hello);
    for (const path of [dirs.base, dirs.root, AGENT.configDir, "/home/u", tmpdir()]) {
      expect(raw).not.toContain(path);
    }
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(dirs.base);
  });

  it("hello — 로그인 디렉터리가 있으면 auth unknown(자격 증명은 읽지 않는다), 드라이버 없는 프로그램은 못 씀과 사유", async () => {
    const { base } = tempRoot();
    const { server } = await setup({
      programs: {
        claude: {
          ...CLAUDE_CEILING,
          configDir: base,
          maxPermissionMode: "default",
          allowedToolsCeiling: ["Read"],
        },
        codex: { ...CLAUDE_CEILING },
      },
    });
    await waitFor(() => server.hellos.length === 1);
    expect(server.hellos[0]!.programs).toEqual([
      {
        program: "claude",
        available: true,
        version: "2.1.283",
        auth: "unknown",
        login: "dedicated",
        cli: "bundled",
        capabilities: ["serverSessionIds", "approvals", "images", "interrupt", "mcpTools", "costs"],
        ceiling: {
          maxPermissionMode: "default",
          allowedToolsCeiling: ["Read"],
          appMcp: "http",
          appMcpCommands: null,
        },
        models: toModelOptions(FAKE_MODELS),
      },
      {
        program: "codex",
        available: false,
        auth: "unknown",
        reason: NO_DRIVER_REASON,
        capabilities: [],
        ceiling: {
          maxPermissionMode: "acceptEdits",
          allowedToolsCeiling: null,
          appMcp: "http",
          appMcpCommands: null,
        },
      },
    ]);
    expect(JSON.stringify(server.hellos[0])).not.toContain(base);
  });

  /** configDir 을 뺀 claude 천장 — 평소 로그인 */
  const { configDir: _dedicated, ...DEFAULT_LOGIN_CEILING } = CLAUDE_CEILING;

  /** 임시 HOME — withClaude 면 그 안에 .claude/ 를 만든다 */
  function tempHome(withClaude: boolean) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "dodok-home-")));
    if (withClaude) mkdirSync(join(home, ".claude"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    return home;
  }

  it("hello — configDir 이 없으면 login default, 평소 자리(HOME/.claude)가 있으면 auth unknown", async () => {
    const home = tempHome(true);
    const { server } = await setup({
      programs: { claude: DEFAULT_LOGIN_CEILING },
      baseEnv: { PATH: "/usr/bin", HOME: home },
    });
    await waitFor(() => server.hellos.length === 1);
    const claude = server.hellos[0]!.programs[0]!;
    expect(claude).toMatchObject({ program: "claude", auth: "unknown", login: "default" });
    expect(claude.reason).toBeUndefined();
    expect(JSON.stringify(server.hellos[0])).not.toContain(home);
  });

  it("hello — configDir 이 없고 평소 자리가 없으면 missing 과 평소 사유", async () => {
    const home = tempHome(false);
    const { server } = await setup({
      programs: { claude: DEFAULT_LOGIN_CEILING },
      baseEnv: { PATH: "/usr/bin", HOME: home },
    });
    await waitFor(() => server.hellos.length === 1);
    expect(server.hellos[0]!.programs[0]).toMatchObject({
      program: "claude",
      auth: "missing",
      login: "default",
      reason: "Claude Code 로그인 디렉터리가 없습니다 — 러너 머신에서 claude 로 /login 하세요",
    });
    expect(JSON.stringify(server.hellos[0])).not.toContain(home);
  });

  it("hello — configDir 이 없고 CLAUDE_CONFIG_DIR 이 있으면 그 디렉터리를 본다", async () => {
    const home = tempHome(false);
    const shellDir = tempHome(false);
    const { server } = await setup({
      programs: { claude: DEFAULT_LOGIN_CEILING },
      baseEnv: { PATH: "/usr/bin", HOME: home, CLAUDE_CONFIG_DIR: shellDir },
    });
    await waitFor(() => server.hellos.length === 1);
    expect(server.hellos[0]!.programs[0]).toMatchObject({ auth: "unknown", login: "default" });
    expect(JSON.stringify(server.hellos[0])).not.toContain(shellDir);
  });

  it("run.start → 가짜 query 대본 → 서버가 run.event·run.final 을 받는다", async () => {
    const { server, fake, dirs } = await setup();
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
    // 작업 디렉터리는 루트 + relPath 의 realpath
    expect(fake.calls[0]!.options.cwd).toBe(dirs.workdir);
  });

  /** PATH 에 둘 가짜 claude — --version 에 그 판을 답한다 */
  function fakeClaudeBin(version: string) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "dodok-bin-")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "claude"), `#!/bin/sh\necho "${version} (Claude Code)"\n`);
    chmodSync(join(dir, "claude"), 0o755);
    return dir;
  }

  it("러너 PATH 에 claude 가 있으면 hello 는 installed 와 그 판, 런은 그 실행 파일로 — 경로 원문은 hello 에 없다", async () => {
    const bin = fakeClaudeBin("2.1.322");
    const { server, fake, logs } = await setup({ baseEnv: { PATH: `${bin}:/usr/bin:/bin` } });
    await waitFor(() => server.sockets.length === 1 && server.hellos.length === 1);
    expect(server.hellos[0]!.programs[0]).toMatchObject({
      available: true,
      version: "2.1.322",
      cli: "installed",
    });
    expect(JSON.stringify(server.hellos[0])).not.toContain(bin);
    expect(logs).toContain("dodok-runner: Claude Code 설치본 2.1.322");
    expect(logs.join("\n")).not.toContain(bin);
    fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.finals.length === 1);
    expect(fake.calls[0]!.options.pathToClaudeCodeExecutable).toBe(join(bin, "claude"));
  });

  it("번들이면 런에 pathToClaudeCodeExecutable 을 넘기지 않는다", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.sockets.length === 1 && server.hellos.length === 1);
    fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.finals.length === 1);
    expect("pathToClaudeCodeExecutable" in fake.calls[0]!.options).toBe(false);
  });

  it("설정 executable 이 없으면 PATH 의 claude 로 돌아가지 않는다 — 못 씀, 런은 RUNNER_CEILING(program)", async () => {
    const bin = fakeClaudeBin("2.1.322");
    const { server, fake } = await setup({
      programs: { claude: { ...CLAUDE_CEILING, executable: join(bin, "none") } },
      baseEnv: { PATH: `${bin}:/usr/bin:/bin` },
    });
    await waitFor(() => server.sockets.length === 1 && server.hellos.length === 1);
    const claude = server.hellos[0]!.programs[0]!;
    expect(claude).toMatchObject({ available: false, reason: expect.stringContaining("executable") });
    expect(claude.cli).toBeUndefined();
    expect(JSON.stringify(server.hellos[0])).not.toContain(bin);
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.errors.length === 1);
    expect(server.errors[0]).toMatchObject({ code: "RUNNER_CEILING", message: "program" });
    expect(fake.calls).toHaveLength(0);
  });

  it("hello 거절(PROTOCOL_MISMATCH) → 사유를 남기고 종료 코드 2, 다시 붙지 않는다", async () => {
    const server = await startFakeServer();
    cleanups.push(() => server.close());
    server.helloResult = { ok: false, code: "PROTOCOL_MISMATCH", message: "runner protocol 2 != 1" };
    const fake = createFakeSdk();
    const logs: string[] = [];
    const fatal: number[] = [];
    const conn = startRunnerConnection({
      config: {
        serverUrl: server.url,
        maxConcurrentRuns: 1,
        roots: [{ id: "src", path: tempRoot().root, label: "src" }],
        botsDir: join(tmpdir(), "dodok-conn-bots-unused"),
        browse: true,
        remoteUpdate: true,
        appMcp: "http",
        programs: { claude: CLAUDE_CEILING },
      },
      token: TOKEN,
      drivers: [createClaudeDriver({ sdk: fake, claudeCodeVersion: "y" })],
      versions: { runnerVersion: "0.0.0", sdkVersion: "x", bundleSha256: null },
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

  it("hello 거절 ack 와 같은 틱에 서버가 끊어도 첫 문구는 판본 불일치이고 종료는 한 번 [태스크 2 보고 7-5]", async () => {
    const server = await startFakeServer();
    cleanups.push(() => server.close());
    server.helloResult = { ok: false, code: "PROTOCOL_MISMATCH", message: "server speaks runner protocol 3" };
    server.disconnectAfterReject = true;
    const logs: Array<[string, string]> = [];
    const fatal: number[] = [];
    const conn = startRunnerConnection({
      config: {
        serverUrl: server.url,
        maxConcurrentRuns: 1,
        roots: [{ id: "src", path: tempRoot().root, label: "src" }],
        botsDir: join(tmpdir(), "dodok-conn-bots-unused"),
        browse: true,
        remoteUpdate: true,
        appMcp: "http",
        programs: { claude: CLAUDE_CEILING },
      },
      token: TOKEN,
      drivers: [createClaudeDriver({ sdk: createFakeSdk(), claudeCodeVersion: "y" })],
      versions: { runnerVersion: "0.0.0", sdkVersion: "x", bundleSha256: null },
      logger: {
        info: (m) => logs.push(["info", m]),
        warn: (m) => logs.push(["warn", m]),
        error: (m) => logs.push(["error", m]),
      },
      onFatal: (code) => fatal.push(code),
      backoff: { minMs: 10, maxMs: 20 },
    });
    cleanups.push(() => conn.stop());
    await waitFor(() => fatal.length === 1);
    await new Promise((r) => setTimeout(r, 80));
    expect(fatal).toEqual([2]);
    const errors = logs.filter(([level]) => level === "error").map(([, m]) => m);
    expect(errors[0]).toMatch(/PROTOCOL_MISMATCH/);
    expect(errors[0]).toMatch(/판본/);
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
    server.helloResult = { ok: true, serverVersion: "test" };
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

  it("천장에 걸린 run.start → dispatch 뒤 run.error RUNNER_CEILING(항목 이름만) — CLI 는 띄우지 않는다", async () => {
    const { server, fake, dirs } = await setup({
      programs: {
        claude: { ...CLAUDE_CEILING, maxPermissionMode: "default", allowedToolsCeiling: ["Read"] },
      },
    });
    symlinkSync(dirs.base, join(dirs.root, "escape"));
    await waitFor(() => server.hellos.length === 1);
    // 미리 허용한 도구가 없는 에이전트(상한 ["Read"] 에 든다)에서 한 항목씩 어긋나게 한다
    const cases: Array<[Partial<RunnerRunAgent>, string]> = [
      [{ project: { rootId: "gone", relPath: "my-repo" } }, "root"],
      [{ project: { rootId: "src", relPath: "nope" } }, "path"],
      [{ project: { rootId: "src", relPath: "escape" } }, "path"],
      [{ program: "codex" }, "program"],
      [{ permissionMode: "acceptEdits" }, "permissionMode"],
      [{ allowedTools: ["Read", "Write"] }, "allowedTools"],
    ];
    for (const [i, [agent, item]] of cases.entries()) {
      const runId = `0192f000-0000-7000-8000-00000000b${String(i).padStart(3, "0")}`;
      // drop 이면 어댑터가 런을 놓아 뒤이은 run.error 를 버린다 — 오류 카드가 사라진다(리뷰 M1)
      expect(
        await sendStart(server.sockets[0]!, runStart({ runId, agent: { allowedTools: null, ...agent } })),
      ).toEqual({
        runId,
        admission: "dispatch",
      });
      await waitFor(() => server.errors.length === i + 1);
      expect(server.errors[i]).toEqual({ runId, code: "RUNNER_CEILING", message: item });
    }
    expect(fake.calls).toEqual([]);
    expect(JSON.stringify(server.errors)).not.toContain(dirs.base);
  });

  it("run.start 의 에이전트 정의가 CLI 옵션으로 — 설정의 늘 막는 도구와 에이전트의 것을 합친다", async () => {
    const { server, fake, dirs } = await setup({
      programs: { claude: { ...CLAUDE_CEILING, disallowedTools: ["Bash", "WebFetch"] } },
    });
    await waitFor(() => server.hellos.length === 1);
    fake.script(...script.textTurn("msg_1", ["x"]));
    await sendStart(
      server.sockets[0]!,
      runStart({ agent: { model: null, permissionMode: "plan", disallowedTools: ["Grep"] } }),
    );
    await waitFor(() => server.finals.length === 1);
    const options = fake.calls[0]!.options;
    expect(options.cwd).toBe(dirs.workdir);
    expect(options.permissionMode).toBe("plan");
    expect("model" in options).toBe(false);
    // 설정 몫(Bash·WebFetch) 뒤에 에이전트 몫(Grep) — 앱에서 정한 막는 도구가 조용히 빠지지 않는다(태스크 2 리뷰 M1)
    expect(options.disallowedTools).toEqual([...RUNNER_DISALLOWED_TOOLS, "Bash", "WebFetch", "Grep"]);
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe(AGENT.configDir);
  });

  it("run.start.agent.effort 가 CLI 옵션 effort 로 — 없으면(옛 서버) 키가 없다 [세션 설정 스펙 5.6]", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    fake.script(...script.textTurn("msg_1", ["x"]));
    await sendStart(server.sockets[0]!, runStart({ agent: { model: "opus", effort: "xhigh" } }));
    await waitFor(() => server.finals.length === 1);
    expect(fake.calls[0]!.options).toMatchObject({ model: "opus", effort: "xhigh" });
    fake.script(...script.textTurn("msg_2", ["y"]));
    await sendStart(server.sockets[0]!, runStart({ runId: "0192f000-0000-7000-8000-0000000000e2" }));
    await waitFor(() => server.finals.length === 2);
    expect("effort" in fake.calls[1]!.options).toBe(false);
  });

  it("providerSessionId 없는 claude 런은 VALIDATION — 서버가 세션 id 를 정하는 프로그램이다", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    const { providerSessionId: _, ...start } = runStart();
    expect(await sendStart(server.sockets[0]!, start as ReturnType<typeof runStart>)).toEqual({
      runId: RUN_ID,
      admission: "dispatch",
    });
    await waitFor(() => server.errors.length === 1);
    expect(server.errors[0]).toMatchObject({ runId: RUN_ID, code: "VALIDATION" });
    expect(fake.calls).toEqual([]);
    expect(server.sessions).toEqual([]);
  });

  it("형식이 틀린 run.start — 런 id 를 읽을 수 있으면 dispatch 뒤 VALIDATION(틀린 필드 이름만, 값 없음) [태스크 2 리뷰 M3]", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    const start = runStart();
    const secret = `/Users/someone/${"x".repeat(200)}`;
    const bad = { ...start, agent: { ...start.agent, model: "", allowedTools: [secret] } };
    expect(await sendStart(server.sockets[0]!, bad as never)).toEqual({
      runId: RUN_ID,
      admission: "dispatch",
    });
    await waitFor(() => server.errors.length === 1);
    expect(server.errors[0]).toEqual({
      runId: RUN_ID,
      code: "VALIDATION",
      message: "run.start 형식이 틀렸습니다 — agent.model, agent.allowedTools[0]",
    });
    expect(JSON.stringify(server.errors)).not.toContain("/Users/someone");
    expect(fake.calls).toEqual([]);
  });

  it("형식이 틀린 run.start — 런 id 도 읽을 수 없으면 drop, run.error 없음 [태스크 2 리뷰 M3]", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    const start = runStart();
    const bad = { ...start, deliver: { ...start.deliver, runId: "not-a-uuid" }, agent: { program: "x" } };
    // ack 의 runId 는 받은 글자 그대로라 RunnerRunAck 를 지나지 않는다 — 날것으로 본다
    expect(await server.sockets[0]!.timeout(2000).emitWithAck("run.start", bad as never)).toEqual({
      runId: "not-a-uuid",
      admission: "drop",
      reason: "invalid-run-start",
    });
    // 뒤이은 정상 런이 오류 하나 없이 도는지로 앞 런의 run.error 가 없었음을 본다
    fake.script(...script.textTurn("msg_1", ["x"]));
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.finals.length === 1);
    expect(server.errors).toEqual([]);
  });

  it("드라이버 없는 프로그램을 설정에 적고 그 프로그램으로 run.start → RUNNER_CEILING(program), 연결은 그대로 [태스크 2 리뷰 L1]", async () => {
    const { server, fake, fatal } = await setup({
      programs: { claude: CLAUDE_CEILING, codex: { ...CLAUDE_CEILING } },
    });
    await waitFor(() => server.hellos.length === 1);
    expect(await sendStart(server.sockets[0]!, runStart({ agent: { program: "codex" } }))).toEqual({
      runId: RUN_ID,
      admission: "dispatch",
    });
    await waitFor(() => server.errors.length === 1);
    expect(server.errors[0]).toEqual({ runId: RUN_ID, code: "RUNNER_CEILING", message: "program" });
    // 소켓 처리기가 던지지 않았다 — 같은 연결로 다음 런이 돈다
    fake.script(...script.textTurn("msg_1", ["x"]));
    await sendStart(server.sockets[0]!, runStart({ runId: RUN_2, sessionId: SESSION_2 }));
    await waitFor(() => server.finals.length === 1);
    expect(server.finals[0]!.runId).toBe(RUN_2);
    expect(fatal).toEqual([]);
    expect(server.hellos).toHaveLength(1);
  });

  it("detect 가 던지면 그 프로그램은 available false — 그 프로그램의 run.start 는 RUNNER_CEILING(program) [태스크 2 리뷰 L1]", async () => {
    const { server, fake } = await setup({
      driver: (d) => ({
        ...d,
        detect: async () => {
          throw new Error("detect 실패");
        },
      }),
    });
    await waitFor(() => server.hellos.length === 1);
    expect(server.hellos[0]!.programs).toEqual([
      {
        program: "claude",
        available: false,
        auth: "unknown",
        reason: "상태를 확인하지 못했습니다",
        capabilities: [],
        ceiling: {
          maxPermissionMode: "acceptEdits",
          allowedToolsCeiling: null,
          appMcp: "http",
          appMcpCommands: null,
        },
      },
    ]);
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.errors.length === 1);
    expect(server.errors[0]).toEqual({ runId: RUN_ID, code: "RUNNER_CEILING", message: "program" });
    expect(fake.calls).toEqual([]);
  });

  it("hello capabilities include commands", async () => {
    const { server } = await setup();
    await waitFor(() => server.hellos.length === 1);
    expect(server.hellos[0]!.capabilities).toContain("commands");
  });

  it("commands.list returns non-builtin commands with aliases", async () => {
    const { server, fake, dirs } = await setup({ baseEnv: { PATH: "/usr/bin", HOME: "/nonexistent-home" } });
    // 그 프로젝트의 명령 폴더 — 감싸개가 링크한다
    mkdirSync(join(dirs.workdir, ".claude", "commands"), { recursive: true });
    await waitFor(() => server.hellos.length === 1);
    const socket = server.sockets[0]!;
    const result = RunnerCommandsListResult.parse(
      await socket
        .timeout(2000)
        .emitWithAck("commands.list", { project: { rootId: "src", relPath: "my-repo" } }),
    );
    // 내장 중 막는 것(login·model)은 빠지고, 사람 것은 이름·별칭 그대로. 빈 argumentHint 는 싣지 않는다
    expect(result).toEqual({
      ok: true,
      commands: [
        {
          name: "compact",
          description: "Clear conversation history but keep a summary",
          argumentHint: "<instructions>",
        },
        { name: "user:user-cmd", description: "(user) SPIKE user command desc", argumentHint: "<topic>" },
        {
          name: "user:user-skill",
          description: "(user) SPIKE user skill desc",
          argumentHint: "<thing>",
          aliases: ["user-skill"],
        },
        { name: "project:proj-cmd", description: "(project) SPIKE project command desc" },
      ],
    });
    // 런과 같은 막기 옵션·감싸개·cwd 로 물었다
    const options = fake.listCommandsCalls[0]!;
    expect(options).toMatchObject({
      cwd: dirs.workdir,
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      settings: { disableAllHooks: true, disableSkillShellExecution: true },
    });
    expect(options.plugins).toEqual([expect.objectContaining({ type: "local", skipMcpDiscovery: true })]);
  });

  it("commands.list — 루트·자리가 없으면 root_missing·not_found, 목록이 실패하면 failed", async () => {
    const { server, fake } = await setup({
      sdk: (f) => {
        f.commands = async () => {
          throw new Error("boom");
        };
      },
    });
    void fake;
    await waitFor(() => server.hellos.length === 1);
    const socket = server.sockets[0]!;
    const ask = (project: { rootId: string; relPath: string }) =>
      socket.timeout(2000).emitWithAck("commands.list", { project });
    expect(await ask({ rootId: "nope", relPath: "" })).toEqual({ ok: false, reason: "root_missing" });
    expect(await ask({ rootId: "src", relPath: "missing" })).toEqual({ ok: false, reason: "not_found" });
    expect(await ask({ rootId: "src", relPath: "../x" })).toEqual({ ok: false, reason: "not_found" });
    expect(await ask({ rootId: "src", relPath: "my-repo" })).toEqual({ ok: false, reason: "failed" });
  });

  it("봇 런 — 루트가 없어도(roots: []) 봇 폴더에서 돈다, SOUL.md 는 머리 줄 + 정의 [러너 봇 스펙 B1·B4]", async () => {
    const { server, fake, dirs } = await setup({ roots: [] });
    await waitFor(() => server.hellos.length === 1);
    expect(server.hellos[0]!.roots).toEqual([]);
    fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
    const bot = { id: "r-0123456789", soul: "# 리뷰 봇\n\n## Purpose\n리뷰 봇\n" };
    const ack = await sendStart(server.sockets[0]!, runStart({ agent: { project: undefined, bot } }));
    expect(ack).toEqual({ runId: RUN_ID, admission: "dispatch" });
    await waitFor(() => server.finals.length === 1);
    const folder = join(dirs.base, "bots", bot.id);
    expect(fake.calls[0]!.options.cwd).toBe(folder);
    expect(readFileSync(join(folder, "SOUL.md"), "utf8")).toBe(`${RUNNER_BOT_SOUL_HEADER}\n\n${bot.soul}`);
    expect(server.errors).toEqual([]);
  });

  it("봇 런 — 봇 자리가 링크면 RUNNER_CEILING(bot), CLI 는 띄우지 않는다 [Review Focus 1]", async () => {
    const { server, fake, dirs } = await setup();
    mkdirSync(join(dirs.base, "bots"));
    symlinkSync(dirs.workdir, join(dirs.base, "bots", "r-0123456789"));
    await waitFor(() => server.hellos.length === 1);
    await sendStart(
      server.sockets[0]!,
      runStart({ agent: { project: undefined, bot: { id: "r-0123456789", soul: "x" } } }),
    );
    await waitFor(() => server.errors.length === 1);
    expect(server.errors[0]).toMatchObject({ code: "RUNNER_CEILING", message: "bot" });
    expect(fake.calls).toHaveLength(0);
  });

  it("봇 MCP — 가짜 서버가 stdio 를 보내도 http 러너는 빼고, all + 명령 목록 러너는 hello 천장에 싣고 그 명령만 붙인다 [러너 봇 2부 Review Focus 1]", async () => {
    const bot = {
      id: "r-0123456789",
      soul: "x",
      mcpServers: {
        gh: { type: "http" as const, url: "https://api.example.com/mcp", headers: { A: "Bearer TOPSECRET" } },
        sh: { command: "/tmp/npx", args: ["-y", "evil"] },
        sh2: { command: "bash", args: ["-c", "touch /tmp/pwned"] },
      },
    };
    const http = await setup();
    await waitFor(() => http.server.hellos.length === 1);
    http.fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
    await sendStart(http.server.sockets[0]!, runStart({ agent: { project: undefined, bot } }));
    await waitFor(() => http.server.finals.length === 1);
    expect(Object.keys(http.fake.calls[0]!.options.mcpServers ?? {}).sort()).toEqual(["dodok", "gh"]);
    expect(http.logs.join("\n")).toContain("bot mcp blocked sh stdioNotAllowed");
    expect(http.logs.join("\n")).not.toContain("TOPSECRET");

    const all = await setup({ appMcp: "all", appMcpCommands: ["npx"] });
    await waitFor(() => all.server.hellos.length === 1);
    expect(all.server.hellos[0]!.programs[0]!.ceiling).toMatchObject({
      appMcp: "all",
      appMcpCommands: ["npx"],
    });
    all.fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
    await sendStart(all.server.sockets[0]!, runStart({ agent: { project: undefined, bot } }));
    await waitFor(() => all.server.finals.length === 1);
    expect(Object.keys(all.fake.calls[0]!.options.mcpServers ?? {}).sort()).toEqual(["dodok", "gh", "sh"]);
    expect(all.logs.join("\n")).toContain("bot mcp blocked sh2 commandNotAllowed(bash)");
  });

  it("commands.list 봇 갈래 — 봇 폴더 cwd, 프로젝트 감싸개는 봇 폴더의 .claude/commands 를 잇는다 [B8·B13]", async () => {
    const { server, fake, dirs } = await setup({ baseEnv: { PATH: "/usr/bin", HOME: "/nonexistent-home" } });
    const folder = join(dirs.base, "bots", "r-0123456789");
    mkdirSync(join(folder, ".claude", "commands"), { recursive: true });
    const linked: string[] = [];
    fake.commands = async (options) => {
      for (const p of (options.plugins ?? []) as Array<{ path: string }>) {
        linked.push(realpathSync(join(p.path, "commands")));
      }
      return [];
    };
    await waitFor(() => server.hellos.length === 1);
    const socket = server.sockets[0]!;
    const ask = (id: string) => socket.timeout(2000).emitWithAck("commands.list", { bot: { id } });
    expect(await ask("r-0123456789")).toEqual({ ok: true, commands: [] });
    expect(fake.listCommandsCalls[0]!.cwd).toBe(folder);
    expect(linked).toEqual([join(folder, ".claude", "commands")]);
    expect(await ask("../x")).toEqual({ ok: false, reason: "not_found" });
  });

  it("fs.list·project.check 왕복 — browse 를 끄면 둘러보기만 FORBIDDEN", async () => {
    const { server, dirs } = await setup();
    mkdirSync(join(dirs.root, "my-repo", ".git"));
    mkdirSync(join(dirs.root, ".secret"));
    symlinkSync(dirs.base, join(dirs.root, "escape"));
    await waitFor(() => server.hellos.length === 1);
    const socket = server.sockets[0]!;
    const list = RunnerFsListResult.parse(
      await socket.timeout(2000).emitWithAck("fs.list", { rootId: "src", relPath: "" }),
    );
    expect(list).toEqual({ ok: true, entries: [{ name: "my-repo", isGitRepo: true }], truncated: false });
    expect(
      RunnerProjectCheckResult.parse(
        await socket.timeout(2000).emitWithAck("project.check", { rootId: "src", relPath: "escape" }),
      ),
    ).toEqual({ ok: false, reason: "outside_root" });
    // 형식이 틀린 요청 — 없는 자리로 답한다
    expect(await socket.timeout(2000).emitWithAck("fs.list", { rootId: "src", relPath: "../x" })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });

    const closed = await setup({ browse: false });
    await waitFor(() => closed.server.hellos.length === 1);
    expect(closed.server.hellos[0]!.browse).toBe(false);
    const s2 = closed.server.sockets[0]!;
    expect(await s2.timeout(2000).emitWithAck("fs.list", { rootId: "src", relPath: "" })).toEqual({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(
      await s2.timeout(2000).emitWithAck("project.check", { rootId: "src", relPath: "my-repo" }),
    ).toEqual({
      ok: true,
      isGitRepo: false,
      isGitTop: false,
    });
  });

  it("hello capabilities include worktrees", async () => {
    const { server } = await setup();
    await waitFor(() => server.hellos.length === 1);
    expect(server.hellos[0]!.capabilities).toContain("worktrees");
  });

  it("worktree.create ack goes through createWorktree", async () => {
    // 머신의 git 설정(전역 훅 등)에 기대지 않게 — 러너가 부르는 git 도 이 env 를 물려받는다
    const env = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    cleanups.push(() => {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const { server, dirs } = await setup();
    const repo = join(dirs.root, "app");
    mkdirSync(repo);
    const run = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: repo,
        stdio: "ignore",
      });
    run("init", "-q", "-b", "main");
    run("commit", "-q", "--allow-empty", "-m", "init");
    await waitFor(() => server.hellos.length === 1);
    const socket = server.sockets[0]!;
    const created = RunnerWorktreeCreateResult.parse(
      await socket.timeout(10_000).emitWithAck("worktree.create", {
        repo: { rootId: "src", relPath: "app" },
        target: { rootId: "src", relPath: "app/.worktrees/feat" },
        branch: "dodok/feat",
      }),
    );
    expect(created).toMatchObject({ ok: true, created: true, adopted: false });
    expect(
      await socket.timeout(10_000).emitWithAck("worktree.create", {
        repo: { rootId: "src", relPath: "app" },
        target: { rootId: "src", relPath: "app/.worktrees/bad" },
        branch: "-x",
      }),
    ).toMatchObject({ ok: false, reason: "invalid_branch" });
    expect(
      RunnerWorktreeRemoveResult.parse(
        await socket.timeout(10_000).emitWithAck("worktree.remove", {
          repo: { rootId: "src", relPath: "app" },
          target: { rootId: "src", relPath: "app/.worktrees/feat" },
        }),
      ),
    ).toEqual({ ok: true });
    // 형식이 틀린 요청 — git 을 부르지 않고 git_failed
    expect(
      await socket.timeout(10_000).emitWithAck("worktree.create", {
        repo: { rootId: "src", relPath: "../x" },
        target: { rootId: "src", relPath: "x" },
        branch: "b",
      }),
    ).toMatchObject({ ok: false, reason: "git_failed" });
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
      conversationId: start.deliver.conversationId,
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

  it("제어 도구 → control.call(지금 런의 runId) → 서버가 늦게(확인 카드 대기) 답해도 그 ack 가 도구 결과로", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    server.onControl = (_socket, ack) =>
      void setTimeout(
        () => ack({ ok: false, error: { code: "FORBIDDEN", message: "@mia 가 거절했습니다" } }),
        300,
      );
    fake.script(
      { callTool: { name: "set_channel_prompt", input: { channelId: RUN_ID, prompt: "규칙" } } },
      ...script.textTurn("msg_1", ["끝"]),
    );
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.finals.length === 1);
    expect(server.controls).toMatchObject([
      { runId: RUN_ID, tool: "set_channel_prompt", args: { channelId: RUN_ID, prompt: "규칙" } },
    ]);
    expect(fake.calls[0]!.toolResults).toEqual([
      {
        isError: true,
        content: [
          { type: "text", text: JSON.stringify({ code: "FORBIDDEN", message: "@mia 가 거절했습니다" }) },
        ],
      },
    ]);
  });

  it("control.call 은 런 signal 을 보지 않는다 — 기다리는 사이 런이 중지돼도 서버의 ack 가 도구 결과다(서버가 런 종료 때 기다리던 호출을 닫는다)", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    server.onControl = (socket, ack) => {
      socket.emit("run.abort", { runId: RUN_ID });
      void setTimeout(() => ack({ ok: false, error: { code: "EXPIRED", message: "런이 끝났습니다" } }), 100);
    };
    fake.script(
      { callTool: { name: "update_channel", input: { channelId: RUN_ID, name: "ops" } } },
      { waitInterrupt: [script.errorResult("error_during_execution", ["x"])] },
    );
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.finals.length === 1);
    expect(server.controls).toHaveLength(1);
    expect(fake.calls[0]!.toolResults).toEqual([
      {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ code: "EXPIRED", message: "런이 끝났습니다" }) }],
      },
    ]);
    expect(server.finals[0]).toMatchObject({ stopReason: "aborted" });
  });

  it("control.call 을 보낸 뒤 전송이 끊기면 도구 결과는 「결과를 모른다」 — 실패라고 하지 않는다(태스크 4 리뷰 L2)", async () => {
    const { server, fake } = await setup();
    await waitFor(() => server.hellos.length === 1);
    // 서버가 받기만 하고(카드 대기) 답하기 전에 전송이 끊긴다
    server.onControl = (socket) => socket.conn.close();
    fake.script(
      { callTool: { name: "update_channel", input: { channelId: RUN_ID, name: "ops" } } },
      ...script.textTurn("msg_1", ["끝"]),
    );
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => fake.calls[0]?.toolResults.length === 1);
    expect(server.controls).toHaveLength(1);
    expect(fake.calls[0]!.toolResults).toEqual([
      { isError: true, content: [{ type: "text", text: CONTROL_RESULT_UNKNOWN_MESSAGE }] },
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
    conversationId: runStart().deliver.conversationId,
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

describe("invalidFields — 형식 오류 문구는 스키마의 이름만 [태스크 2 재리뷰 N2]", () => {
  it("이름 꼴이 아닌 경로 성분(보낸 쪽이 정한 맵 키·경로 글자)은 ? 로, 숫자는 [n], 같은 경로는 한 번, 5개 넘으면 「외 N개」", () => {
    expect(
      invalidFields([
        { path: ["agent", "/Users/someone/secret", 0] },
        { path: ["deliver", "options", "has space"] },
        { path: ["agent", "allowedTools", 2] },
        { path: ["agent", "allowedTools", 2] },
        { path: [] },
      ]),
    ).toBe("agent.?[0], deliver.options.?, agent.allowedTools[2], (최상위)");
    expect(invalidFields([{ path: [Symbol("s")] }])).toBe("?");
    const many = Array.from({ length: 7 }, (_, i) => ({ path: [`f${i}`] }));
    expect(invalidFields(many)).toBe("f0, f1, f2, f3, f4 외 2개");
  });
});

describe("hello 의 모델 목록(작성기 칩 스펙 C3·C4)", () => {
  it("hello program status carries models from detect", async () => {
    const { server, fake, dirs } = await setup();
    await waitFor(() => server.hellos.length === 1);
    expect(server.hellos[0]!.programs[0]!.models).toEqual([
      {
        value: "default",
        displayName: "Default (recommended)",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      { value: "sonnet", displayName: "Sonnet 5.5", efforts: ["low", "medium", "high"] },
      // 다른 줄이 effort 키를 실었는데 이 줄은 싣지 않았다 — 「안 받음」이라 빈 목록(실제 CLI 의 꼴, models.test.ts)
      { value: "haiku", displayName: "Haiku 5.5", efforts: [] },
    ]);
    // 런과 같은 로그인·설정 — 첫 루트를 cwd 로, env 허용 목록·전용 로그인 자리, 사람 저장소 설정·커넥터는 끌어오지 않는다
    expect(fake.listModelsCalls).toHaveLength(1);
    const options = fake.listModelsCalls[0]!;
    expect(options).toMatchObject({
      cwd: dirs.root,
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: AGENT.configDir, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    });
    expect(options.abortController).toBeInstanceOf(AbortController);
    // 프롬프트를 보내는 query 는 열지 않는다 — 목록 받기가 런이 되지 않는다
    expect(fake.calls).toHaveLength(0);
  });

  it("목록 받기 env 는 허용 목록 — 러너의 ANTHROPIC_* 를 CLI 로 넘기지 않는다", async () => {
    const { server, fake } = await setup({
      baseEnv: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-runner-secret",
        ANTHROPIC_BASE_URL: "https://elsewhere",
      },
    });
    await waitFor(() => server.hellos.length === 1);
    const env = fake.listModelsCalls[0]!.env;
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(env).toMatchObject({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: AGENT.configDir });
  });

  it("default 줄의 resolvedLabel 이 hello 계약(RunnerHello)을 지나 서버까지 간다 [채널 UI·권한 모드 스펙 2장]", async () => {
    const { server } = await setup({
      sdk: (fake) => {
        fake.models = async () =>
          [
            {
              value: "default",
              resolvedModel: "claude-opus-5-5[1m]",
              displayName: "Default (recommended)",
              description: "Use the default model",
            },
            {
              value: "opus[1m]",
              resolvedModel: "claude-opus-5-5[1m]",
              displayName: "Opus (1M context)",
              description: "Opus 5.5 with 1M context",
            },
          ] as SdkModelInfo[];
      },
    });
    await waitFor(() => server.hellos.length === 1);
    const models = server.hellos[0]!.programs[0]!.models!;
    expect(models[0]).toMatchObject({ value: "default", resolvedLabel: "Opus (1M context)" });
    expect(models[1]).not.toHaveProperty("resolvedLabel");
  });

  it("listModels failure → hello without models", async () => {
    const { server } = await setup({
      sdk: (fake) => {
        fake.models = async () => {
          throw new Error("CLI 초기화 실패");
        };
      },
    });
    await waitFor(() => server.hellos.length === 1);
    const claude = server.hellos[0]!.programs[0]!;
    expect(claude.available).toBe(true);
    expect(claude).not.toHaveProperty("models");
  });

  it("listModels 가 답하지 않으면 상한 뒤 목록 없이 hello — 그 query 는 끊는다", async () => {
    let aborted: AbortController | undefined;
    const { server } = await setup({
      modelsTimeoutMs: 30,
      sdk: (fake) => {
        fake.models = (options) => {
          aborted = options.abortController;
          return new Promise(() => {});
        };
      },
    });
    await waitFor(() => server.hellos.length === 1);
    expect(server.hellos[0]!.programs[0]).not.toHaveProperty("models");
    expect(aborted?.signal.aborted).toBe(true);
  });

  it("판 읽기 + 목록 받기 상한의 합이 서버 hello 상한보다 작다 — 넘으면 서버가 끊고 재연결을 되풀이한다", () => {
    // 1초 넘게 남긴다 — 연결·hello 전송·detect 의 다른 일에 쓸 여유
    expect(VERSION_TIMEOUT_MS + MODELS_TIMEOUT_MS).toBeLessThanOrEqual(HELLO_TIMEOUT_MS - 1000);
  });

  it("timed-out model list is not retried on reconnect", async () => {
    const { server, fake } = await setup({
      modelsTimeoutMs: 30,
      sdk: (f) => {
        f.models = () => new Promise(() => {});
      },
    });
    await waitFor(() => server.hellos.length === 1);
    expect(fake.listModelsCalls).toHaveLength(1);
    // 다시 붙는다(transport close) — 같은 CLI·판·로그인 자리라 멈추는 CLI 를 다시 띄우지 않고 목록 없이 hello
    server.sockets[0]!.conn.close();
    await waitFor(() => server.hellos.length === 2);
    expect(server.hellos[1]!.programs[0]).not.toHaveProperty("models");
    expect(fake.listModelsCalls).toHaveLength(1);
  });

  it("thrown model list is retried", async () => {
    let fail = true;
    const { server, fake } = await setup({
      sdk: (f) => {
        f.models = async () => {
          if (fail) throw new Error("로그인 전");
          return FAKE_MODELS;
        };
      },
    });
    await waitFor(() => server.hellos.length === 1);
    expect(server.hellos[0]!.programs[0]).not.toHaveProperty("models");
    fail = false;
    server.sockets[0]!.conn.close();
    await waitFor(() => server.hellos.length === 2);
    expect(fake.listModelsCalls).toHaveLength(2);
    expect(server.hellos[1]!.programs[0]!.models).toEqual(toModelOptions(FAKE_MODELS));
  });

  it("second detect with same CLI reuses models", async () => {
    const fake = createFakeSdk();
    const driver = createClaudeDriver({
      sdk: fake,
      claudeCodeVersion: "2.1.283",
      baseEnv: { PATH: "/usr/bin" },
    });
    const first = await driver.detect(CLAUDE_CEILING);
    const second = await driver.detect(CLAUDE_CEILING);
    expect(first.models).toEqual(toModelOptions(FAKE_MODELS));
    expect(second.models).toEqual(first.models);
    expect(fake.listModelsCalls).toHaveLength(1);
    // 로그인 자리가 바뀌면(다른 계정일 수 있다) 다시 받는다
    await driver.detect({ ...CLAUDE_CEILING, configDir: "/elsewhere/claude" });
    expect(fake.listModelsCalls).toHaveLength(2);
  });

  it("changed CLI version refetches models", async () => {
    const fake = createFakeSdk();
    let version = "2.1.322";
    const driver = createClaudeDriver({
      sdk: fake,
      claudeCodeVersion: "2.1.283",
      baseEnv: { PATH: "/usr/bin" },
      isExecutable: (p) => p === "/usr/bin/claude",
      readVersion: async () => version,
    });
    await driver.detect(CLAUDE_CEILING);
    await driver.detect(CLAUDE_CEILING);
    expect(fake.listModelsCalls).toHaveLength(1);
    // 같은 자리의 CLI 를 올렸다 — 모델 목록이 달라졌을 수 있다
    version = "2.1.323";
    expect((await driver.detect(CLAUDE_CEILING)).models).toEqual(toModelOptions(FAKE_MODELS));
    expect(fake.listModelsCalls).toHaveLength(2);
  });

  it("changed CLI version after timeout refetches", async () => {
    const fake = createFakeSdk();
    let hang = true;
    fake.models = async () => (hang ? new Promise<never>(() => {}) : FAKE_MODELS);
    let version = "2.1.322";
    const driver = createClaudeDriver({
      sdk: fake,
      claudeCodeVersion: "2.1.283",
      baseEnv: { PATH: "/usr/bin" },
      isExecutable: (p) => p === "/usr/bin/claude",
      readVersion: async () => version,
      modelsTimeoutMs: 30,
    });
    expect(await driver.detect(CLAUDE_CEILING)).not.toHaveProperty("models");
    expect(await driver.detect(CLAUDE_CEILING)).not.toHaveProperty("models");
    expect(fake.listModelsCalls).toHaveLength(1);
    // 시간 초과 기억(10분)이 남아 있어도 CLI 를 바꾸면 그 자리에서 다시 받는다
    hang = false;
    version = "2.1.323";
    expect((await driver.detect(CLAUDE_CEILING)).models).toEqual(toModelOptions(FAKE_MODELS));
    expect(fake.listModelsCalls).toHaveLength(2);
  });

  it("timed-out model list is retried after 10 minutes", async () => {
    const fake = createFakeSdk();
    fake.models = () => new Promise(() => {});
    let clock = 1_000_000;
    const logs: string[] = [];
    const driver = createClaudeDriver({
      sdk: fake,
      claudeCodeVersion: "2.1.283",
      baseEnv: { PATH: "/usr/bin" },
      modelsTimeoutMs: 30,
      now: () => clock,
      logger: { info: (m) => logs.push(m) },
    });
    expect(MODELS_TIMEOUT_MEMORY_MS).toBe(600_000);
    expect(await driver.detect(CLAUDE_CEILING)).not.toHaveProperty("models");
    expect(fake.listModelsCalls).toHaveLength(1);
    // 시간 초과는 한 줄 — 경로 없이
    const timeoutLines = logs.filter((l) => l.includes("모델 목록"));
    expect(timeoutLines).toEqual([
      "dodok-runner: Claude Code 모델 목록을 30ms 안에 받지 못했습니다 — 10분 뒤 다시 받습니다",
    ]);
    expect(timeoutLines[0]).not.toContain("/");
    // 10분이 지나기 전에는 기억을 쓴다
    clock += MODELS_TIMEOUT_MEMORY_MS - 1;
    await driver.detect(CLAUDE_CEILING);
    expect(fake.listModelsCalls).toHaveLength(1);
    // 지나면 다시 받는다 — 이번에는 답한다
    clock += 1;
    fake.models = async () => FAKE_MODELS;
    expect((await driver.detect(CLAUDE_CEILING)).models).toEqual(toModelOptions(FAKE_MODELS));
    expect(fake.listModelsCalls).toHaveLength(2);
    // 받은 목록은 만료가 없다
    clock += MODELS_TIMEOUT_MEMORY_MS * 10;
    await driver.detect(CLAUDE_CEILING);
    expect(fake.listModelsCalls).toHaveLength(2);
  });

  it("실패한 목록은 기억하지 않는다 — 다음 detect 가 다시 받는다", async () => {
    const fake = createFakeSdk();
    let fail = true;
    fake.models = async () => {
      if (fail) throw new Error("x");
      return FAKE_MODELS;
    };
    const driver = createClaudeDriver({
      sdk: fake,
      claudeCodeVersion: "2.1.283",
      baseEnv: { PATH: "/usr/bin" },
    });
    expect(await driver.detect(CLAUDE_CEILING)).not.toHaveProperty("models");
    fail = false;
    expect((await driver.detect(CLAUDE_CEILING)).models).toHaveLength(3);
    expect(fake.listModelsCalls).toHaveLength(2);
  });

  it("쓸 수 없는 CLI 면 목록을 받지 않는다", async () => {
    const fake = createFakeSdk();
    const driver = createClaudeDriver({
      sdk: fake,
      claudeCodeVersion: "2.1.283",
      baseEnv: { PATH: "/usr/bin" },
    });
    const got = await driver.detect({ ...CLAUDE_CEILING, executable: "/nope/claude" });
    expect(got.available).toBe(false);
    expect(fake.listModelsCalls).toHaveLength(0);
  });
});

describe("원격 업데이트 — runner.update(원격 업데이트 스펙 U1·U3)", () => {
  type UpdateRequest = Parameters<NonNullable<RunnerConnectionOptions["selfUpdate"]>>[0];
  const askUpdate = (socket: ServerSocket, version: unknown) =>
    socket
      .timeout(2000)
      .emitWithAck("runner.update", { version } as never)
      .then((r) => r as unknown);

  it("selfUpdate 가 있으면 hello 능력 remoteUpdate, 설정이 끄면 remoteUpdateOff 도", async () => {
    const on = await setup({ selfUpdate: async () => ({ ok: true }) });
    const off = await setup({ selfUpdate: async () => ({ ok: true }), remoteUpdate: false });
    await waitFor(() => on.server.hellos.length === 1 && off.server.hellos.length === 1);
    expect(on.server.hellos[0]!.capabilities).toContain("remoteUpdate");
    expect(on.server.hellos[0]!.capabilities).not.toContain("remoteUpdateOff");
    expect(off.server.hellos[0]!.capabilities).toEqual(
      expect.arrayContaining(["remoteUpdate", "remoteUpdateOff"]),
    );
  });

  it("설정의 remoteUpdate 를 selfUpdate 에 넘긴다 — 끈 머신의 답은 selfUpdate 의 disabled 그대로", async () => {
    const requests: UpdateRequest[] = [];
    const { server } = await setup({
      remoteUpdate: false,
      selfUpdate: async (r) => {
        requests.push(r);
        return r.enabled ? { ok: true } : { ok: false, reason: "disabled", message: "꺼짐" };
      },
    });
    await waitFor(() => server.hellos.length === 1);
    expect(await askUpdate(server.sockets[0]!, "0.9.0")).toEqual({
      ok: false,
      reason: "disabled",
      message: "꺼짐",
    });
    expect(requests.map((r) => [r.version, r.enabled])).toEqual([["0.9.0", false]]);
  });

  it("판이 semver 가 아니면 selfUpdate 를 부르지 않고 invalid_version", async () => {
    let called = 0;
    const { server } = await setup({ selfUpdate: async () => (called++, { ok: true }) });
    await waitFor(() => server.hellos.length === 1);
    for (const v of ["latest", "../x", "file:/x", 1]) {
      expect(await askUpdate(server.sockets[0]!, v)).toMatchObject({ ok: false, reason: "invalid_version" });
    }
    expect(called).toBe(0);
  });

  it("selfUpdate 가 없는 러너는 unsupported", async () => {
    const { server } = await setup();
    await waitFor(() => server.hellos.length === 1);
    expect(await askUpdate(server.sockets[0]!, "0.9.0")).toMatchObject({ ok: false, reason: "unsupported" });
  });

  it("busy() 는 도는 런을 센다", async () => {
    const seen: boolean[] = [];
    const { server, fake } = await setup({
      selfUpdate: async (r) => {
        seen.push(r.busy());
        return { ok: false, reason: "busy", message: "런이 끝난 뒤 다시 시도하세요" };
      },
    });
    await waitFor(() => server.hellos.length === 1);
    fake.script({ hang: true });
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => fake.calls.length === 1);
    expect(await askUpdate(server.sockets[0]!, "0.9.0")).toMatchObject({ ok: false, reason: "busy" });
    expect(seen).toEqual([true]);
  });

  // Review Focus 4 — 두 번 눌러도 한 번만 돈다
  it("설치하는 동안 두 번째 runner.update 는 busy, 새 run.start 는 ADAPTER_UNAVAILABLE — 실패하면 다시 받는다", async () => {
    let release!: () => void;
    let calls = 0;
    const { server, fake } = await setup({
      selfUpdate: (r) => {
        calls += 1;
        if (calls > 1) return Promise.resolve({ ok: false, reason: "failed", message: "둘째" });
        return new Promise((resolve) => {
          release = () => resolve({ ok: false, reason: "failed", message: `npm 실패 ${r.version}` });
        });
      },
    });
    await waitFor(() => server.hellos.length === 1);
    const first = askUpdate(server.sockets[0]!, "0.9.0");
    await waitFor(() => calls === 1);
    expect(await askUpdate(server.sockets[0]!, "0.9.0")).toEqual({
      ok: false,
      reason: "busy",
      message: "이미 업데이트하는 중입니다",
    });
    const ack = await sendStart(server.sockets[0]!, runStart());
    expect(ack).toMatchObject({ runId: RUN_ID, admission: "dispatch" });
    await waitFor(() => server.errors.length === 1);
    expect(server.errors[0]).toMatchObject({ runId: RUN_ID, code: "ADAPTER_UNAVAILABLE" });
    expect(fake.calls).toHaveLength(0);
    release();
    expect(await first).toEqual({ ok: false, reason: "failed", message: "npm 실패 0.9.0" });
    expect(calls).toBe(1);
    // 실패한 뒤에는 다시 받는다
    expect(await askUpdate(server.sockets[0]!, "0.9.0")).toEqual({
      ok: false,
      reason: "failed",
      message: "둘째",
    });
  });

  it("성공 — beforeRestart 가 ok 를 답하고 연결을 끊는다(다시 붙지 않는다)", async () => {
    const { server, logs } = await setup({
      selfUpdate: async (r) => {
        await r.beforeRestart();
        return { ok: true };
      },
    });
    await waitFor(() => server.hellos.length === 1);
    expect(await askUpdate(server.sockets[0]!, "0.9.0")).toEqual({ ok: true });
    await waitFor(() => server.sockets[0]!.disconnected);
    await new Promise((r) => setTimeout(r, 120));
    expect(server.hellos).toHaveLength(1);
    expect(logs.join("\n")).toContain("새 판으로 다시 띄웁니다");
  });

  // 리뷰 M1 — 연결을 닫은 뒤 다시 띄우기가 던지면 산 프로세스가 영영 붙지 않는다
  it("beforeRestart 뒤 selfUpdate 가 던지면(spawn 실패) 지금 판으로 다시 붙고, 다시 업데이트를 받는다", async () => {
    let calls = 0;
    const { server, logs } = await setup({
      selfUpdate: async (r) => {
        calls += 1;
        if (calls > 1) return { ok: false, reason: "busy", message: "둘째" };
        await r.beforeRestart();
        throw new Error("spawn EAGAIN");
      },
    });
    await waitFor(() => server.hellos.length === 1);
    expect(await askUpdate(server.sockets[0]!, "0.9.0")).toEqual({ ok: true });
    await waitFor(() => server.hellos.length === 2);
    expect(logs.join("\n")).toContain("지금 판으로 다시 붙습니다");
    expect(await askUpdate(server.sockets.at(-1)!, "0.9.0")).toEqual({
      ok: false,
      reason: "busy",
      message: "둘째",
    });
  });
});

describe("백그라운드 작업 프레임(백그라운드 작업 스펙 5.3·5.4)", () => {
  const TASK = {
    taskId: "b1",
    kind: "shell" as const,
    description: "pnpm dev",
    startedAt: "2026-11-24T00:00:00.000Z",
    originRunId: RUN_ID,
  };
  const heldScript = () => [
    script.init(),
    script.tasksChanged([{ task_id: "b1", task_type: "local_bash", description: "pnpm dev" }]),
    script.taskStarted("b1", { description: "pnpm dev" }),
    ...script.textTurn("msg_1", ["띄웠어요"]),
  ];

  it("announces backgroundTasks", async () => {
    const on = await setup({ background: true });
    await waitFor(() => on.server.hellos.length === 1);
    expect(on.server.hellos[0]!.capabilities).toContain("backgroundTasks");
    const off = await setup();
    await waitFor(() => off.server.hellos.length === 1);
    expect(off.server.hellos[0]!.capabilities).not.toContain("backgroundTasks");
  });

  it("holds only while the last hello result announces backgroundTasks", async () => {
    // 옛 서버 — 표시가 없으면 작업이 남아도 첫 result 에서 닫는다(옛 서버는 붙든 프로세스를 끌 길이 없다)
    const { server, fake } = await setup({
      background: true,
      tasksThrottleMs: 10,
      helloResult: { ok: true, serverVersion: "old" },
    });
    await waitFor(() => server.hellos.length === 1);
    fake.script(...heldScript(), { waitInput: true });
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.finals.length === 1);
    await waitFor(() => fake.calls[0]!.finished);
    expect(fake.calls[0]!.inputClosed).toBe(true);
    // 새 서버로 다시 붙으면 그 연결부터 붙든다 — 연결마다 다시 정한다
    server.helloResult = { ok: true, serverVersion: "new", features: ["backgroundTasks"] };
    server.sockets[0]!.conn.close();
    await waitFor(() => server.hellos.length === 2);
    fake.script(...heldScript(), { waitInput: true });
    await sendStart(server.sockets.at(-1)!, runStart({ runId: RUN_2, sessionId: SESSION_2 }));
    await waitFor(() => server.finals.length === 2);
    await new Promise((r) => setTimeout(r, 60));
    expect(fake.calls[1]!.inputClosed).toBe(false);
    expect(fake.calls[1]!.finished).toBe(false);
  });

  it("throttles tasks.update to once per second per session", async () => {
    const { server, slot } = await setup({ background: true, tasksThrottleMs: 80 });
    await waitFor(() => server.hellos.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    const hooks = slot!.hooks;
    hooks.tasksChanged("k1", [TASK]);
    hooks.tasksChanged("k1", [TASK, { ...TASK, taskId: "b2" }]);
    hooks.tasksChanged("k1", []);
    hooks.tasksChanged("k2", [TASK]);
    await waitFor(() => server.tasksUpdates.length === 2);
    expect(server.tasksUpdates).toEqual([
      { sessionKey: "k1", tasks: [TASK] },
      { sessionKey: "k2", tasks: [TASK] },
    ]);
    // 묶는 동안 온 것은 마지막 값 하나로
    await waitFor(() => server.tasksUpdates.length === 3);
    expect(server.tasksUpdates[2]).toEqual({ sessionKey: "k1", tasks: [] });
    await new Promise((r) => setTimeout(r, 120));
    expect(server.tasksUpdates).toHaveLength(3);
  });

  it("resends tasks after reconnect", async () => {
    const { server, fake } = await setup({ background: true, tasksThrottleMs: 10 });
    await waitFor(() => server.hellos.length === 1);
    fake.script(...heldScript(), { waitInput: true });
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.finals.length === 1);
    await waitFor(() => server.tasksUpdates.length >= 1);
    const key = runStart().deliver.sessionKey;
    expect(server.tasksUpdates.at(-1)).toMatchObject({ sessionKey: key, tasks: [{ taskId: "b1" }] });
    const before = server.tasksUpdates.length;
    server.sockets[0]!.conn.close();
    await waitFor(() => server.hellos.length === 2);
    await waitFor(() => server.tasksUpdates.length === before + 1);
    expect(server.tasksUpdates.at(-1)).toMatchObject({
      sessionKey: key,
      tasks: [{ taskId: "b1", originRunId: RUN_ID }],
    });
    // CLI 는 끊김을 넘어 살아 있다
    expect(fake.calls[0]!.finished).toBe(false);
  });

  it("sends an empty list for sessions emptied while disconnected", async () => {
    // 둘째 핸드셰이크를 한 번 거절해 끊긴 동안이 생기게 한다
    const { server, slot } = await setup({
      background: true,
      tasksThrottleMs: 10,
      reject: (n) => (n === 1 ? "RATE_LIMITED" : undefined),
    });
    await waitFor(() => server.hellos.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    const hooks = slot!.hooks;
    hooks.tasksChanged("k1", [TASK]);
    hooks.tasksChanged("k2", []);
    await waitFor(() => server.tasksUpdates.length === 2);
    server.sockets[0]!.conn.close();
    await waitFor(() => server.handshakes === 2);
    // 끊긴 동안 k1 의 작업이 끝났다 — 이 목록은 버려진다
    hooks.tasksChanged("k1", []);
    await waitFor(() => server.hellos.length === 2);
    await waitFor(() => server.tasksUpdates.length === 3);
    expect(server.tasksUpdates[2]).toEqual({ sessionKey: "k1", tasks: [] });
    // 서버가 이미 빈 목록을 본 k2 는 다시 보내지 않는다
    await new Promise((r) => setTimeout(r, 60));
    expect(server.tasksUpdates).toHaveLength(3);
  });

  it("answers task.stop from the driver", async () => {
    const { server, fake } = await setup({ background: true, tasksThrottleMs: 10 });
    await waitFor(() => server.hellos.length === 1);
    fake.script(...heldScript(), {
      waitStopTask: "b1",
      emit: [
        script.taskUpdated("b1", { status: "killed" }),
        script.taskNotification("b1", "stopped"),
        script.tasksChanged([]),
      ],
    });
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.finals.length === 1);
    const key = runStart().deliver.sessionKey;
    const stop = (taskId: string, sessionKey = key) =>
      server.sockets[0]!.timeout(2000).emitWithAck("task.stop", { sessionKey, taskId });
    expect(await stop("nope")).toEqual({ ok: false });
    expect(await stop("b1")).toEqual({ ok: true });
    expect(fake.calls[0]!.controls).toEqual([{ method: "stopTask", arg: "b1" }]);
    await waitFor(() => fake.calls[0]!.finished);
    await waitFor(() => server.tasksUpdates.at(-1)?.tasks.length === 0);
  });

  it("session.release closes the held process", async () => {
    const { server, fake } = await setup({ background: true, tasksThrottleMs: 10 });
    await waitFor(() => server.hellos.length === 1);
    fake.script(...heldScript(), { waitInput: true });
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.finals.length === 1);
    server.sockets[0]!.emit("session.release", { sessionKey: runStart().deliver.sessionKey });
    await waitFor(() => fake.calls[0]!.finished);
    expect(fake.calls[0]!.inputClosed).toBe(true);
  });

  it("followup times out to unknown", async () => {
    const { server, slot } = await setup({ background: true, followupAckTimeoutMs: 40 });
    await waitFor(() => server.hellos.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    const req = { sessionKey: "k1", originRunId: RUN_ID, taskIds: ["b1"] };
    expect(await slot!.hooks.requestFollowup(req)).toEqual({ ok: false, reason: "unknown" });
    expect(server.followups).toEqual([req]);
    server.onFollowup = (_p, ack) => ack({ ok: false, reason: "archived" });
    expect(await slot!.hooks.requestFollowup(req)).toEqual({ ok: false, reason: "archived" });
  });

  it("a follow-up turn flows to the server under the new run id", async () => {
    const { server, fake } = await setup({ background: true, tasksThrottleMs: 10 });
    await waitFor(() => server.hellos.length === 1);
    const FOLLOW = "0192f000-0000-7000-8000-00000000f001";
    server.onFollowup = (req, ack) =>
      ack({
        ok: true,
        runId: FOLLOW,
        deliver: { ...runStart().deliver, kind: "background", runId: FOLLOW },
      });
    fake.script(
      ...heldScript(),
      { sleep: 10 },
      script.taskNotification("b1", "completed"),
      script.tasksChanged([]),
      script.init(),
      ...script.textTurn("msg_f", ["끝났어요"]),
      { waitInput: true },
    );
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.finals.length === 2);
    expect(server.followups).toEqual([
      { sessionKey: runStart().deliver.sessionKey, originRunId: RUN_ID, taskIds: ["b1"] },
    ]);
    expect(server.finals[1]).toMatchObject({ runId: FOLLOW, text: "끝났어요" });
    expect(server.events.filter((e) => e.runId === FOLLOW).length).toBeGreaterThan(0);
    await waitFor(() => fake.calls[0]!.finished);
  });

  it("a queued ack carries heldSlots while held processes fill the runner", async () => {
    const { server, fake } = await setup({ background: true, maxConcurrentRuns: 1 });
    await waitFor(() => server.hellos.length === 1);
    fake.script(...heldScript(), { waitInput: true });
    await sendStart(server.sockets[0]!, runStart());
    await waitFor(() => server.finals.length === 1);
    const other = runStart({ runId: RUN_2, sessionId: SESSION_2, agentId: "other" });
    const ack = await sendStart(server.sockets[0]!, other);
    expect(ack).toEqual({ runId: RUN_2, admission: "dispatch", queuedPosition: 1, heldSlots: 1 });
  });
});

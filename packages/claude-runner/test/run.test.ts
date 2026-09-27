import { tool } from "@anthropic-ai/claude-agent-sdk";
import { renderRunnerPrompt, type ErrorCode, type RunEventBody } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ABORT_CLOSE_MS,
  buildQueryOptions,
  ENV_ALLOWLIST,
  isSessionInUseText,
  runOnce,
  type RunContext,
} from "../src/run";
import { realSdk, type SdkMcpServer } from "../src/sdk";
import { createFakeSdk, script, type FakeSdk } from "./helpers/fake-query";
import { AGENT, runStart, SESSION_ID } from "./helpers/fixtures";

const BASE_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/u",
  LANG: "ko_KR.UTF-8",
  TERM: "xterm-256color",
  SHELL: "/bin/zsh",
  USER: "u",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  DODOK_RUNNER_TOKEN: "drn_secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  CLAUDE_CONFIG_DIR: "/home/u/.claude",
  HTTPS_PROXY: "http://proxy.corp:3128",
  no_proxy: "localhost,.corp",
  NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-ca.pem",
};
const MCP = { type: "sdk", name: "dodok", instance: { id: 1 } } as unknown as SdkMcpServer;

function deps(resume: boolean) {
  return { claudeConfigDir: "/home/u/.dodok-runner/claude", baseEnv: BASE_ENV, mcpServer: MCP, resume };
}

describe("buildQueryOptions", () => {
  it("새 세션 — sessionId·title, 스펙 4.2 기본값", () => {
    const start = runStart();
    const o = buildQueryOptions(AGENT, start, deps(false));
    expect(o).toMatchObject({
      cwd: AGENT.workdir,
      model: "sonnet",
      permissionMode: "default",
      allowedTools: ["Read", "Bash(git status)"],
      disallowedTools: ["WebFetch"],
      sessionId: SESSION_ID,
      title: "dev · 코더",
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: start.channelRulesAppend,
        snapshot: false,
      },
      strictMcpConfig: true,
      settingSources: [],
      includePartialMessages: true,
    });
    expect(o.resume).toBeUndefined();
    expect(o.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it("resume — sessionId·title 없이 resume 만(판정 P2)", () => {
    const o = buildQueryOptions(AGENT, runStart(), deps(true));
    expect(o.resume).toBe(SESSION_ID);
    expect(o.sessionId).toBeUndefined();
    expect(o.title).toBeUndefined();
  });

  it("dodok MCP 서버 하나만 싣는다 — 받은 인스턴스 그대로", () => {
    const o = buildQueryOptions(AGENT, runStart(), deps(false));
    expect(o.mcpServers?.dodok).toBe(MCP);
    expect(Object.keys(o.mcpServers ?? {})).toEqual(["dodok"]);
  });

  it("실제 SDK 로 만든 dodok 서버는 도구마다 alwaysLoad 표시를 싣는다(CLI 는 띄우지 않는다)", () => {
    const server = realSdk.createMcpServer([
      tool("post", "d", { text: z.string() }, async () => ({ content: [] })),
    ]);
    expect(server).toMatchObject({ type: "sdk", name: "dodok" });
    const registered = (
      server.instance as unknown as { _registeredTools: Record<string, { _meta?: unknown }> }
    )._registeredTools;
    expect(registered.post?._meta).toEqual({ "anthropic/alwaysLoad": true });
  });

  it("env 는 허용 목록 + CLAUDE_CONFIG_DIR + 자동 메모리 끔 — 러너 env 의 비밀은 CLI 로 가지 않는다", () => {
    const o = buildQueryOptions(AGENT, runStart(), deps(false));
    expect(o.env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/u",
      LANG: "ko_KR.UTF-8",
      TERM: "xterm-256color",
      SHELL: "/bin/zsh",
      USER: "u",
      HTTPS_PROXY: "http://proxy.corp:3128",
      no_proxy: "localhost,.corp",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-ca.pem",
      CLAUDE_CONFIG_DIR: "/home/u/.dodok-runner/claude",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
    const serialized = JSON.stringify(o.env);
    for (const secret of ["sk-ant-secret", "drn_secret", "aws-secret", "ANTHROPIC_API_KEY", "AWS_SECRET"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(ENV_ALLOWLIST).toEqual([
      "PATH",
      "HOME",
      "LANG",
      "LC_ALL",
      "TERM",
      "TMPDIR",
      "SHELL",
      "USER",
      // 사내 프록시·사설 CA 뒤에서 CLI 가 API 에 닿으려면 필요하다 — 비밀이 아니다
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "NO_PROXY",
      "no_proxy",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
    ]);
  });

  it("UserPromptSubmit 훅이 turnFacts 를 additionalContext 로 돌려준다", async () => {
    const start = runStart();
    const o = buildQueryOptions(AGENT, start, deps(false));
    const hook = o.hooks?.UserPromptSubmit?.[0]?.hooks[0];
    const out = await hook?.({} as never, undefined, { signal: new AbortController().signal });
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: start.turnFacts },
    });
  });

  it("canUseTool 은 주면 싣고 안 주면 뺀다", () => {
    const canUseTool = async () => ({ behavior: "deny" as const, message: "no" });
    expect(buildQueryOptions(AGENT, runStart(), { ...deps(false), canUseTool }).canUseTool).toBe(canUseTool);
    expect("canUseTool" in buildQueryOptions(AGENT, runStart(), deps(false))).toBe(false);
  });
});

type Emitted =
  | { kind: "event"; event: RunEventBody }
  | { kind: "final"; final: Record<string, unknown> }
  | { kind: "error"; code: ErrorCode; message: string };

function harness(fake: FakeSdk = createFakeSdk(), opts: Partial<RunContext> = {}) {
  const emitted: Emitted[] = [];
  const controller = new AbortController();
  const ctx: RunContext = {
    sdk: fake,
    agent: AGENT,
    claudeConfigDir: "/home/u/.dodok-runner/claude",
    baseEnv: BASE_ENV,
    costs: new Map(),
    signal: controller.signal,
    closeGraceMs: 30,
    emit: {
      event: (event) => emitted.push({ kind: "event", event }),
      final: (final) => emitted.push({ kind: "final", final }),
      error: (code, message) => emitted.push({ kind: "error", code, message }),
    },
    ...opts,
  };
  return { fake, ctx, emitted, controller };
}

const finals = (e: Emitted[]) => e.filter((x) => x.kind === "final");
const errors = (e: Emitted[]) => e.filter((x) => x.kind === "error");

describe("runOnce", () => {
  it("프롬프트 하나를 보내고 스트림을 이벤트로, result 를 final 로 — 끝나면 입력을 닫는다", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(script.init(), ...script.textTurn("msg_1", ["안녕 ", "하세요"]));
    const start = runStart();
    await runOnce(start, ctx);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.prompt).toMatchObject({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: renderRunnerPrompt(start.deliver) },
    });
    expect(fake.calls[0]!.inputClosed).toBe(true);
    // 입력은 result 까지 열려 있어야 한다 — 닫으면 권한 콜백·SDK MCP 가 멈춘다(리뷰 M2)
    expect(fake.calls[0]!.inputEndedBeforeResult).toBe(false);
    expect(fake.calls[0]!.options.sessionId).toBe(SESSION_ID);
    expect(fake.servers).toEqual([[]]);
    expect(emitted.map((e) => (e.kind === "event" ? e.event.type : e.kind))).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "final",
    ]);
    expect(finals(emitted)[0]).toMatchObject({
      final: { text: "안녕 하세요", stopReason: "end_turn", costKind: "subscription_estimate" },
    });
  });

  it("전사가 있으면 resume 으로 연다(판정 P2)", async () => {
    const { fake, ctx } = harness();
    fake.sessions.add(SESSION_ID);
    fake.script(...script.textTurn("msg_1", ["x"]));
    await runOnce(runStart(), ctx);
    expect(fake.calls[0]!.options.resume).toBe(SESSION_ID);
    expect(fake.calls[0]!.options.sessionId).toBeUndefined();
  });

  it("resume 직후 num_turns 0 result 는 건너뛰고 프롬프트 턴의 result 로 끝낸다", async () => {
    const { fake, ctx, emitted } = harness();
    fake.sessions.add(SESSION_ID);
    fake.script(script.success("", { num_turns: 0 }), ...script.textTurn("msg_1", ["진짜 답"]));
    await runOnce(runStart(), ctx);
    expect(finals(emitted)).toHaveLength(1);
    expect(finals(emitted)[0]).toMatchObject({ final: { text: "진짜 답" } });
  });

  it("마지막 result 뒤 반복자가 던지면 오류가 아니다(CLI exit 1)", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(...script.textTurn("msg_1", ["답"]), {
      throw: new Error("Claude Code process exited with code 1"),
    });
    await runOnce(runStart(), ctx);
    expect(finals(emitted)).toHaveLength(1);
    expect(errors(emitted)).toEqual([]);
  });

  it("result 전에 던지면 run.error — 인증 표지면 PROVIDER_AUTH, 경로 원문은 가린다", async () => {
    const auth = harness();
    auth.fake.script(script.init(), {
      throw: new Error("authentication_failed: Not logged in · Please run /login"),
    });
    await runOnce(runStart(), auth.ctx);
    expect(errors(auth.emitted)).toEqual([
      { kind: "error", code: "PROVIDER_AUTH", message: expect.any(String) },
    ]);

    const other = harness();
    other.fake.script({ throw: new Error("spawn failed at /home/u/src/my-repo/x and /opt/claude") });
    await runOnce(runStart(), other.ctx);
    const [err] = errors(other.emitted);
    expect(err).toMatchObject({ code: "INTERNAL" });
    expect(err?.kind === "error" && err.message).not.toMatch(/\/home|\/opt/);
    expect(finals(other.emitted)).toEqual([]);
  });

  it("query() 가 곧바로 던져도 run.error 로 알린다 — 런이 조용히 사라지지 않는다", async () => {
    const fake = createFakeSdk();
    const { ctx, emitted } = harness({
      ...fake,
      query: () => {
        throw new Error("Claude Code executable not found at /opt/x/claude");
      },
    });
    await runOnce(runStart(), ctx);
    expect(errors(emitted)).toMatchObject([{ code: "INTERNAL" }]);
    expect(JSON.stringify(emitted)).not.toContain("/opt");
  });

  it("result 없이 끝나면 INTERNAL", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(script.init(), { exit: true });
    await runOnce(runStart(), ctx);
    expect(errors(emitted)).toMatchObject([{ code: "INTERNAL" }]);
  });

  it("result 의 error_* 는 run.error 로 한 번만", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(script.errorResult("error_max_turns", ["턴 초과"]));
    await runOnce(runStart(), ctx);
    expect(errors(emitted)).toEqual([{ kind: "error", code: "INTERNAL", message: "턴 초과" }]);
  });

  it("세션 누적 비용 — 새 세션은 그대로, 이어 간 런은 직전 누적값과의 차이", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(...script.textTurn("msg_1", ["a"], "a", { total_cost_usd: 0.3 }));
    await runOnce(runStart(), ctx);
    fake.sessions.add(SESSION_ID);
    fake.script(...script.textTurn("msg_2", ["b"], "b", { total_cost_usd: 0.5 }));
    await runOnce(runStart(), ctx);
    const [first, second] = finals(emitted);
    expect(first?.kind === "final" && first.final.costUsd).toBeCloseTo(0.3);
    expect(second?.kind === "final" && second.final.costUsd).toBeCloseTo(0.2);
  });

  it("러너 재시작 뒤 첫 이어 가기는 누적값을 모르므로 costUsd 를 싣지 않는다 — 토큰 수는 싣는다", async () => {
    const { fake, ctx, emitted } = harness();
    fake.sessions.add(SESSION_ID);
    fake.script(...script.textTurn("msg_1", ["a"], "a", { total_cost_usd: 1.25 }));
    await runOnce(runStart(), ctx);
    const [f] = finals(emitted);
    expect(f?.kind === "final" && "costUsd" in f.final).toBe(false);
    expect(f).toMatchObject({ final: { usage: { inputTokens: 10, outputTokens: 5 } } });
    expect(ctx.costs.get(SESSION_ID)).toBe(1.25);
  });

  it("costKind — API 키 로그인이면 api", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(script.init("ANTHROPIC_API_KEY"), ...script.textTurn("msg_1", ["a"]));
    await runOnce(runStart(), ctx);
    expect(finals(emitted)[0]).toMatchObject({ final: { costKind: "api" } });
  });

  const ABORTED = {
    kind: "final",
    final: { text: "", stopReason: "aborted", costKind: "subscription_estimate" },
  };

  it("중지 — interrupt 를 부르고, interrupt 로 끝난 턴은 final aborted 한 번(판정 R1) — run.event 로 수명을 내지 않는다", async () => {
    const { fake, ctx, emitted, controller } = harness();
    fake.script(script.messageStart("msg_1"), {
      waitInterrupt: [script.errorResult("error_during_execution", ["[ede_diagnostic] stop_reason=null"])],
    });
    const done = runOnce(runStart(), ctx);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await done;
    expect(fake.calls[0]!.interrupts).toBe(1);
    expect(emitted).toEqual([
      {
        kind: "final",
        final: {
          text: "",
          stopReason: "aborted",
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd: 0,
          costKind: "subscription_estimate",
        },
      },
    ]);
  });

  it("interrupt 뒤 result 의 누적 비용 차이를 final aborted 의 costUsd 로 싣는다", async () => {
    const { fake, ctx, emitted, controller } = harness();
    fake.sessions.add(SESSION_ID);
    ctx.costs.set(SESSION_ID, 0.5);
    fake.script(script.messageStart("msg_1"), {
      waitInterrupt: [script.errorResult("error_during_execution", ["x"], { total_cost_usd: 0.62 })],
    });
    const done = runOnce(runStart(), ctx);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await done;
    const [f] = finals(emitted);
    expect(f).toMatchObject({ final: { stopReason: "aborted", text: "" } });
    expect(f?.kind === "final" && f.final.costUsd).toBeCloseTo(0.12);
    expect(ctx.costs.get(SESSION_ID)).toBe(0.62);
  });

  it("중지에 반응하지 않으면 유예 뒤 close() — 그래도 final aborted 로 닫는다", async () => {
    const { fake, ctx, emitted, controller } = harness();
    fake.script(script.messageStart("msg_1"), { hang: true });
    const done = runOnce(runStart(), ctx);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.calls[0]!.closes).toBe(0);
    await done;
    expect(fake.calls[0]!.closes).toBeGreaterThanOrEqual(1);
    expect(emitted).toEqual([ABORTED]);
    expect(ABORT_CLOSE_MS).toBe(5000);
  });

  it("중지 뒤 반복자가 던져도 final aborted", async () => {
    const { fake, ctx, emitted, controller } = harness();
    fake.script(
      script.messageStart("msg_1"),
      { waitInterrupt: [] },
      { throw: new Error("exited with code 143") },
    );
    const done = runOnce(runStart(), ctx);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await done;
    expect(emitted).toEqual([ABORTED]);
  });

  it("시작 전에 중지됐으면 CLI 를 띄우지 않고 final aborted", async () => {
    const { fake, ctx, emitted, controller } = harness();
    controller.abort();
    await runOnce(runStart(), ctx);
    expect(fake.calls).toEqual([]);
    expect(emitted).toEqual([ABORTED]);
  });

  it("전사를 확인하는 사이 중지되면 CLI 를 띄우지 않고 final aborted", async () => {
    const fake = createFakeSdk();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { ctx, emitted, controller } = harness({
      ...fake,
      sessionExists: async () => {
        await gate;
        return false;
      },
    });
    const done = runOnce(runStart(), ctx);
    controller.abort();
    release();
    await done;
    expect(fake.calls).toEqual([]);
    expect(emitted).toEqual([ABORTED]);
  });
});

describe("runOnce — 전사가 없다고 봤는데 CLI 가 「이미 있는 세션」으로 거절하면 resume 으로 한 번 다시(리뷰 M3)", () => {
  const IN_USE = `Claude Code process exited with code 1\nError: Session ID ${SESSION_ID} is already in use.`;

  it("sessionId 로 연 첫 시도가 거절되면 resume 으로 다시 열어 끝낸다 — 오류를 내지 않는다", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script({ throw: new Error(IN_USE) });
    fake.script(script.init(), ...script.textTurn("msg_1", ["이어서"]));
    await runOnce(runStart(), ctx);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.options.sessionId).toBe(SESSION_ID);
    expect(fake.calls[1]!.options.resume).toBe(SESSION_ID);
    expect(fake.calls[1]!.options.sessionId).toBeUndefined();
    expect(errors(emitted)).toEqual([]);
    expect(finals(emitted)).toMatchObject([{ final: { text: "이어서" } }]);
  });

  it("다시 연 것도 거절되면 한 번만 — run.error", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script({ throw: new Error(IN_USE) });
    fake.script({ throw: new Error(IN_USE) });
    await runOnce(runStart(), ctx);
    expect(fake.calls).toHaveLength(2);
    expect(errors(emitted)).toMatchObject([{ code: "INTERNAL" }]);
  });

  it("resume 으로 연 런·다른 오류·스트림이 시작된 뒤의 거절은 다시 열지 않는다", async () => {
    const resumed = harness();
    resumed.fake.sessions.add(SESSION_ID);
    resumed.fake.script({ throw: new Error(IN_USE) });
    await runOnce(runStart(), resumed.ctx);
    expect(resumed.fake.calls).toHaveLength(1);

    const other = harness();
    other.fake.script({ throw: new Error("Claude Code process exited with code 1\nError: boom") });
    await runOnce(runStart(), other.ctx);
    expect(other.fake.calls).toHaveLength(1);

    const late = harness();
    late.fake.script(script.messageStart("msg_1"), { throw: new Error(IN_USE) });
    await runOnce(runStart(), late.ctx);
    expect(late.fake.calls).toHaveLength(1);
    expect(errors(late.emitted)).toHaveLength(1);
  });

  it("거절 문구 판별 — CLI 문구와 그 변형을 넓게", () => {
    expect(isSessionInUseText(IN_USE)).toBe(true);
    expect(isSessionInUseText("error: session id abc is already in use")).toBe(true);
    expect(isSessionInUseText("Session 0192 already exists")).toBe(true);
    expect(isSessionInUseText("address already in use")).toBe(false);
    expect(isSessionInUseText("Claude Code process exited with code 1")).toBe(false);
  });
});

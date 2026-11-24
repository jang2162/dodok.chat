import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  type AppMcpCeiling,
  CONTROL_TOOLS,
  RUNNER_CONTROL_TOOLS,
  type RunnerRunBot,
  renderRunnerPrompt,
  RUNNER_BOT_SOUL_HEADER,
  type ErrorCode,
  type RunEventBody,
} from "@dodok/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ABORT_CLOSE_MS,
  assembleBotMcp,
  buildQueryOptions,
  isAutoAllowedTool,
  preToolDecision,
  ENV_ALLOWLIST,
  isSessionInUseText,
  runOnce,
  supportsThinkingDisplay,
  THINKING_DISPLAY_MIN_CLI,
  RUNNER_DISALLOWED_TOOLS,
  type RunContext,
  writeSoul,
} from "../src/drivers/claude/run";
import { CONTROL_TOOL_FULL_NAMES, RUNNER_CONTROL_TOOL_FULL_NAMES } from "../src/control-tools";
import { POST_STOPPED_MESSAGE, POST_TOOL_FULL_NAME } from "../src/post-tool";
import { realSdk, type SdkContextUsage, type SdkMcpServer } from "../src/drivers/claude/sdk";
import { toContextBreakdown } from "../src/drivers/claude/context-usage";
import { createRunSink } from "../src/sink";
import { alwaysAllowKey } from "../src/drivers/claude/approvals";
import { toAgentCommands } from "../src/drivers/claude";
import { createFakeBridge, type FakeBridge } from "./helpers/fake-bridge";
import { createFakeSdk, FAKE_CONTEXT_USAGE, script, type FakeSdk } from "./helpers/fake-query";
import { AGENT, runSpec, runStart, SESSION_ID } from "./helpers/fixtures";

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
  return { baseEnv: BASE_ENV, mcpServer: MCP, resume };
}

/** run.start 를 고친 런 — 작업 디렉터리 등은 runSpec 그대로 */
const specOf = (start: ReturnType<typeof runStart>) => ({
  ...runSpec(),
  start: { ...start, providerSessionId: start.providerSessionId! },
});

describe("buildQueryOptions", () => {
  it("새 세션 — sessionId·title, 스펙 4.2 기본값", () => {
    const start = runStart();
    const o = buildQueryOptions(specOf(start), deps(false));
    expect(o).toMatchObject({
      cwd: AGENT.workdir,
      model: "sonnet",
      permissionMode: "default",
      // dodok 도구는 늘 허용 — 승인 콜백이 입력 검증보다 먼저 온다(스펙 6장). 제어 도구의 쓰기는 서버 확인 카드가 묻는다
      allowedTools: ["Read", "Bash(git status)", "mcp__dodok__post", ...CONTROL_TOOL_FULL_NAMES],
      disallowedTools: [...RUNNER_DISALLOWED_TOOLS, "WebFetch"],
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

  it("사람 대화형·예약 도구는 기본으로 막는다 — 설정의 disallowedTools 와 합치고 겹치면 한 번 [최종 리뷰 P2]", () => {
    expect(RUNNER_DISALLOWED_TOOLS).toEqual([
      "AskUserQuestion",
      "PushNotification",
      "ScheduleWakeup",
      "CronCreate",
      "CronDelete",
      "CronList",
      "RemoteTrigger",
    ]);
    const o = buildQueryOptions(runSpec({ disallowedTools: ["AskUserQuestion", "WebFetch"] }), deps(false));
    expect(o.disallowedTools).toEqual([...RUNNER_DISALLOWED_TOOLS, "WebFetch"]);
  });

  it("effort — 값이면 SDK 옵션 effort, null·없음이면 키가 없다 [세션 설정 스펙 5.6]", () => {
    expect(buildQueryOptions(runSpec({ effort: "high" }), deps(false)).effort).toBe("high");
    expect(buildQueryOptions(runSpec({ effort: null }), deps(false))).not.toHaveProperty("effort");
    expect(buildQueryOptions(runSpec(), deps(false))).not.toHaveProperty("effort");
  });

  it("thinkingDisplay 면 CLI 플래그 --thinking-display summarized 만 넘긴다 — SDK thinking(type 까지 정함)은 넘기지 않는다", () => {
    const on = buildQueryOptions(runSpec(), { ...deps(false), thinkingDisplay: true });
    expect(on.extraArgs).toEqual({ "thinking-display": "summarized" });
    expect(on).not.toHaveProperty("thinking");
    expect(on).not.toHaveProperty("maxThinkingTokens");
    expect(buildQueryOptions(runSpec(), deps(false))).not.toHaveProperty("extraArgs");
  });

  it("supportsThinkingDisplay — 판을 모르거나 2.1.283 보다 낮으면 false(모르는 플래그는 CLI 를 실패시킨다)", () => {
    expect(THINKING_DISPLAY_MIN_CLI).toBe("2.1.283");
    expect(supportsThinkingDisplay("2.1.283")).toBe(true);
    expect(supportsThinkingDisplay("2.1.331")).toBe(true);
    expect(supportsThinkingDisplay("2.2.0")).toBe(true);
    expect(supportsThinkingDisplay("2.1.282")).toBe(false);
    expect(supportsThinkingDisplay("1.9.999")).toBe(false);
    expect(supportsThinkingDisplay(undefined)).toBe(false);
    expect(supportsThinkingDisplay("(판 모름)")).toBe(false);
  });

  it("bypassPermissions 일 때만 allowDangerouslySkipPermissions — auto 는 SDK 에 그대로 넘긴다 [채널 UI·권한 모드 스펙 1장]", () => {
    const bypass = buildQueryOptions(runSpec({ permissionMode: "bypassPermissions" }), deps(false));
    expect(bypass).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    const auto = buildQueryOptions(runSpec({ permissionMode: "auto" }), deps(false));
    expect(auto.permissionMode).toBe("auto");
    for (const mode of ["plan", "dontAsk", "default", "acceptEdits", "auto"] as const)
      expect(buildQueryOptions(runSpec({ permissionMode: mode }), deps(false)), mode).not.toHaveProperty(
        "allowDangerouslySkipPermissions",
      );
  });

  it("allowedTools null — 미리 허용한 도구 없음, dodok 도구만(태스크 2 리뷰 M2)", () => {
    const o = buildQueryOptions(runSpec({ allowedTools: null }), deps(false));
    expect(o.allowedTools).toEqual([POST_TOOL_FULL_NAME, ...CONTROL_TOOL_FULL_NAMES]);
  });

  it("resume — sessionId·title 없이 resume 만(판정 P2)", () => {
    const o = buildQueryOptions(runSpec(), deps(true));
    expect(o.resume).toBe(SESSION_ID);
    expect(o.sessionId).toBeUndefined();
    expect(o.title).toBeUndefined();
  });

  it("dodok MCP 서버 하나만 싣는다 — 받은 인스턴스 그대로", () => {
    const o = buildQueryOptions(runSpec(), deps(false));
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
    const o = buildQueryOptions(runSpec(), deps(false));
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

  it("configDir 이 없으면 baseEnv 의 CLAUDE_CONFIG_DIR 을 CLI 에 — 러너 프로세스와 같은 자리", () => {
    const { configDir: _dedicated, ...spec } = runSpec();
    const o = buildQueryOptions(spec, deps(false));
    expect(BASE_ENV.CLAUDE_CONFIG_DIR).toBe("/home/u/.claude");
    expect(o.env?.CLAUDE_CONFIG_DIR).toBe("/home/u/.claude");
  });

  it("configDir 도 baseEnv 값도 없으면 CLAUDE_CONFIG_DIR 을 넣지 않는다", () => {
    const { configDir: _dedicated, ...spec } = runSpec();
    for (const value of [undefined, ""]) {
      const { CLAUDE_CONFIG_DIR: _shell, ...rest } = BASE_ENV;
      const baseEnv = value === undefined ? rest : { ...rest, CLAUDE_CONFIG_DIR: value };
      const o = buildQueryOptions(spec, { baseEnv, mcpServer: MCP, resume: false });
      expect("CLAUDE_CONFIG_DIR" in (o.env ?? {})).toBe(false);
      expect(o.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    }
  });

  it("UserPromptSubmit 훅이 turnFacts 를 additionalContext 로 돌려준다", async () => {
    const start = runStart();
    const o = buildQueryOptions(specOf(start), deps(false));
    const hook = o.hooks?.UserPromptSubmit?.[0]?.hooks[0];
    const out = await hook?.({} as never, undefined, { signal: new AbortController().signal });
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: start.turnFacts },
    });
  });

  it("canUseTool 은 주면 싣고 안 주면 뺀다", () => {
    const canUseTool = async () => ({ behavior: "deny" as const, message: "no" });
    expect(buildQueryOptions(runSpec(), { ...deps(false), canUseTool }).canUseTool).toBe(canUseTool);
    expect("canUseTool" in buildQueryOptions(runSpec(), deps(false))).toBe(false);
  });
});

type Emitted =
  | { kind: "event"; event: RunEventBody }
  | { kind: "final"; final: Record<string, unknown> }
  | { kind: "error"; code: ErrorCode; message: string };

function harness(
  fake: FakeSdk = createFakeSdk(),
  opts: Partial<Omit<RunContext, "sink">> & { bridge?: FakeBridge } = {},
) {
  const emitted: Emitted[] = [];
  const controller = new AbortController();
  const { bridge = createFakeBridge(), ...rest } = opts;
  const ctx: RunContext = {
    sdk: fake,
    sink: createRunSink({
      workdir: AGENT.workdir,
      bridge,
      emit: {
        event: (event) => emitted.push({ kind: "event", event }),
        final: (final) => emitted.push({ kind: "final", final }),
        error: (code, message) => emitted.push({ kind: "error", code, message }),
        session: () => {},
      },
    }),
    baseEnv: BASE_ENV,
    costs: new Map(),
    signal: controller.signal,
    closeGraceMs: 30,
    ...rest,
  };
  return { fake, ctx, emitted, controller, bridge };
}

const finals = (e: Emitted[]) => e.filter((x) => x.kind === "final");
const errors = (e: Emitted[]) => e.filter((x) => x.kind === "error");

describe("runOnce", () => {
  it("프롬프트 하나를 보내고 스트림을 이벤트로, result 를 final 로 — 끝나면 입력을 닫는다", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(script.init(), ...script.textTurn("msg_1", ["안녕 ", "하세요"]));
    const start = runStart();
    await runOnce(specOf(start), ctx);
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
    expect(fake.servers.map((tools) => tools.map((t) => t.name))).toEqual([
      ["post", ...CONTROL_TOOLS.map((t) => t.name)],
    ]);
    expect(fake.calls[0]!.options.canUseTool).toBeTypeOf("function");
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

  it("설치본 경로를 받으면 pathToClaudeCodeExecutable 로 넘긴다 — 없으면 넘기지 않는다(번들 CLI)", async () => {
    const withExe = buildQueryOptions(runSpec(), { ...deps(false), executable: "/usr/local/bin/claude" });
    expect(withExe.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
    const { fake, ctx } = harness(createFakeSdk(), { executable: "/opt/c/claude" });
    fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
    await runOnce(runSpec(), ctx);
    expect(fake.calls[0]!.options.pathToClaudeCodeExecutable).toBe("/opt/c/claude");
  });

  it("cliVersion 이 플래그를 아는 판일 때만 --thinking-display 를 싣는다", async () => {
    for (const [cliVersion, expected] of [
      ["2.1.283", { "thinking-display": "summarized" }],
      ["2.1.200", undefined],
      [undefined, undefined],
    ] as const) {
      const { fake, ctx } = harness(createFakeSdk(), cliVersion === undefined ? {} : { cliVersion });
      fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
      await runOnce(runSpec(), ctx);
      expect(fake.calls[0]!.options.extraArgs).toEqual(expected);
    }
  });

  it("전사가 있으면 resume 으로 연다(판정 P2)", async () => {
    const { fake, ctx } = harness();
    fake.sessions.add(SESSION_ID);
    fake.script(...script.textTurn("msg_1", ["x"]));
    await runOnce(runSpec(), ctx);
    expect(fake.calls[0]!.options.resume).toBe(SESSION_ID);
    expect(fake.calls[0]!.options.sessionId).toBeUndefined();
  });

  it("세션을 연 길을 러너 로그에 남긴다 — 새로·resume·전사 확인 실패", async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const runId = runSpec().start.deliver.runId;

    const fresh = harness(createFakeSdk(), { log });
    fresh.fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
    await runOnce(runSpec(), fresh.ctx);

    const resumed = harness(createFakeSdk(), { log });
    resumed.fake.sessions.add(SESSION_ID);
    resumed.fake.script(...script.textTurn("msg_1", ["x"]));
    await runOnce(runSpec(), resumed.ctx);

    const broken = createFakeSdk();
    const failing = harness(
      {
        ...broken,
        sessionExists: async () => {
          throw new Error("unreadable");
        },
      },
      { log },
    );
    broken.script(script.init(), ...script.textTurn("msg_1", ["x"]));
    await runOnce(runSpec(), failing.ctx);

    expect(lines).toEqual([
      `dodok-runner: 런 ${runId} 세션 새로 열기`,
      `dodok-runner: 런 ${runId} 세션 resume`,
      `dodok-runner: 런 ${runId} 세션 새로 열기(전사 확인 실패)`,
    ]);
  });

  it("resume 직후 num_turns 0 result 는 건너뛰고 프롬프트 턴의 result 로 끝낸다", async () => {
    const { fake, ctx, emitted } = harness();
    fake.sessions.add(SESSION_ID);
    fake.script(script.success("", { num_turns: 0 }), ...script.textTurn("msg_1", ["진짜 답"]));
    await runOnce(runSpec(), ctx);
    expect(finals(emitted)).toHaveLength(1);
    expect(finals(emitted)[0]).toMatchObject({ final: { text: "진짜 답" } });
  });

  it("마지막 result 뒤 반복자가 던지면 오류가 아니다(CLI exit 1)", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(...script.textTurn("msg_1", ["답"]), {
      throw: new Error("Claude Code process exited with code 1"),
    });
    await runOnce(runSpec(), ctx);
    expect(finals(emitted)).toHaveLength(1);
    expect(errors(emitted)).toEqual([]);
  });

  it("result 전에 던지면 run.error — 인증 표지면 PROVIDER_AUTH, 경로 원문은 가린다", async () => {
    const auth = harness();
    auth.fake.script(script.init(), {
      throw: new Error("authentication_failed: Not logged in · Please run /login"),
    });
    await runOnce(runSpec(), auth.ctx);
    expect(errors(auth.emitted)).toEqual([
      { kind: "error", code: "PROVIDER_AUTH", message: expect.any(String) },
    ]);

    const other = harness();
    other.fake.script({ throw: new Error("spawn failed at /home/u/src/my-repo/x and /opt/claude") });
    await runOnce(runSpec(), other.ctx);
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
    await runOnce(runSpec(), ctx);
    expect(errors(emitted)).toMatchObject([{ code: "INTERNAL" }]);
    expect(JSON.stringify(emitted)).not.toContain("/opt");
  });

  it("result 없이 끝나면 INTERNAL", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(script.init(), { exit: true });
    await runOnce(runSpec(), ctx);
    expect(errors(emitted)).toMatchObject([{ code: "INTERNAL" }]);
  });

  it("result 의 error_* 는 run.error 로 한 번만", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(script.errorResult("error_max_turns", ["턴 초과"]));
    await runOnce(runSpec(), ctx);
    expect(errors(emitted)).toEqual([{ kind: "error", code: "INTERNAL", message: "턴 초과" }]);
  });

  it("세션 누적 비용 — 새 세션은 그대로, 이어 간 런은 직전 누적값과의 차이", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(...script.textTurn("msg_1", ["a"], "a", { total_cost_usd: 0.3 }));
    await runOnce(runSpec(), ctx);
    fake.sessions.add(SESSION_ID);
    fake.script(...script.textTurn("msg_2", ["b"], "b", { total_cost_usd: 0.5 }));
    await runOnce(runSpec(), ctx);
    const [first, second] = finals(emitted);
    expect(first?.kind === "final" && first.final.costUsd).toBeCloseTo(0.3);
    expect(second?.kind === "final" && second.final.costUsd).toBeCloseTo(0.2);
  });

  it("러너 재시작 뒤 첫 이어 가기는 누적값을 모르므로 costUsd 를 싣지 않는다 — 토큰 수는 싣는다", async () => {
    const { fake, ctx, emitted } = harness();
    fake.sessions.add(SESSION_ID);
    fake.script(...script.textTurn("msg_1", ["a"], "a", { total_cost_usd: 1.25 }));
    await runOnce(runSpec(), ctx);
    const [f] = finals(emitted);
    expect(f?.kind === "final" && "costUsd" in f.final).toBe(false);
    expect(f).toMatchObject({ final: { usage: { inputTokens: 10, outputTokens: 5 } } });
    expect(ctx.costs.get(SESSION_ID)).toBe(1.25);
  });

  it("costKind — API 키 로그인이면 api", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(script.init("ANTHROPIC_API_KEY"), ...script.textTurn("msg_1", ["a"]));
    await runOnce(runSpec(), ctx);
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
    const done = runOnce(runSpec(), ctx);
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
    const done = runOnce(runSpec(), ctx);
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
    const done = runOnce(runSpec(), ctx);
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
    const done = runOnce(runSpec(), ctx);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await done;
    expect(emitted).toEqual([ABORTED]);
  });

  it("result 없이 끝나거나 던진 중지 턴도 init 에서 본 costKind 를 싣는다", async () => {
    for (const tail of [{ exit: true as const }, { throw: new Error("exited with code 143") }]) {
      const { fake, ctx, emitted, controller } = harness();
      fake.script(
        script.init("ANTHROPIC_API_KEY"),
        script.messageStart("msg_1"),
        { waitInterrupt: [] },
        tail,
      );
      const done = runOnce(runSpec(), ctx);
      await new Promise((r) => setTimeout(r, 5));
      controller.abort();
      await done;
      expect(emitted).toEqual([
        { kind: "final", final: { text: "", stopReason: "aborted", costKind: "api" } },
      ]);
    }
  });

  it("러너를 끄느라 멈춘 턴(signal reason runner_shutdown)은 어느 끝이든 final runner_shutdown — 사람 중지와 가른다", async () => {
    const tails = [
      [script.errorResult("error_during_execution", ["x"])],
      [{ exit: true as const }],
      [{ throw: new Error("exited with code 143") }],
    ];
    for (const tail of tails) {
      const { fake, ctx, emitted, controller } = harness();
      fake.script(script.messageStart("msg_1"), { waitInterrupt: [] }, ...tail);
      const done = runOnce(runSpec(), ctx);
      await new Promise((r) => setTimeout(r, 5));
      controller.abort("runner_shutdown");
      await done;
      expect(finals(emitted)).toEqual([
        expect.objectContaining({
          final: expect.objectContaining({ text: "", stopReason: "runner_shutdown" }),
        }),
      ]);
    }
    const { fake, ctx, emitted, controller } = harness();
    controller.abort("runner_shutdown");
    await runOnce(runSpec(), ctx);
    expect(fake.calls).toEqual([]);
    expect(emitted).toEqual([{ ...ABORTED, final: { ...ABORTED.final, stopReason: "runner_shutdown" } }]);
  });

  it("시작 전에 중지됐으면 CLI 를 띄우지 않고 final aborted", async () => {
    const { fake, ctx, emitted, controller } = harness();
    controller.abort();
    await runOnce(runSpec(), ctx);
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
    const done = runOnce(runSpec(), ctx);
    controller.abort();
    release();
    await done;
    expect(fake.calls).toEqual([]);
    expect(emitted).toEqual([ABORTED]);
  });
});

describe("runOnce — 전사가 없다고 봤는데 CLI 가 「이미 있는 세션」으로 거절하면 resume 으로 한 번 다시(리뷰 M3)", () => {
  const IN_USE = `Claude Code process exited with code 1\nError: Session ID ${SESSION_ID} is already in use.`;

  it("sessionId 로 연 첫 시도가 거절되면 resume 으로 다시 열어 끝낸다 — 오류를 내지 않는다, 다시 연 것을 로그에 남긴다", async () => {
    const lines: string[] = [];
    const { fake, ctx, emitted } = harness(createFakeSdk(), { log: (line) => lines.push(line) });
    fake.script({ throw: new Error(IN_USE) });
    fake.script(script.init(), ...script.textTurn("msg_1", ["이어서"]));
    await runOnce(runSpec(), ctx);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.options.sessionId).toBe(SESSION_ID);
    expect(fake.calls[1]!.options.resume).toBe(SESSION_ID);
    expect(fake.calls[1]!.options.sessionId).toBeUndefined();
    expect(lines).toEqual([
      `dodok-runner: 런 ${runSpec().start.deliver.runId} 세션 새로 열기`,
      `dodok-runner: 런 ${runSpec().start.deliver.runId} 이미 있는 세션이라 resume 으로 다시 엽니다`,
    ]);
    expect(errors(emitted)).toEqual([]);
    expect(finals(emitted)).toMatchObject([{ final: { text: "이어서" } }]);
  });

  it("query() 가 곧바로 거절로 던져도 resume 으로 한 번 다시 연다", async () => {
    const fake = createFakeSdk();
    fake.script(script.init(), ...script.textTurn("msg_1", ["이어서"]));
    let calls = 0;
    const { ctx, emitted } = harness({
      ...fake,
      query: (args) => {
        calls += 1;
        if (calls === 1) throw new Error(IN_USE);
        return fake.query(args);
      },
    });
    await runOnce(runSpec(), ctx);
    expect(calls).toBe(2);
    expect(fake.calls[0]!.options.resume).toBe(SESSION_ID);
    expect(errors(emitted)).toEqual([]);
    expect(finals(emitted)).toMatchObject([{ final: { text: "이어서" } }]);
  });

  it("거절과 다시 열기 사이에 중지되면 다시 열지 않고 final aborted", async () => {
    const fake = createFakeSdk();
    let calls = 0;
    const controller = new AbortController();
    const { ctx, emitted } = harness(
      {
        ...fake,
        query: (args) => {
          calls += 1;
          // 첫 시도가 거절된 그 사이에 run.abort 가 왔다 — 첫 시도의 중지 리스너는 아직 없다
          controller.abort();
          if (calls === 1) throw new Error(IN_USE);
          return fake.query(args);
        },
      },
      { signal: controller.signal },
    );
    await runOnce(runSpec(), ctx);
    expect(calls).toBe(1);
    expect(emitted).toEqual([
      { kind: "final", final: { text: "", stopReason: "aborted", costKind: "subscription_estimate" } },
    ]);
  });

  it("다시 연 것도 거절되면 한 번만 — run.error", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script({ throw: new Error(IN_USE) });
    fake.script({ throw: new Error(IN_USE) });
    await runOnce(runSpec(), ctx);
    expect(fake.calls).toHaveLength(2);
    expect(errors(emitted)).toMatchObject([{ code: "INTERNAL" }]);
  });

  it("resume 으로 연 런·다른 오류·스트림이 시작된 뒤의 거절은 다시 열지 않는다", async () => {
    const resumed = harness();
    resumed.fake.sessions.add(SESSION_ID);
    resumed.fake.script({ throw: new Error(IN_USE) });
    await runOnce(runSpec(), resumed.ctx);
    expect(resumed.fake.calls).toHaveLength(1);

    const other = harness();
    other.fake.script({ throw: new Error("Claude Code process exited with code 1\nError: boom") });
    await runOnce(runSpec(), other.ctx);
    expect(other.fake.calls).toHaveLength(1);

    const late = harness();
    late.fake.script(script.messageStart("msg_1"), { throw: new Error(IN_USE) });
    await runOnce(runSpec(), late.ctx);
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

describe("runOnce — dodok post 도구·도구 승인·이미지(태스크 6)", () => {
  const SUGGESTION = {
    type: "addRules" as const,
    rules: [{ toolName: "Bash", ruleContent: "npm test" }],
    behavior: "allow" as const,
    destination: "localSettings" as const,
  };

  it("CLI 가 post 도구를 부르면 그 런의 값으로 outbound.post — 도구 결과는 「보냈습니다」", async () => {
    const { fake, ctx, emitted, bridge } = harness();
    fake.script(
      script.init(),
      { callTool: { name: "post", input: { text: `카드입니다 ${AGENT.workdir}/a.txt` } } },
      ...script.textTurn("msg_1", ["끝"]),
    );
    const start = runStart();
    await runOnce(specOf(start), ctx);
    const d = start.deliver;
    expect(bridge.posts).toHaveLength(1);
    expect(bridge.posts[0]).toMatchObject({
      conversationId: d.conversationId,
      agentId: d.agentId,
      sessionKey: d.sessionKey,
      runId: d.runId,
      replyToInboundId: d.message.id,
      text: "카드입니다 a.txt",
      attachmentIds: [],
    });
    expect(fake.calls[0]!.toolResults).toEqual([
      { content: [{ type: "text", text: "보냈습니다(메시지 0192f000-0000-7000-8000-0000000000aa)" }] },
    ]);
    expect(finals(emitted)).toHaveLength(1);
  });

  it("post 도구의 파일은 그 런의 작업 디렉터리 안만 — 상대 경로는 작업 디렉터리에서 푼다(태스크 2 리뷰 L2)", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "dodok-run-post-")));
    try {
      const workdir = join(base, "repo");
      mkdirSync(workdir);
      writeFileSync(join(workdir, "a.txt"), "aa");
      writeFileSync(join(base, "secret.txt"), "ss");
      const uploads: string[] = [];
      const fake = createFakeSdk();
      const { ctx } = harness(fake, {
        bridge: createFakeBridge({
          upload: (name) => {
            uploads.push(name);
            const id = "0192f000-0000-7000-8000-0000000000f1";
            return { id, kind: "file", url: `artifact://${id}`, name, mime: "text/plain", size: 2 };
          },
        }),
      });
      fake.script(
        { callTool: { name: "post", input: { files: ["a.txt"] } } },
        { callTool: { name: "post", input: { files: [join(base, "secret.txt")] } } },
        ...script.textTurn("msg_1", ["끝"]),
      );
      await runOnce(runSpec({ workdir }), ctx);
      expect(uploads).toEqual(["a.txt"]);
      expect(fake.calls[0]!.toolResults[1]).toMatchObject({ isError: true });
      expect(JSON.stringify(fake.calls[0]!.toolResults[1])).toContain("작업 디렉터리 밖");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("서버가 post 를 거절해도(중지된 런 FORBIDDEN) 도구 결과 오류로 돌려주고 런은 계속된다", async () => {
    const fake = createFakeSdk();
    const { ctx, emitted } = harness(fake, {
      bridge: createFakeBridge({
        ack: { ok: false, code: "FORBIDDEN", message: "post must belong to an open run" },
      }),
    });
    fake.script({ callTool: { name: "post", input: { text: "x" } } }, ...script.textTurn("msg_1", ["끝"]));
    await runOnce(runSpec(), ctx);
    expect(fake.calls[0]!.toolResults[0]).toMatchObject({
      isError: true,
      content: [{ text: "보내지 못했습니다(FORBIDDEN): post must belong to an open run" }],
    });
    expect(finals(emitted)[0]).toMatchObject({ final: { text: "끝" } });
  });

  it("canUseTool → approval.requested(요약은 가린 명령) → 결정 allow-always 가 destination session 으로 CLI 에", async () => {
    const { fake, ctx, bridge } = harness();
    fake.script(
      script.init(),
      {
        askPermission: {
          toolName: "Bash",
          input: { command: `npm test --prefix ${AGENT.workdir}` },
          toolUseID: "toolu_01",
          suggestions: [SUGGESTION],
        },
      },
      ...script.textTurn("msg_1", ["끝"]),
    );
    const start = runStart();
    const done = runOnce(specOf(start), ctx);
    await bridge.decide("toolu_01", { decision: "allow-always" });
    await done;
    expect(bridge.requested).toEqual([
      {
        providerApprovalId: "toolu_01",
        runId: start.deliver.runId,
        sessionKey: start.deliver.sessionKey,
        toolCallId: "toolu_01",
        toolName: "Bash",
        summary: "npm test --prefix .",
        // 카드 「전체 보기」의 입력 JSON 전체 — 작업 디렉터리는 요약과 같은 규칙으로 가린다
        args: '{"command":"npm test --prefix ."}',
        canAllowAlways: true,
      },
    ]);
    expect(fake.calls[0]!.permissions).toEqual([
      {
        behavior: "allow",
        updatedInput: { command: `npm test --prefix ${AGENT.workdir}` },
        updatedPermissions: [{ ...SUGGESTION, destination: "session" }],
      },
    ]);
  });

  it("「항상 허용」 뒤 같은 Bash 는 카드 없이 허용 — 훅의 ask 로 CLI 가 제안 없이 물어도(R3 실측)", async () => {
    const { fake, ctx, bridge } = harness();
    const ask = (toolUseID: string, command: string) => ({
      askPermission: { toolName: "Bash", input: { command }, toolUseID },
    });
    fake.script(
      script.init(),
      ask("toolu_01", "touch a"),
      ask("toolu_02", "touch a"),
      ask("toolu_03", "touch b"),
      ...script.textTurn("msg_1", ["끝"]),
    );
    const done = runOnce(runSpec(), ctx);
    await bridge.decide("toolu_01", { decision: "allow-always" });
    while (bridge.requested.length < 2) await new Promise((r) => setTimeout(r, 2));
    await bridge.decide("toolu_03", { decision: "allow-once" });
    await done;
    // 제안이 없어도 러너가 기억하므로 「항상 허용」을 낸다. 둘째(같은 명령)는 카드가 없다
    expect(bridge.requested.map((r) => [r.toolCallId, r.canAllowAlways])).toEqual([
      ["toolu_01", true],
      ["toolu_03", true],
    ]);
    expect(fake.calls[0]!.permissions).toEqual([
      { behavior: "allow", updatedInput: { command: "touch a" } },
      { behavior: "allow", updatedInput: { command: "touch a" } },
      { behavior: "allow", updatedInput: { command: "touch b" } },
    ]);
  });

  it("「항상 허용」 기억은 그 런뿐 — 다음 런은 다시 묻는다", async () => {
    const { fake, ctx, bridge } = harness();
    const ask = { askPermission: { toolName: "Bash", input: { command: "touch a" }, toolUseID: "toolu_01" } };
    fake.script(script.init(), ask, ...script.textTurn("msg_1", ["끝"]));
    fake.script(
      script.init(),
      { ...ask, askPermission: { ...ask.askPermission, toolUseID: "toolu_02" } },
      ...script.textTurn("msg_2", ["끝"]),
    );
    const first = runOnce(runSpec(), ctx);
    await bridge.decide("toolu_01", { decision: "allow-always" });
    await first;
    const second = runOnce(runSpec(), ctx);
    await bridge.decide("toolu_02", { decision: "allow-once" });
    await second;
    expect(bridge.requested.map((r) => r.toolCallId)).toEqual(["toolu_01", "toolu_02"]);
  });

  it("기한 deny 를 받으면 도구를 거절로 돌려받고 런은 끝까지 간다(Review Focus 4)", async () => {
    const { fake, ctx, emitted, bridge } = harness();
    fake.script(
      { askPermission: { toolName: "Write", input: { file_path: "/etc/hosts" }, toolUseID: "toolu_01" } },
      ...script.textTurn("msg_1", ["거절돼서 멈춥니다"]),
    );
    const done = runOnce(runSpec(), ctx);
    await bridge.decide("toolu_01", { decision: "deny", reason: "expired" });
    await done;
    expect(bridge.requested[0]!.summary).toBe("<작업 디렉터리 밖>");
    expect(fake.calls[0]!.permissions).toEqual([{ behavior: "deny", message: "승인 시간이 지났습니다" }]);
    expect(finals(emitted)[0]).toMatchObject({ final: { text: "거절돼서 멈춥니다" } });
  });

  it("승인을 기다리는 중에 중지되면 approval.withdrawn 하고 final aborted", async () => {
    const { fake, ctx, emitted, bridge, controller } = harness();
    fake.script(
      script.messageStart("msg_1"),
      { askPermission: { toolName: "Bash", input: { command: "make" }, toolUseID: "toolu_01" } },
      { waitInterrupt: [script.errorResult("error_during_execution", ["interrupted"])] },
    );
    const done = runOnce(runSpec(), ctx);
    while (bridge.requested.length === 0) await new Promise((r) => setTimeout(r, 2));
    controller.abort();
    await done;
    expect(bridge.withdrawn).toEqual(["toolu_01"]);
    expect(fake.calls[0]!.permissions).toEqual([{ behavior: "deny", message: "승인 요청이 철회됐습니다" }]);
    expect(finals(emitted)).toHaveLength(1);
    expect(finals(emitted)[0]).toMatchObject({ final: { text: "", stopReason: "aborted" } });
  });

  it("CLI 가 권한 취소를 늦게 보내도 중지하면 곧바로 카드를 거둔다 — 런 signal 이 canUseTool 에 이어져 있다", async () => {
    const { fake, ctx, emitted, bridge, controller } = harness(createFakeSdk({ lateCancel: true }), {
      closeGraceMs: 60_000,
    });
    fake.script(
      script.messageStart("msg_1"),
      { askPermission: { toolName: "Bash", input: { command: "make" }, toolUseID: "toolu_01" } },
      { waitInterrupt: [script.errorResult("error_during_execution", ["interrupted"])] },
    );
    const done = runOnce(runSpec(), ctx);
    while (bridge.requested.length === 0) await new Promise((r) => setTimeout(r, 2));
    const stoppedAt = Date.now();
    controller.abort();
    await done;
    // 유예(60초) 뒤의 close() 가 아니라 중지 즉시 거둔다
    expect(Date.now() - stoppedAt).toBeLessThan(2_000);
    expect(bridge.withdrawn).toEqual(["toolu_01"]);
    expect(fake.calls[0]!.permissions).toEqual([{ behavior: "deny", message: "승인 요청이 철회됐습니다" }]);
    expect(finals(emitted)[0]).toMatchObject({ final: { stopReason: "aborted" } });
  });

  it("중지 뒤 CLI 가 post 도구를 부르면 보내지 않고 도구 결과로 알린다 — 런 signal 이 post 에 이어져 있다", async () => {
    const { fake, ctx, bridge, controller } = harness();
    fake.script(
      script.messageStart("msg_1"),
      { waitInterrupt: [] },
      { callTool: { name: "post", input: { text: "늦은 카드" } } },
      script.errorResult("error_during_execution", ["interrupted"]),
    );
    const done = runOnce(runSpec(), ctx);
    while (fake.calls.length === 0) await new Promise((r) => setTimeout(r, 2));
    controller.abort();
    await done;
    expect(bridge.posts).toEqual([]);
    expect(fake.calls[0]!.toolResults).toEqual([
      { content: [{ type: "text", text: POST_STOPPED_MESSAGE }], isError: true },
    ]);
  });

  it("이미지를 받는 사이 중지되면 받기를 끊는다 — 런 signal 이 받기에 이어져 있다", async () => {
    const fake = createFakeSdk();
    const bridge = createFakeBridge();
    // signal 이 끊길 때까지 응답하지 않는 받기
    bridge.http.download = (_id, o) =>
      new Promise((_resolve, reject) => {
        o?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const { ctx, emitted, controller } = harness(fake, { bridge });
    const base = runStart();
    const id = "0192f000-0000-7000-8000-0000000000f1";
    const att = {
      id,
      kind: "image" as const,
      url: `artifact://${id}`,
      name: "a.png",
      mime: "image/png",
      size: 1,
    };
    const done = runOnce(
      specOf({
        ...base,
        deliver: { ...base.deliver, message: { ...base.deliver.message, attachments: [att] } },
      }),
      ctx,
    );
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await done;
    expect(fake.calls).toEqual([]);
    expect(finals(emitted)).toEqual([
      { kind: "final", final: { text: "", stopReason: "aborted", costKind: "subscription_estimate" } },
    ]);
  });

  it("이미지 첨부 — 받은 것은 이미지 블록으로 글보다 앞에, 못 받은 수는 글 끝 한 줄", async () => {
    const fake = createFakeSdk();
    const ok = "0192f000-0000-7000-8000-0000000000f1";
    const missing = "0192f000-0000-7000-8000-0000000000f2";
    const bridge = createFakeBridge({ images: { [ok]: Buffer.from([1, 2, 3]) } });
    const { ctx } = harness(fake, { bridge });
    fake.script(...script.textTurn("msg_1", ["봤습니다"]));
    const base = runStart();
    const img = (id: string) => ({
      id,
      kind: "image" as const,
      url: `artifact://${id}`,
      name: `${id.slice(-2)}.png`,
      mime: "image/png",
      size: 3,
    });
    const start = {
      ...base,
      deliver: {
        ...base.deliver,
        message: { ...base.deliver.message, attachments: [img(ok), img(missing)] },
      },
    };
    await runOnce(specOf(start), ctx);
    expect(bridge.downloads.sort()).toEqual([ok, missing]);
    expect(fake.calls[0]!.prompt!.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
      { type: "text", text: `${renderRunnerPrompt(start.deliver)}\n첨부 이미지 1장을 불러오지 못했습니다` },
    ]);
  });

  it("이미지를 받는 사이 중지되면 CLI 를 띄우지 않고 final aborted", async () => {
    const fake = createFakeSdk();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const bridge = createFakeBridge();
    bridge.http.download = async () => {
      await gate;
      return { bytes: Buffer.from([1]), mime: "image/png" };
    };
    const { ctx, emitted, controller } = harness(fake, { bridge });
    const base = runStart();
    const id = "0192f000-0000-7000-8000-0000000000f1";
    const att = {
      id,
      kind: "image" as const,
      url: `artifact://${id}`,
      name: "a.png",
      mime: "image/png",
      size: 1,
    };
    const done = runOnce(
      specOf({
        ...base,
        deliver: { ...base.deliver, message: { ...base.deliver.message, attachments: [att] } },
      }),
      ctx,
    );
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    release();
    await done;
    expect(fake.calls).toEqual([]);
    expect(finals(emitted)).toEqual([
      { kind: "final", final: { text: "", stopReason: "aborted", costKind: "subscription_estimate" } },
    ]);
  });
});

describe("runOnce — 런 끝 컨텍스트 세부(작성기 칩 스펙 C7)", () => {
  const usageOf = (e: Emitted[]) =>
    (finals(e)[0] as { final: { usage?: Record<string, unknown> } } | undefined)?.final.usage;

  it("final carries contextBreakdown when getContextUsage resolves", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(script.init(), ...script.textTurn("msg_1", ["끝"]));
    await runOnce(runSpec(), ctx);
    expect(finals(emitted)).toHaveLength(1);
    expect(usageOf(emitted)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      contextBreakdown: toContextBreakdown(FAKE_CONTEXT_USAGE),
    });
    expect(fake.calls[0]!.inputClosed).toBe(true);
  });

  it("getContextUsage is called with detail summary before input closes", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(script.init(), ...script.textTurn("msg_1", ["끝"]));
    await runOnce(runSpec(), ctx);
    // 가짜 query 는 입력이 닫힌 뒤 부르면 던진다 — 세부가 실렸으면 닫기 전에 불렀다
    expect(fake.calls[0]!.contextUsageCalls).toEqual([{ detail: "summary" }]);
    expect(usageOf(emitted)).toHaveProperty("contextBreakdown");
  });

  it("getContextUsage hangs → final without breakdown within 2s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { fake, ctx, emitted } = harness();
      fake.contextUsage = () => new Promise<SdkContextUsage>(() => {});
      fake.script(script.init(), ...script.textTurn("msg_1", ["끝"]));
      const done = runOnce(runSpec(), ctx);
      await vi.advanceTimersByTimeAsync(1999);
      expect(finals(emitted)).toHaveLength(0);
      // 답 글은 이미 흘러 나와 있다
      expect(emitted.some((e) => e.kind === "event" && e.event.type === "TEXT_MESSAGE_END")).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(100);
      await done;
      expect(finals(emitted)).toHaveLength(1);
      expect(errors(emitted)).toHaveLength(0);
      expect(usageOf(emitted)).toEqual({ inputTokens: 10, outputTokens: 5 });
      expect(finals(emitted)[0]).toMatchObject({ final: { text: "끝", stopReason: "end_turn" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("getContextUsage throws → final without breakdown", async () => {
    const { fake, ctx, emitted } = harness();
    fake.contextUsage = async () => {
      throw new Error("control request failed");
    };
    fake.script(script.init(), ...script.textTurn("msg_1", ["끝"]));
    await runOnce(runSpec(), ctx);
    expect(errors(emitted)).toHaveLength(0);
    expect(usageOf(emitted)).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(finals(emitted)[0]).toMatchObject({ final: { text: "끝", stopReason: "end_turn" } });
  });

  it("aborted run does not call getContextUsage", async () => {
    const { fake, ctx, emitted, controller } = harness();
    fake.script(script.messageStart("msg_1"), {
      waitInterrupt: [script.errorResult("error_during_execution", ["[ede_diagnostic] stop_reason=null"])],
    });
    const done = runOnce(runSpec(), ctx);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await done;
    expect(finals(emitted)).toHaveLength(1);
    expect(finals(emitted)[0]).toMatchObject({ final: { stopReason: "aborted" } });
    expect(fake.calls[0]!.contextUsageCalls).toEqual([]);
    expect(usageOf(emitted)).not.toHaveProperty("contextBreakdown");
  });

  it("error result(error_*) 는 세부를 묻지 않는다 — run.error 하나", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(script.init(), script.errorResult("error_max_turns", ["max turns"]));
    await runOnce(runSpec(), ctx);
    expect(errors(emitted)).toHaveLength(1);
    expect(fake.calls[0]!.contextUsageCalls).toEqual([]);
  });
});

describe("에이전트 명령(에이전트 명령 스펙 5.3·C14·C15·C17)", () => {
  /** deliver.command 를 실은 런 */
  const commandSpec = (
    name: string,
    args = "",
    over: Partial<Omit<ReturnType<typeof runSpec>, "start">> = {},
  ) => {
    const spec = runSpec(over);
    return { ...spec, start: { ...spec.start, deliver: { ...spec.start.deliver, command: { name, args } } } };
  };

  it("command run sends raw prompt without header", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(script.init(), ...script.textTurn("msg_1", ["리뷰 끝"]));
    await runOnce(commandSpec("user:review", "src/a.ts  x"), ctx);
    expect(fake.calls[0]!.prompt).toMatchObject({
      message: { role: "user", content: "/user:review src/a.ts  x" },
    });
    // 턴 사실은 훅 문맥으로 그대로 붙는다
    expect(fake.calls[0]!.options.hooks?.UserPromptSubmit).toHaveLength(1);
    expect(finals(emitted)[0]).toMatchObject({ final: { text: "리뷰 끝" } });
  });

  it("인자가 없으면 `/이름` 만", async () => {
    const { fake, ctx } = harness();
    fake.script(script.init(), script.success("", { num_turns: 0, local_command: "context" }));
    await runOnce(commandSpec("context"), ctx);
    expect(fake.calls[0]!.prompt).toMatchObject({ message: { content: "/context" } });
  });

  it("blocked claude command → VALIDATION error, no query", async () => {
    for (const name of ["login", "config", "insights", "heapdump", "recap", "model", "clear", "stop"]) {
      const { fake, ctx, emitted } = harness();
      await runOnce(commandSpec(name), ctx);
      expect(fake.calls).toHaveLength(0);
      expect(errors(emitted)).toEqual([expect.objectContaining({ code: "VALIDATION" })]);
    }
  });

  it("내장 허용 목록 밖·목록에 없는 이름 → 그 런의 명령 목록을 보고 프롬프트 없이 VALIDATION", async () => {
    for (const name of ["nope", "mcp", "agents", "Nope"]) {
      const { fake, ctx, emitted } = harness();
      fake.script(script.init(), ...script.textTurn("msg_1", ["나가면 안 되는 답"]));
      await runOnce(commandSpec(name), ctx);
      expect(fake.calls[0]!.supportedCommandsCalls).toBe(1);
      expect(fake.calls[0]!.prompt).toBeUndefined();
      expect(errors(emitted)).toEqual([
        expect.objectContaining({ code: "VALIDATION", message: "이 명령은 dodok 에서 쓸 수 없습니다" }),
      ]);
      expect(finals(emitted)).toEqual([]);
    }
  });

  it("스킬 별칭은 목록을 보고 넘긴다 — 사람 명령·허용 내장은 목록을 묻지 않는다", async () => {
    {
      const { fake, ctx, emitted } = harness();
      fake.script(script.init(), ...script.textTurn("msg_1", ["스킬 답"]));
      await runOnce(commandSpec("user-skill", "x"), ctx);
      expect(fake.calls[0]!.supportedCommandsCalls).toBe(1);
      expect(fake.calls[0]!.prompt).toMatchObject({ message: { content: "/user-skill x" } });
      expect(finals(emitted)[0]).toMatchObject({ final: { text: "스킬 답" } });
    }
    for (const name of ["compact", "context", "user:user-cmd"]) {
      const { fake, ctx } = harness();
      fake.script(script.init(), script.success("", { num_turns: 0, local_command: name }));
      await runOnce(commandSpec(name), ctx);
      expect(fake.calls[0]!.supportedCommandsCalls).toBe(0);
      expect(fake.calls[0]!.prompt).toMatchObject({ message: { content: `/${name}` } });
    }
  });

  it("SDK 가 query() 안에서 곧바로 입력을 당겨도 별칭 확인은 q 대입 뒤에 목록을 묻는다(N2)", async () => {
    const { fake, ctx, emitted } = harness(createFakeSdk({ eagerInput: true }));
    fake.script(script.init(), ...script.textTurn("msg_1", ["스킬 답"]));
    await runOnce(commandSpec("user-skill", "x"), ctx);
    expect(fake.calls[0]!.supportedCommandsCalls).toBe(1);
    expect(fake.calls[0]!.prompt).toMatchObject({ message: { content: "/user-skill x" } });
    expect(errors(emitted)).toEqual([]);
    expect(finals(emitted)[0]).toMatchObject({ final: { text: "스킬 답" } });
  });

  it("허용 내장은 compact·context·usage(별칭 cost) — 목록에 usage 가 나오고 /usage·/cost 는 목록을 묻지 않는다(N6)", async () => {
    // 핀한 CLI 의 supportedCommands() 꼴 — usage 의 별칭은 cost·stats, help 는 이 판에 없다
    const listed = toAgentCommands([
      {
        name: "usage",
        description: "Show plan usage limits",
        argumentHint: "",
        aliases: ["cost", "stats"],
        builtin: true,
      },
      { name: "help", description: "Show help", argumentHint: "", builtin: true },
      { name: "doctor", description: "Diagnose", argumentHint: "", builtin: true },
    ] as never);
    expect(listed.map((c) => c.name)).toEqual(["usage"]);
    for (const name of ["usage", "cost"]) {
      const { fake, ctx } = harness();
      fake.script(script.init(), script.success("", { num_turns: 0, local_command: name }));
      await runOnce(commandSpec(name), ctx);
      expect(fake.calls[0]!.supportedCommandsCalls).toBe(0);
      expect(fake.calls[0]!.prompt).toMatchObject({ message: { content: `/${name}` } });
    }
  });

  it("목록을 못 받으면 별칭도 막는다(fail-safe)", async () => {
    const { fake, ctx, emitted } = harness();
    fake.commands = async () => {
      throw new Error("boom");
    };
    fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
    await runOnce(commandSpec("user-skill"), ctx);
    expect(fake.calls[0]!.prompt).toBeUndefined();
    expect(errors(emitted)).toEqual([expect.objectContaining({ code: "VALIDATION" })]);
  });

  it("내장 이름과 겹치는 별칭은 스킬 별칭으로 보지 않는다", async () => {
    const { fake, ctx, emitted } = harness();
    fake.commands = async () =>
      [
        { name: "mcp", description: "", argumentHint: "", builtin: true },
        { name: "user:x", description: "", argumentHint: "", aliases: ["mcp"] },
      ] as never;
    fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
    await runOnce(commandSpec("mcp"), ctx);
    expect(fake.calls[0]!.prompt).toBeUndefined();
    expect(errors(emitted)).toEqual([expect.objectContaining({ code: "VALIDATION" })]);
  });

  it("local_command result replaces assistant text (compact replays previous answer)", async () => {
    const { fake, ctx, emitted } = harness();
    fake.sessions.add(SESSION_ID);
    fake.script(
      script.init(),
      // 스파이크 4절 — /compact 는 앞 턴의 글을 assistant 로 다시 내고 result 는 빈 글이다
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "앞 턴의 답" }] },
      } as never,
      script.success("", { num_turns: 0, local_command: "compact" }),
    );
    await runOnce(commandSpec("compact"), ctx);
    expect(finals(emitted)).toEqual([
      expect.objectContaining({ final: expect.objectContaining({ text: "" }) }),
    ]);
    expect(JSON.stringify(emitted)).not.toContain("앞 턴의 답");
  });

  it("num_turns 0 result ends a command run", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(
      script.init(),
      script.success("## Context Usage", { num_turns: 0, local_command: "context" }),
    );
    await runOnce(commandSpec("context"), ctx);
    expect(finals(emitted)).toEqual([
      expect.objectContaining({ final: expect.objectContaining({ text: "## Context Usage" }) }),
    ]);
    expect(errors(emitted)).toEqual([]);
  });

  it("평범한 런의 num_turns 0 result 는 여전히 버린다(resume 직후 빈 result — ADR 0007 4.3)", async () => {
    const { fake, ctx, emitted } = harness();
    fake.script(
      script.init(),
      script.success("", { num_turns: 0 }),
      ...script.textTurn("msg_1", ["진짜 답"]),
    );
    await runOnce(runSpec(), ctx);
    expect(finals(emitted)).toEqual([
      expect.objectContaining({ final: expect.objectContaining({ text: "진짜 답" }) }),
    ]);
  });

  it("query options carry plugins, disableAllHooks, disableSkillShellExecution", () => {
    const plugins = [{ type: "local" as const, path: "/tmp/w/user", skipMcpDiscovery: true as const }];
    const o = buildQueryOptions(runSpec(), { ...deps(false), plugins });
    expect(o.plugins).toEqual(plugins);
    expect(o.settings).toEqual({ disableAllHooks: true, disableSkillShellExecution: true });
    // settingSources 는 그대로 — settings.json·CLAUDE.md 를 끌어오지 않는다
    expect(o.settingSources).toEqual([]);
    expect(buildQueryOptions(runSpec(), deps(false)).plugins).toEqual([]);
  });

  const preToolUse = async (permissionMode: string, toolName: string) => {
    const o = buildQueryOptions(runSpec({ permissionMode: permissionMode as never }), deps(false));
    const hook = o.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error("no PreToolUse hook");
    return hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: {},
        permission_mode: permissionMode,
      } as never,
      "toolu_1",
      { signal: new AbortController().signal },
    );
  };
  const ASK = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } };
  const DENY = {
    hookSpecificOutput: expect.objectContaining({ hookEventName: "PreToolUse", permissionDecision: "deny" }),
  };

  it("PreToolUse — auto·bypassPermissions 는 손대지 않는다(CLI 판단 그대로 — 끼어들면 그 모드가 다시 카드를 띄운다)", async () => {
    for (const mode of ["auto", "bypassPermissions"] as const)
      for (const tool of ["Bash", "Edit", "WebFetch", "mcp__gh__delete"]) {
        expect(preToolDecision(tool, mode), `${mode} ${tool}`).toBeNull();
        expect(await preToolUse(mode, tool)).toEqual({});
      }
  });

  it("PreToolUse — Read 는 어느 모드에서도 손대지 않는다(카드 없음)", async () => {
    for (const mode of ["default", "acceptEdits", "dontAsk", "plan"])
      expect(await preToolUse(mode, "Read")).toEqual({});
  });

  it("PreToolUse asks for Bash in default mode — dontAsk 는 거절, plan 은 그대로", async () => {
    expect(await preToolUse("default", "Bash")).toEqual(ASK);
    expect(await preToolUse("dontAsk", "Bash")).toEqual(DENY);
    expect(await preToolUse("plan", "Bash")).toEqual({});
  });

  it("PreToolUse does not ask for Edit in acceptEdits or for mcp__dodok__post", async () => {
    expect(await preToolUse("acceptEdits", "Edit")).toEqual({});
    expect(await preToolUse("acceptEdits", "Write")).toEqual({});
    expect(await preToolUse("default", "mcp__dodok__post")).toEqual({});
    expect(await preToolUse("dontAsk", "mcp__dodok__post")).toEqual({});
    // acceptEdits 라도 편집이 아닌 도구는 묻는다. default 의 Edit 는 묻는다
    expect(await preToolUse("acceptEdits", "Bash")).toEqual(ASK);
    expect(await preToolUse("default", "Edit")).toEqual(ASK);
  });

  it("PreToolUse — 이 런에서 「항상 허용」한 것은 묻게 만들지 않는다(Bash 는 같은 명령, 파일 도구는 같은 파일만)", async () => {
    const spec = runSpec({ permissionMode: "default" });
    const alwaysAllowed = new Set([
      alwaysAllowKey("Bash", { command: "make" }, spec.workdir),
      alwaysAllowKey("Write", { file_path: "a" }, spec.workdir),
    ]);
    const o = buildQueryOptions(spec, { ...deps(false), alwaysAllowed });
    const hook = o.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error("no PreToolUse hook");
    const call = (toolName: string, toolInput: unknown) =>
      hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: toolInput,
          permission_mode: "default",
        } as never,
        "toolu_1",
        { signal: new AbortController().signal },
      );
    expect(await call("Bash", { command: "make" })).toEqual({});
    expect(await call("Bash", { command: "make install" })).toEqual(ASK);
    expect(await call("Write", { file_path: "a" })).toEqual({});
    // 같은 파일을 절대 경로로 불러도 같은 키, 다른 파일·다른 도구는 다시 묻는다(N1)
    expect(await call("Write", { file_path: `${spec.workdir}/a` })).toEqual({});
    expect(await call("Write", { file_path: "b" })).toEqual(ASK);
    expect(await call("Edit", { file_path: "a" })).toEqual(ASK);
  });

  it("목록에 없는 도구(FutureTool)는 default 에서 묻는다 — fail-safe", async () => {
    expect(await preToolUse("default", "FutureTool")).toEqual(ASK);
    expect(await preToolUse("default", "mcp__other__x")).toEqual(ASK);
  });

  it("런은 사람의 명령·스킬 감싸개를 싣고 끝나면 지운다 — 사람 폴더는 그대로", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "dodok-cmd-run-")));
    try {
      const cfg = join(home, "cfg");
      mkdirSync(join(cfg, "commands"), { recursive: true });
      writeFileSync(join(cfg, "commands", "user-cmd.md"), "x");
      const { fake, ctx } = harness();
      fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
      await runOnce(runSpec({ configDir: cfg }), ctx);
      const plugins = fake.calls[0]!.options.plugins as Array<{ path: string }>;
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({ type: "local", skipMcpDiscovery: true });
      // 런이 끝나면 감싸개는 없다
      expect(() => realpathSync(plugins[0]!.path)).toThrow();
      expect(realpathSync(join(cfg, "commands", "user-cmd.md"))).toBe(join(cfg, "commands", "user-cmd.md"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("봇 런 — SOUL.md(러너 봇 스펙 B4)", () => {
  const BOT = { id: "r-0123456789", soul: "# 리뷰 봇\n" };
  const botStart = () => {
    const start = runStart({ agent: { project: undefined, bot: BOT } });
    return { ...start, providerSessionId: start.providerSessionId! };
  };

  it("런 시작 때 머리 줄 + 정의로 다시 쓴다 — 사람이 고친 내용은 덮인다, 임시 파일은 남지 않는다", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "dodok-bot-run-")));
    try {
      writeFileSync(join(dir, "SOUL.md"), "사람이 고친 글");
      const { fake, ctx } = harness();
      fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
      await runOnce({ ...runSpec(), workdir: dir, start: botStart() }, ctx);
      expect(fake.calls[0]!.options.cwd).toBe(dir);
      expect(readFileSync(join(dir, "SOUL.md"), "utf8")).toBe(`${RUNNER_BOT_SOUL_HEADER}\n\n# 리뷰 봇\n`);
      expect(readdirSync(dir)).toEqual(["SOUL.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("프로젝트 런은 SOUL.md 를 쓰지 않는다", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "dodok-bot-run-")));
    try {
      const { fake, ctx } = harness();
      fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
      await runOnce({ ...runSpec(), workdir: dir }, ctx);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SOUL.md 가 링크면 링크 자리를 바꾸고 가리키던 파일에는 쓰지 않는다", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "dodok-bot-soul-")));
    try {
      writeFileSync(join(dir, "victim.txt"), "원래 글");
      symlinkSync(join(dir, "victim.txt"), join(dir, "SOUL.md"));
      await writeSoul(dir, "새 글\n", "run-1");
      expect(readFileSync(join(dir, "victim.txt"), "utf8")).toBe("원래 글");
      expect(readFileSync(join(dir, "SOUL.md"), "utf8")).toBe(`${RUNNER_BOT_SOUL_HEADER}\n\n새 글\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("봇 MCP — 러너가 다시 판정해 붙인다(러너 봇 2부 스펙 T3·T6·T7·T12·T15)", () => {
  const SECRET = "Bearer ghp_TOPSECRET";
  const ENV_SECRET = "lin_TOPSECRET";
  const HTTP: AppMcpCeiling = { appMcp: "http", appMcpCommands: null, allowedToolsCeiling: null };
  const BOT: RunnerRunBot = {
    id: "r-0123456789",
    soul: "# 봇\n",
    mcpServers: {
      gh: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: SECRET } },
      linear: { command: "npx", args: ["-y", "linear-mcp"], env: { LINEAR_TOKEN: ENV_SECRET } },
      local: { type: "http", url: "http://127.0.0.1:3000/mcp" },
    },
    mcpAutoAllow: { gh: { mode: "tools", tools: ["search"] }, linear: { mode: "all" } },
    builtinTools: ["runnerControl"],
  };
  /** appMcp null 이면 천장 없는 spec. 런(runOnce)은 SOUL.md 를 쓰므로 임시 디렉터리를 쓴다 — 부른 쪽이 지운다 */
  const botSpec = (bot: RunnerRunBot, appMcp: AppMcpCeiling | null = HTTP, opts: { tmp?: boolean } = {}) => {
    const base = runSpec();
    const { project: _, ...agent } = base.start.agent;
    return {
      ...base,
      workdir: opts.tmp ? mkdtempSync(join(tmpdir(), "dodok-bot-")) : base.workdir,
      start: { ...base.start, agent: { ...agent, bot } },
      ...(appMcp === null ? {} : { appMcp }),
    };
  };

  it("http 러너 — 서버가 stdio·사설 주소를 보내도 dodok + 허용된 것만, 자동 허용 이름이 allowedTools 에", async () => {
    const lines: string[] = [];
    const { fake, ctx } = harness(createFakeSdk(), { log: (l) => lines.push(l) });
    fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
    const spec = botSpec(BOT, HTTP, { tmp: true });
    try {
      await runOnce(spec, ctx);
    } finally {
      rmSync(spec.workdir, { recursive: true, force: true });
    }
    const options = fake.calls[0]!.options;
    expect(Object.keys(options.mcpServers ?? {}).sort()).toEqual(["dodok", "gh"]);
    expect(options.mcpServers?.gh).toEqual(BOT.mcpServers!.gh);
    expect(options.allowedTools).toContain("mcp__gh__search");
    expect(options.allowedTools).not.toContain("mcp__linear");
    // 로그 — 막힌 서버는 이름·사유만, 비밀값은 어디에도 없다
    expect(lines).toContain(`dodok-runner: 런 ${RUN_ID_OF(spec)} bot mcp blocked linear stdioNotAllowed`);
    expect(lines).toContain(`dodok-runner: 런 ${RUN_ID_OF(spec)} bot mcp blocked local privateAddress`);
    expect(lines).toContain(`dodok-runner: 런 ${RUN_ID_OF(spec)} bot mcp gh`);
    expect(lines.join("\n")).not.toMatch(/TOPSECRET/);
  });

  it("all + 명령 목록 — basename 이 든 stdio 만, env 의 DYLD_* 는 뺀다", () => {
    const all: AppMcpCeiling = { appMcp: "all", appMcpCommands: ["npx"], allowedToolsCeiling: null };
    const bot: RunnerRunBot = {
      ...BOT,
      mcpServers: {
        a: { command: "/tmp/npx", args: ["x"] },
        b: { command: "./npx" },
        c: { command: "npx.sh" },
        d: { command: "npx", env: { DYLD_INSERT_LIBRARIES: "/tmp/x.dylib" } },
        e: { type: "stdio", command: "uvx" },
      },
      mcpAutoAllow: {},
    };
    const lines: string[] = [];
    const out = assembleBotMcp(botSpec(bot, all), (l) => lines.push(l));
    expect(Object.keys(out.servers).sort()).toEqual(["a", "b"]);
    expect(out.servers.a).toEqual({ type: "stdio", command: "/tmp/npx", args: ["x"] });
    expect(lines.filter((l) => l.includes("blocked"))).toEqual([
      `dodok-runner: 런 ${RUN_ID} bot mcp blocked c commandNotAllowed(npx.sh)`,
      `dodok-runner: 런 ${RUN_ID} bot mcp blocked d envKeyNotAllowed(DYLD_INSERT_LIBRARIES)`,
      `dodok-runner: 런 ${RUN_ID} bot mcp blocked e commandNotAllowed(uvx)`,
    ]);
  });

  it("off 러너·천장이 없는 spec 은 모두 막는다", () => {
    const off: AppMcpCeiling = { appMcp: "off", appMcpCommands: null, allowedToolsCeiling: null };
    expect(assembleBotMcp(botSpec(BOT, off)).servers).toEqual({});
    expect(assembleBotMcp(botSpec(BOT, null)).servers).toEqual({});
  });

  it("러너 도구 상한 밖의 자동 허용만 「묻기」로 내리고 서버는 붙인다(T15)", () => {
    const capped: AppMcpCeiling = { ...HTTP, allowedToolsCeiling: ["mcp__gh__other"] };
    const lines: string[] = [];
    const out = assembleBotMcp(botSpec(BOT, capped), (l) => lines.push(l));
    expect(Object.keys(out.servers)).toEqual(["gh"]);
    expect(out.allowedTools).toEqual([]);
    expect(lines).toContain(
      `dodok-runner: 런 ${RUN_ID} bot mcp gh auto-allow outside ceiling(mcp__gh__search)`,
    );
    // 「전부」도 상한에 mcp__gh 가 없으면 전부 허용만 막힌다
    const all = assembleBotMcp(botSpec({ ...BOT, mcpAutoAllow: { gh: { mode: "all" } } }, capped));
    expect(Object.keys(all.servers)).toEqual(["gh"]);
    expect(all.allowedTools).toEqual([]);
  });

  it("주소는 WHATWG 호스트로도 다시 본다 — 스키마를 지나지 않은 \\·전각 주소도 http 러너는 막는다(T17)", () => {
    const bot: RunnerRunBot = {
      ...BOT,
      mcpServers: {
        a: { type: "http", url: "http://127.0.0.1\\@example.com/" },
        b: { type: "http", url: "http://１２７.０.０.１/" },
        c: { type: "http", url: "http://ⓛocalhost/" },
        ok: { type: "http", url: "https://api.example.com/mcp" },
      },
      mcpAutoAllow: {},
    };
    const lines: string[] = [];
    expect(Object.keys(assembleBotMcp(botSpec(bot), (l) => lines.push(l)).servers)).toEqual(["ok"]);
    for (const name of ["a", "b", "c"])
      expect(lines).toContain(`dodok-runner: 런 ${RUN_ID} bot mcp blocked ${name} privateAddress`);
  });

  it("runnerControl 켠 봇만 러너 제어 도구 — 이름이 dodok MCP 와 allowedTools 에", async () => {
    const { fake, ctx } = harness();
    fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
    const spec = botSpec(BOT, HTTP, { tmp: true });
    try {
      await runOnce(spec, ctx);
    } finally {
      rmSync(spec.workdir, { recursive: true, force: true });
    }
    expect(fake.servers[0]!.map((t) => t.name)).toEqual([
      "post",
      ...CONTROL_TOOLS.map((t) => t.name),
      ...RUNNER_CONTROL_TOOLS.map((t) => t.name),
    ]);
    expect(fake.calls[0]!.options.allowedTools).toEqual(
      expect.arrayContaining([...RUNNER_CONTROL_TOOL_FULL_NAMES]),
    );

    const plain = harness();
    plain.fake.script(script.init(), ...script.textTurn("msg_1", ["x"]));
    const noControl = botSpec({ ...BOT, builtinTools: [] }, HTTP, { tmp: true });
    try {
      await runOnce(noControl, plain.ctx);
    } finally {
      rmSync(noControl.workdir, { recursive: true, force: true });
    }
    expect(plain.fake.servers[0]!.map((t) => t.name)).toEqual(["post", ...CONTROL_TOOLS.map((t) => t.name)]);
    for (const name of RUNNER_CONTROL_TOOL_FULL_NAMES)
      expect(plain.fake.calls[0]!.options.allowedTools).not.toContain(name);
  });

  it("프로젝트 에이전트 런에는 외부 MCP·러너 제어 도구가 없다(T12)", () => {
    const o = buildQueryOptions(runSpec({ appMcp: HTTP }), deps(false));
    expect(Object.keys(o.mcpServers ?? {})).toEqual(["dodok"]);
    for (const name of RUNNER_CONTROL_TOOL_FULL_NAMES) expect(o.allowedTools).not.toContain(name);
  });

  it("자동 허용한 도구는 PreToolUse 가 묻게 만들지 않는다 — 나머지 MCP 도구는 권한 모드대로", () => {
    expect(isAutoAllowedTool("mcp__gh__search", ["mcp__gh__search"])).toBe(true);
    expect(isAutoAllowedTool("mcp__gh__delete", ["mcp__gh__search"])).toBe(false);
    expect(isAutoAllowedTool("mcp__gh__delete", ["mcp__gh"])).toBe(true);
    expect(isAutoAllowedTool("mcp__ghx__a", ["mcp__gh"])).toBe(false);
    // 서버 a 의 「전부」가 서버 a_ 의 도구(mcp__a___x)를 허용하지 않는다
    expect(isAutoAllowedTool("mcp__a___x", ["mcp__a"])).toBe(false);
    expect(isAutoAllowedTool("mcp__a__x", ["mcp__a"])).toBe(true);
    expect(preToolDecision("mcp__gh__search", "default", ["mcp__gh__search"])).toBeNull();
    expect(preToolDecision("mcp__gh__delete", "default", ["mcp__gh__search"])).toBe("ask");
    expect(preToolDecision("mcp__gh__delete", "dontAsk", ["mcp__gh__search"])).toBe("deny");
  });
});

const RUN_ID_OF = (spec: { start: { deliver: { runId: string } } }) => spec.start.deliver.runId;
const RUN_ID = runSpec().start.deliver.runId;

import {
  checkCommand,
  formatCommandText,
  renderRunnerPrompt,
  RUNNER_PROGRAM_NAME,
  type ErrorCode,
  type RunnerPermissionMode,
  type RunnerRunFinal,
} from "@dodok/shared";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONTROL_TOOL_FULL_NAMES, createControlTools } from "../../control-tools";
import type { RunSpec } from "../../driver";
import { imageFailureNote, loadImageBlocks, type SdkImageBlock } from "../../images";
import { createDodokMcpServer, createPoster, POST_TOOL_FULL_NAME } from "../../post-tool";
import { abortedFinal, abortStopReason, type RunSink } from "../../sink";
import { createCanUseTool } from "./approvals";
import { type CommandWrapperPlugin, type CommandWrappers, createCommandWrappers } from "./command-wrappers";
import { fetchContextBreakdown } from "./context-usage";
import type {
  CanUseTool,
  SdkMcpServer,
  SdkMessage,
  SdkOptions,
  SdkPort,
  SdkQuery,
  SdkUserMessage,
} from "./sdk";
import { createStreamMapper, isAuthFailureText } from "./stream-map";

/** 오류 문구의 프로그램 이름(「러너의 Claude Code 로그인을 확인하세요」) */
export const CLAUDE_CODE_LABEL = RUNNER_PROGRAM_NAME.claude;

/** Claude 는 서버가 정한 세션 UUID 로 연다(serverSessionIds) — providerSessionId 가 있는 런만 이 드라이버에 온다 */
export type ClaudeRunSpec = RunSpec & { start: RunSpec["start"] & { providerSessionId: string } };

/**
 * CLI(와 그 도구가 여는 셸)로 넘기는 러너 env — SDK 기본값은 러너 env 전부라 러너 토큰·API 키가 샌다(ADR 0007 5.4).
 * 프록시·CA 는 사내 프록시·사설 CA 뒤에서 CLI 가 API 에 닿는 데 필요하고 비밀이 아니다(프록시 URL 에 자격을 넣은
 * 설정이면 그 자격도 CLI 로 간다 — CLI 가 그 프록시를 쓰려면 어차피 필요하다)
 */
export const ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "SHELL",
  "USER",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
];
/** run.abort 뒤 interrupt 에 턴이 끝나지 않으면 close() 까지 기다리는 시간(스펙 4.5) */
export const ABORT_CLOSE_MS = 5000;

// system/init 의 apiKeySource — 'none' 은 claude.ai 로그인(구독)이다. 구독의 달러는 청구액이 아니라 공시 단가 환산(ADR 0007 4.8)
const API_KEY_SOURCES = new Set(["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"]);

/**
 * 러너 에이전트에 늘 막는 도구 — 설정의 disallowedTools 와 합친다(최종 리뷰 P2). 이름은 번들 CLI 바이너리에서 `grep -a "\"<이름>\""` 로 확인한다(SDK 를 올리면 다시 본다).
 * AskUserQuestion 은 채널이 아니라 CLI 의 대화 상자에 묻고(승인 카드로 뜨고 허용해도 답이 없다 — ADR 0007 「확인 못 한 것」 6),
 * PushNotification 은 채널 밖 러너 머신 주인에게 알린다. 예약·원격 실행 도구는 턴이 끝난 뒤 세션을 다시 깨우거나 러너 밖에서 도는데,
 * 러너는 턴마다 CLI 를 닫으므로 그 결과가 채널에 닿지 않는다. 계획 모드 도구는 permissionMode "plan" 이 쓰므로 두고,
 * Monitor 는 한 턴 안에서도 쓸모가 있어 둔다
 */
export const RUNNER_DISALLOWED_TOOLS: readonly string[] = [
  "AskUserQuestion",
  "PushNotification",
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "CronList",
  "RemoteTrigger",
];

/**
 * CLI 로 넘기는 env — 허용 목록 + CLAUDE_CONFIG_DIR + 자동 메모리 끔. 런(buildQueryOptions)과 모델 목록 받기(index.ts)가 같게 쓴다 —
 * 로그인 자리가 런과 같아야 같은 계정의 모델이 나온다
 */
export function cliEnv(baseEnv: NodeJS.ProcessEnv, configDirOverride?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  // 러너 프로세스(main.ts applyClaudeConfigDirEnv)와 같은 자리 — 전용이면 configDir, 평소면 baseEnv(기본 process.env)의 값.
  // 둘 다 없으면 넣지 않는다(평소 ~/.claude). ENV_ALLOWLIST 에 더하지 않고 여기서만 명시로 넣는다
  const configDir = configDirOverride ?? (baseEnv.CLAUDE_CONFIG_DIR || undefined);
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  // 켜 두면 메모리 자리가 cwd 로 정해져 작업 디렉터리가 같은 채널·스레드가 한 메모리를 나눠 쓴다(ADR 0007 5.10)
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  return env;
}

/** acceptEdits 가 묻지 않고 허용하는 편집 도구 */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * CLI 가 원래 묻지 않고 허용하는 안전 도구(에이전트 명령 C15, 조율자 판정 2026-11-21 — 목록 밖은 묻는다: fail-safe). 앞 열 개는
 * 조율자 목록, Skill 은 번들 CLI 2.1.283 default 모드에서 카드 없이 도는 것을 실측했다(보고서). 새 CLI 도구는 여기 없으므로 카드로
 * 간다 — 번거로움은 받아들인다
 */
export const SAFE_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "TodoWrite",
  "Task",
  "ListAgents",
  "EnterPlanMode",
  "ExitPlanMode",
  "Skill",
]);
/** 러너가 늘 허용하는 dodok 도구(post·제어 도구) — allowedTools 에 늘 든다 */
const isSafeTool = (toolName: string): boolean =>
  SAFE_TOOLS.has(toolName) || toolName.startsWith("mcp__dodok__");

/**
 * 명령·스킬 파일의 frontmatter `allowed-tools` 가 권한 모드를 뚫지 않게(에이전트 명령 C15) PreToolUse 훅이 내릴 판정. 실측(보고서):
 * `ask` 는 CLI 가 원래 묻지 않던 도구도 canUseTool(승인 카드)로 보내고, plan·dontAsk 에서는 거절되던 도구를 카드로 연다. 그래서
 * default → 안전 도구 밖이면 ask, acceptEdits → 안전·편집 도구 밖이면 ask, dontAsk → 안전 도구 밖이면 deny(묻지 않고 거절 — 모드
 * 뜻 그대로), plan → 손대지 않는다(CLI 가 이미 막는다). null 이면 CLI 판단 그대로
 */
export function preToolDecision(
  toolName: string,
  permissionMode: RunnerPermissionMode | string | undefined,
): "ask" | "deny" | null {
  if (isSafeTool(toolName)) return null;
  switch (permissionMode) {
    case "default":
      return "ask";
    case "acceptEdits":
      return EDIT_TOOLS.has(toolName) ? null : "ask";
    case "dontAsk":
      return "deny";
    default:
      return null;
  }
}

/**
 * 감싸개 원본의 Claude 설정 자리 — 전용 로그인이면 그 디렉터리, 평소면 셸의 CLAUDE_CONFIG_DIR, 없으면 HOME/.claude(CLI 가 읽는 자리와
 * 같게 — cliEnv)
 */
export function commandsConfigDir(baseEnv: NodeJS.ProcessEnv, configDir?: string): string {
  return configDir ?? (baseEnv.CLAUDE_CONFIG_DIR || join(baseEnv.HOME || homedir(), ".claude"));
}

/**
 * 명령·스킬을 들이며 막을 것(C15) — 스킬 frontmatter 훅·본문 인라인 셸을 끈다. 러너의 SDK 콜백 훅(UserPromptSubmit·PreToolUse)은
 * 그대로 돈다(스파이크 3절)
 */
export const COMMAND_SAFETY_SETTINGS = { disableAllHooks: true, disableSkillShellExecution: true } as const;

export function buildQueryOptions(
  spec: ClaudeRunSpec,
  deps: {
    baseEnv: NodeJS.ProcessEnv;
    mcpServer: unknown;
    canUseTool?: CanUseTool;
    resume: boolean;
    /** 머신에 설치된 claude 의 경로 — 없으면 SDK 번들 CLI */
    executable?: string;
    /** 사람의 명령·스킬 감싸개(command-wrappers.ts) — 모든 런에 싣는다(사람 글 속에서 모델이 스킬을 부를 수 있게) */
    plugins?: CommandWrapperPlugin[];
  },
): SdkOptions {
  const env = cliEnv(deps.baseEnv, spec.configDir);
  const { start } = spec;
  return {
    cwd: spec.workdir,
    // null 이면 CLI 기본 모델
    ...(spec.model === null ? {} : { model: spec.model }),
    // null·없음이면 CLI 기본 effort(세션 설정 스펙 5.6)
    ...(spec.effort === null || spec.effort === undefined ? {} : { effort: spec.effort }),
    permissionMode: spec.permissionMode,
    // dodok 도구는 늘 허용 — 승인 콜백은 입력 검증보다 먼저 와서 틀린 입력에도 카드가 뜬다(ADR 0007 4.2). 제어 도구의 쓰기는
    // 서버의 확인 카드가 묻는다(CONTROL_TOOL_FULL_NAMES)
    allowedTools: [
      ...new Set([...(spec.allowedTools ?? []), POST_TOOL_FULL_NAME, ...CONTROL_TOOL_FULL_NAMES]),
    ],
    disallowedTools: [...new Set([...RUNNER_DISALLOWED_TOOLS, ...spec.disallowedTools])],
    // sessionId 와 resume 은 함께 못 쓴다. title 을 주면 새 세션 제목을 짓는 보조 모델 호출이 없어진다(ADR 0007 4.8)
    ...(deps.resume
      ? { resume: start.providerSessionId }
      : { sessionId: start.providerSessionId, ...(start.sessionTitle ? { title: start.sessionTitle } : {}) }),
    // preset 을 생략하면 빈 시스템 프롬프트다(5.1). snapshot 을 생략하면 바뀐 채널 규칙이 기존 세션에 실리지 않는다(5.3)
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: start.channelRulesAppend,
      snapshot: false,
    },
    plugins: deps.plugins ?? [],
    settings: { ...COMMAND_SAFETY_SETTINGS },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              const { tool_name: toolName, permission_mode: mode } = input as {
                tool_name?: string;
                permission_mode?: string;
              };
              const decision =
                toolName === undefined ? null : preToolDecision(toolName, mode ?? spec.permissionMode);
              if (decision === null) return {};
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: decision,
                  ...(decision === "deny"
                    ? {
                        permissionDecisionReason:
                          "이 권한 모드에서는 묻지 않고 거절합니다(명령·스킬의 allowed-tools 는 쓰지 않습니다)",
                      }
                    : {}),
                },
              };
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            async () => ({
              hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: start.turnFacts },
            }),
          ],
        },
      ],
    },
    // alwaysLoad 는 서버 설정이 아니라 도구마다 _meta 로 실린다 — sdk.ts createMcpServer 가 붙인다
    mcpServers: { dodok: deps.mcpServer as SdkMcpServer },
    // strictMcpConfig 이 없으면 로그인한 계정의 claude.ai 커넥터가 MCP 로 붙는다(5.6).
    // settingSources [] — 사람 저장소의 .claude/settings.json·CLAUDE.md 를 끌어오지 않는다(6의 2)
    strictMcpConfig: true,
    settingSources: [],
    includePartialMessages: true,
    env,
    ...(deps.executable === undefined ? {} : { pathToClaudeCodeExecutable: deps.executable }),
    ...(deps.canUseTool ? { canUseTool: deps.canUseTool } : {}),
  };
}

// `--session-id` 로 연 세션의 전사가 이미 있으면 CLI 가 「Error: Session ID <id> is already in use.」로 끝나고, SDK 는
// 그 stderr 꼬리를 「Claude Code process exited with code 1」 오류 문구에 붙인다(번들 CLI 2.1.283 의 글자·sdk.mjs
// getProcessExitError). 판본마다 글이 바뀔 수 있어 넓게 본다 — 「address already in use」 류는 세션 낱말이 없어 빠진다
const SESSION_IN_USE = /\bsession\b[^\n]{0,120}?\balready (?:in use|exists)/i;
export const isSessionInUseText = (text: string): boolean => SESSION_IN_USE.test(text);

export type RunContext = {
  sdk: SdkPort;
  /** 결과·도구·승인이 나가는 한 자리 — 경로 가림도 sink 가 맡는다 */
  sink: RunSink;
  baseEnv: NodeJS.ProcessEnv;
  /** 머신에 설치된 claude 의 경로(드라이버가 고른다) — 없으면 SDK 번들 CLI */
  executable?: string;
  /** 세션별 마지막 total_cost_usd(세션 누적값 — ADR 0007 5.9). 러너 프로세스 메모리에만 있다 */
  costs: Map<string, number>;
  signal: AbortSignal;
  now?: () => number;
  closeGraceMs?: number;
  /** 러너 로그 한 줄 — 세션을 어느 길(새로·resume·거절 뒤 resume)로 열었는지 남긴다. 실연에서 그 길을 가리려고 */
  log?: (line: string) => void;
};

/**
 * 런 하나 = query() 하나 = CLI 프로세스 하나, 프롬프트도 하나(ADR 0007 6의 1). 턴 사실은 훅 문맥에만 있으므로
 * 훅 문맥이 요청에서 빠지는 두 경우(앞 턴 처리 중 보낸 프롬프트·interrupt 직후 프롬프트 — 4.5)를 만들지 않도록
 * 이 query() 에 프롬프트를 더 보내지 않는다. 결과는 ctx.sink 로 한 번만 나간다(final·error 중 하나) — 던지지 않는다.
 * 예외 하나: 새 세션으로 연 CLI 가 「이미 있는 세션」으로 거절하면 resume 으로 한 번 다시 연다(첫 query 는 스트림 전에 죽었다)
 */
export async function runOnce(spec: ClaudeRunSpec, ctx: RunContext): Promise<void> {
  const { start } = spec;
  // 중지로 끝난 런도 final 로 닫는다 — 어댑터가 dispatch 뒤 추적하던 런을 놓아준다(판정 R1)
  if (ctx.signal.aborted) return void ctx.sink.final(abortedFinal(undefined, ctx.signal.reason));
  const sessionId = start.providerSessionId;
  const runId = start.deliver.runId;
  const command = start.deliver.command;
  // 서버를 지나도 막는 명령은 한 번 더 막는다(에이전트 명령 스펙 5.3 — 이중 방어)
  if (command !== undefined) {
    const verdict = checkCommand("claude", command.name, command.args);
    if (!verdict.ok) return void ctx.sink.error("VALIDATION", verdict.message);
  }
  let resume = false;
  let lookup = "";
  try {
    // SDK 는 요약을 뽑을 수 없는 세션도 undefined 로 돌려준다 — 그러면 아래 재시도가 받친다
    resume = await ctx.sdk.sessionExists(sessionId, spec.workdir);
  } catch {
    // 전사를 못 읽으면 새 세션으로 연다 — 같은 id 의 전사가 실제로 있으면 CLI 가 거절하고 아래 재시도가 받친다
    lookup = "(전사 확인 실패)";
  }
  ctx.log?.(`dodok-runner: 런 ${runId} 세션 ${resume ? "resume" : "새로 열기"}${lookup}`);
  if (ctx.signal.aborted) return void ctx.sink.final(abortedFinal(undefined, ctx.signal.reason));
  // 받기 실패는 그 이미지만 뺀다 — loadImageBlocks 는 던지지 않는다. 명령 런은 글 그대로라 이미지를 싣지 않는다
  const images =
    command === undefined
      ? await loadImageBlocks(start.deliver, ctx.sink.http, ctx.signal)
      : { blocks: [], failed: 0 };
  if (ctx.signal.aborted) return void ctx.sink.final(abortedFinal(undefined, ctx.signal.reason));
  // 감싸개를 못 만들면(임시 디렉터리 실패) 명령·스킬 없이 돈다 — 런을 막지 않는다
  let wrappers: CommandWrappers | undefined;
  try {
    wrappers = await createCommandWrappers({
      configDir: commandsConfigDir(ctx.baseEnv, spec.configDir),
      cwd: spec.workdir,
    });
  } catch (error) {
    ctx.log?.(`dodok-runner: 런 ${runId} 명령·스킬 감싸개를 만들지 못했습니다 — ${String(error)}`);
  }
  const plugins = wrappers?.plugins ?? [];
  try {
    const outcome = await attempt(spec, ctx, resume, images, plugins);
    if (outcome !== "session-in-use") return;
    if (ctx.signal.aborted) return void ctx.sink.final(abortedFinal(undefined, ctx.signal.reason));
    ctx.log?.(`dodok-runner: 런 ${runId} 이미 있는 세션이라 resume 으로 다시 엽니다`);
    await attempt(spec, ctx, true, images, plugins);
  } finally {
    await wrappers?.dispose().catch(() => {});
  }
}

/** 이미지가 있으면 이미지 블록 뒤에 글(이미지를 글보다 앞에 두기를 Messages API 문서가 권한다), 못 불러온 수는 글 끝 한 줄 */
function promptContent(
  start: ClaudeRunSpec["start"],
  images: { blocks: SdkImageBlock[]; failed: number },
): SdkUserMessage["message"]["content"] {
  // 명령 런은 머리말 없이 `/<name>[ <args>]` 그대로 — CLI 가 명령으로 처리한다(에이전트 명령 C1). 턴 사실은 훅 문맥으로 그대로 붙는다
  if (start.deliver.command !== undefined) return formatCommandText(start.deliver.command);
  const text =
    renderRunnerPrompt(start.deliver) + (images.failed > 0 ? `\n${imageFailureNote(images.failed)}` : "");
  return images.blocks.length > 0 ? [...images.blocks, { type: "text", text }] : text;
}

/** query() 하나. 새 세션으로 열었는데 스트림 전에 「이미 있는 세션」으로 거절됐으면 아무것도 내지 않고 알린다 */
async function attempt(
  spec: ClaudeRunSpec,
  ctx: RunContext,
  resume: boolean,
  images: { blocks: SdkImageBlock[]; failed: number },
  plugins: CommandWrapperPlugin[],
): Promise<"done" | "session-in-use"> {
  const { start } = spec;
  const sessionId = start.providerSessionId;
  const now = ctx.now ?? Date.now;
  const mask = ctx.sink.mask;
  const mapper = createStreamMapper(now, {
    runId: start.deliver.runId,
    mask,
    command: start.deliver.command !== undefined,
  });

  let finishInput!: () => void;
  const inputDone = new Promise<void>((resolve) => (finishInput = resolve));
  const promptMessage: SdkUserMessage = {
    type: "user",
    message: { role: "user", content: promptContent(start, images) },
    parent_tool_use_id: null,
  };
  // 입력은 런의 끝(프롬프트 턴의 result)까지 열어 둔다 — 닫으면 SDK 가 stdin 을 닫아 권한 콜백·SDK MCP 가 멈춘다
  async function* prompt(): AsyncGenerator<SdkUserMessage> {
    yield promptMessage;
    await inputDone;
  }

  const failed = (error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    const code: ErrorCode = isAuthFailureText(text) ? "PROVIDER_AUTH" : "INTERNAL";
    const head =
      code === "PROVIDER_AUTH" ? `러너의 ${CLAUDE_CODE_LABEL} 로그인을 확인하세요` : "Claude Code 실행 실패";
    // 가림·길이 자르기는 sink 가 한다
    ctx.sink.error(code, `${head}: ${text}`);
  };
  const retryable = (error: unknown) =>
    !resume && isSessionInUseText(error instanceof Error ? error.message : String(error));

  let q: SdkQuery;
  try {
    q = ctx.sdk.query({
      prompt: prompt(),
      options: buildQueryOptions(spec, {
        baseEnv: ctx.baseEnv,
        ...(ctx.executable === undefined ? {} : { executable: ctx.executable }),
        mcpServer: createDodokMcpServer({
          sdk: ctx.sdk,
          post: createPoster({
            workdir: spec.workdir,
            deliver: start.deliver,
            http: ctx.sink.http,
            send: (m) => ctx.sink.post(m),
            mask,
            signal: ctx.signal,
            now,
          }),
          tools: createControlTools({
            runId: start.deliver.runId,
            call: (call) => ctx.sink.control(call),
          }),
        }),
        canUseTool: createCanUseTool({
          runId: start.deliver.runId,
          sessionKey: start.deliver.sessionKey,
          workdir: spec.workdir,
          emit: (p) => ctx.sink.requestApproval(p),
          withdraw: (id) => ctx.sink.withdrawApproval(id),
          waitDecision: (id, signal) => ctx.sink.waitDecision(id, signal),
          signal: ctx.signal,
        }),
        resume,
        plugins,
      }),
    });
  } catch (error) {
    if (retryable(error)) return "session-in-use";
    failed(error);
    return "done";
  }

  const graceMs = ctx.closeGraceMs ?? ABORT_CLOSE_MS;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const closeLater = () => {
    closeTimer ??= setTimeout(() => q.close(), graceMs);
  };
  let interrupted = false;
  const onAbort = () => {
    interrupted = true;
    mapper.markInterrupted(abortStopReason(ctx.signal.reason));
    q.interrupt().catch(() => {});
    closeLater();
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  let ended = false;
  let sawMessage = false;
  let costKind: RunnerRunFinal["costKind"] = "subscription_estimate";
  const end = () => {
    ended = true;
    finishInput();
    // 입력을 닫으면 CLI 가 끝난다 — 끝나지 않으면 유예 뒤 닫는다
    closeLater();
  };

  // total_cost_usd 는 세션 누적값이다 — resume 한 프로세스의 첫 result 에 앞 런 비용이 이미 들어 있다(ADR 0007 5.9)
  let costRecorded = false;
  const recordCost = (total: number | undefined): number | undefined => {
    costRecorded = true;
    if (typeof total !== "number") return undefined;
    const prev = ctx.costs.get(sessionId);
    const cost = !resume ? total : prev === undefined ? undefined : Math.max(0, total - prev);
    // 비정상 종료한 CLI 의 result 는 0 을 실을 수 있다 — 이어 간 세션의 알던 누적값을 0 으로 되돌리지 않는다
    if (total > 0 || !resume) ctx.costs.set(sessionId, total);
    return cost;
  };

  try {
    for await (const m of q as AsyncIterable<SdkMessage>) {
      sawMessage = true;
      if (ended) continue;
      const raw = m as { type?: string; subtype?: string; apiKeySource?: string; total_cost_usd?: number };
      if (raw.type === "system" && raw.subtype === "init" && raw.apiKeySource) {
        costKind = API_KEY_SOURCES.has(raw.apiKeySource) ? "api" : "subscription_estimate";
      }
      for (const item of mapper.map(m)) {
        if (item.event) {
          ctx.sink.event(item.event);
        } else if (item.final) {
          const { totalCostUsd, ...rest } = item.final;
          const costUsd = recordCost(totalCostUsd);
          // 세부는 입력을 닫기 전에 묻는다 — 닫으면 CLI 가 끝나 제어 요청에 답하지 않는다. 중지된 턴은 묻지 않는다(작성기 칩 스펙 C7)
          const contextBreakdown =
            interrupted || ctx.signal.aborted ? undefined : await fetchContextBreakdown(q);
          const usage = contextBreakdown === undefined ? rest.usage : { ...rest.usage, contextBreakdown };
          ctx.sink.final({
            ...rest,
            ...(usage === undefined ? {} : { usage }),
            ...(costUsd === undefined ? {} : { costUsd }),
            costKind,
          });
          end();
        } else if (item.error) {
          ctx.sink.error(item.error.code, item.error.message);
          end();
        }
      }
      // 오류로 끝난 턴도 누적 비용을 싣는다 — 다음 런의 차이가 맞도록 기록만 한다
      if (ended && raw.type === "result" && !costRecorded) recordCost(raw.total_cost_usd);
    }
    if (!ended) {
      if (interrupted) ctx.sink.final(abortedFinal(costKind, ctx.signal.reason));
      else ctx.sink.error("INTERNAL", "Claude Code 가 결과 없이 끝났습니다");
    }
  } catch (error) {
    // 마지막 result 뒤에 CLI 가 exit 1 로 끝나 반복자가 던질 수 있다(ADR 0007 4.4) — 런은 이미 끝났다
    if (!ended) {
      if (interrupted) ctx.sink.final(abortedFinal(costKind, ctx.signal.reason));
      else if (!sawMessage && retryable(error)) return "session-in-use";
      else failed(error);
    }
  } finally {
    ended = true;
    ctx.signal.removeEventListener("abort", onAbort);
    finishInput();
    if (closeTimer) clearTimeout(closeTimer);
    q.close();
  }
  return "done";
}

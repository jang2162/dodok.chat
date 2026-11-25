import {
  appMcpVerdict,
  checkCommand,
  isPrivateAddress,
  isStdioServer,
  CLAUDE_BUILTIN_ALLOWED,
  COMMAND_BLOCKED_MESSAGE,
  compareVersions,
  type DeliverCommand,
  formatCommandText,
  renderRunnerPrompt,
  RUNNER_BOT_SOUL_HEADER,
  RUNNER_PROGRAM_NAME,
  type ErrorCode,
  type RunnerPermissionMode,
  type RunnerRunFinal,
} from "@dodok/shared";
import { rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_TOOL_FULL_NAMES,
  createControlTools,
  RUNNER_CONTROL_TOOL_FULL_NAMES,
} from "../../control-tools";
import type { RunSpec } from "../../driver";
import { imageFailureNote, loadImageBlocks, type SdkImageBlock } from "../../images";
import { createDodokMcpServer, createPoster, POST_TOOL_FULL_NAME } from "../../post-tool";
import { abortedFinal, abortStopReason, type RunSink } from "../../sink";
import { type AlwaysAllowed, alwaysAllowKey, createCanUseTool } from "./approvals";
import { type CommandWrapperPlugin, type CommandWrappers, createCommandWrappers } from "./command-wrappers";
import { fetchContextBreakdown } from "./context-usage";
import type {
  CanUseTool,
  SdkMcpServer,
  SdkOptions,
  SdkPort,
  SdkQuery,
  SdkSlashCommand,
  SdkUserMessage,
} from "./sdk";
import type { BackgroundHooks } from "../../driver";
import { createSessionProcess, type RunBinding, type SessionProcess } from "./session-process";
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
 * 봇 MCP 의 자동 허용 이름(러너 봇 2부 스펙 T15)에 드는가 — `mcp__<서버>`(서버 전부)는 그 서버의 도구 모두, `mcp__<서버>__<도구>` 는 그
 * 이름만. allowedTools 와 같은 뜻이다(PreToolUse 훅의 ask 가 allowedTools 를 덮지 않게)
 */
export function isAutoAllowedTool(toolName: string, autoAllowed: readonly string[]): boolean {
  // 서버 전부(`mcp__a`)는 `mcp__a__<도구>` 만 — 도구 이름 첫 글자가 `_` 면(`mcp__a___x`) 서버 `a_` 의 도구일 수 있어 넣지 않는다
  return autoAllowed.some((name) =>
    name.split("__").length === 2
      ? toolName.startsWith(`${name}__`) && !toolName.startsWith(`${name}___`)
      : toolName === name,
  );
}

/**
 * 주소 판정을 WHATWG 호스트로 한 번 더(T17) — shared isPrivateAddress 는 주소 글자를 읽고, CLI 는 WHATWG(fetch)로 연결한다. 스키마가
 * authority 의 `\`·ASCII 밖 글자를 거절하지만, 둘이 같은 호스트를 보는지 여기서 Node 의 URL 로 다시 본다. 못 읽으면 막는다
 */
function privateByWhatwg(url: string): boolean {
  try {
    return isPrivateAddress(`http://${new URL(url).hostname}/`);
  } catch {
    return true;
  }
}

/** SDK mcpServers 에 넣을 봇 MCP 서버 — 받은 꼴(shared McpServerConfig) 그대로의 필드만 */
type SdkExternalMcpServer =
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

export type BotMcp = { servers: Record<string, SdkExternalMcpServer>; allowedTools: string[] };

/**
 * 봇 런의 앱 MCP(러너 봇 2부 스펙 T3·T6·T12) — 서버가 판정했어도 러너가 이 머신의 천장(spec.appMcp)으로 다시 판정해 통과한 서버만
 * 붙인다(서버를 믿지 않는다 — Review Focus 1). 막힌 서버는 로그 한 줄(이름·사유만 — 헤더·env 값은 싣지 않는다). 프로젝트 에이전트
 * 런에는 외부 MCP 가 없다(T12). 천장이 없으면 모두 막는다
 */
export function assembleBotMcp(spec: RunSpec, log?: (line: string) => void): BotMcp {
  const bot = spec.start.agent.bot;
  const out: BotMcp = { servers: {}, allowedTools: [] };
  if (bot?.mcpServers === undefined) return out;
  const ceiling = spec.appMcp ?? { appMcp: "off", appMcpCommands: null, allowedToolsCeiling: null };
  const runId = spec.start.deliver.runId;
  for (const [name, server] of Object.entries(bot.mcpServers)) {
    const verdict = appMcpVerdict(ceiling, name, server, bot.mcpAutoAllow?.[name]);
    if (!verdict.ok) {
      log?.(
        `dodok-runner: 런 ${runId} bot mcp blocked ${name} ${verdict.reason}${verdict.detail === undefined ? "" : `(${verdict.detail})`}`,
      );
      continue;
    }
    if (!isStdioServer(server) && ceiling.appMcp === "http" && privateByWhatwg(server.url)) {
      log?.(`dodok-runner: 런 ${runId} bot mcp blocked ${name} privateAddress`);
      continue;
    }
    if (verdict.outsideCeiling.length > 0)
      log?.(
        `dodok-runner: 런 ${runId} bot mcp ${name} auto-allow outside ceiling(${verdict.outsideCeiling.join(", ")})`,
      );
    out.servers[name] = isStdioServer(server)
      ? {
          type: "stdio",
          command: server.command,
          ...(server.args === undefined ? {} : { args: server.args }),
          ...(server.env === undefined ? {} : { env: server.env }),
        }
      : {
          type: server.type,
          url: server.url,
          ...(server.headers === undefined ? {} : { headers: server.headers }),
        };
    out.allowedTools.push(...verdict.allowedTools);
  }
  const attached = Object.keys(out.servers);
  if (attached.length > 0) log?.(`dodok-runner: 런 ${runId} bot mcp ${attached.join(", ")}`);
  return out;
}

/** 「이 러너 설정 제어」(T7) — 봇 정의의 내장 도구에 runnerControl 이 있는 봇 런만 */
export const hasRunnerControl = (spec: RunSpec): boolean =>
  spec.start.agent.bot?.builtinTools?.includes("runnerControl") === true;

/**
 * 명령·스킬 파일의 frontmatter `allowed-tools` 가 권한 모드를 뚫지 않게(에이전트 명령 C15) PreToolUse 훅이 내릴 판정. 실측(보고서):
 * `ask` 는 CLI 가 원래 묻지 않던 도구도 canUseTool(승인 카드)로 보내고, plan·dontAsk 에서는 거절되던 도구를 카드로 연다. 그래서
 * default → 안전 도구 밖이면 ask, acceptEdits → 안전·편집 도구 밖이면 ask, dontAsk → 안전 도구 밖이면 deny(묻지 않고 거절 — 모드
 * 뜻 그대로), plan → 손대지 않는다(CLI 가 이미 막는다). auto(모델 분류기가 승인)·bypassPermissions(묻지 않음)도 손대지 않는다 —
 * `ask` 를 내면 승인 카드 없이 돌라고 상한을 연 모드에서 카드가 다시 뜬다(채널 UI·권한 모드 스펙 1장). null 이면 CLI 판단 그대로
 */
export function preToolDecision(
  toolName: string,
  permissionMode: RunnerPermissionMode | string | undefined,
  autoAllowed: readonly string[] = [],
): "ask" | "deny" | null {
  if (isSafeTool(toolName) || isAutoAllowedTool(toolName, autoAllowed)) return null;
  switch (permissionMode) {
    case "default":
      return "ask";
    case "acceptEdits":
      return EDIT_TOOLS.has(toolName) ? null : "ask";
    case "dontAsk":
      return "deny";
    case "auto":
    case "bypassPermissions":
      return null;
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
    /** 그 런에서 「항상 허용」한 것 — PreToolUse 훅이 끼어들지 않는다(canUseTool 이 카드 없이 허용한다) */
    alwaysAllowed?: AlwaysAllowed;
    /** 봇 런의 앱 MCP(assembleBotMcp) — 러너가 다시 판정해 통과한 것만 */
    botMcp?: BotMcp;
    /** CLI 가 --thinking-display 를 아는 판이면 true(supportsThinkingDisplay) — 추론 글(요약)을 받는다 */
    thinkingDisplay?: boolean;
    /**
     * 지금 턴의 런 — 붙든 프로세스(세션 프로세스)는 런이 바뀌어도 이 query 를 계속 쓰므로 훅이 턴 사실·「항상 허용」·권한 모드를
     * 여기서 읽는다(백그라운드 작업 스펙 5.2). 없으면 spec·alwaysAllowed 그대로
     */
    live?: () => Pick<RunBinding, "turnFacts" | "alwaysAllowed" | "permissionMode">;
  },
): SdkOptions {
  const botMcp = deps.botMcp ?? { servers: {}, allowedTools: [] };
  const runnerControl = hasRunnerControl(spec);
  const env = cliEnv(deps.baseEnv, spec.configDir);
  const { start } = spec;
  return {
    cwd: spec.workdir,
    // null 이면 CLI 기본 모델
    ...(spec.model === null ? {} : { model: spec.model }),
    // null·없음이면 CLI 기본 effort(세션 설정 스펙 5.6)
    ...(spec.effort === null || spec.effort === undefined ? {} : { effort: spec.effort }),
    permissionMode: spec.permissionMode,
    // SDK 는 bypassPermissions 에 이 확인 깃발을 함께 요구한다 — 러너 상한이 bypassPermissions 를 열었을 때만 이 값이 온다(ceiling.ts)
    ...(spec.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    // dodok 도구는 늘 허용 — 승인 콜백은 입력 검증보다 먼저 와서 틀린 입력에도 카드가 뜬다(ADR 0007 4.2). 제어 도구의 쓰기는
    // 서버의 확인 카드가 묻는다(CONTROL_TOOL_FULL_NAMES)
    allowedTools: [
      ...new Set([
        ...(spec.allowedTools ?? []),
        POST_TOOL_FULL_NAME,
        ...CONTROL_TOOL_FULL_NAMES,
        ...(runnerControl ? RUNNER_CONTROL_TOOL_FULL_NAMES : []),
        // 앱에서 「묻지 않음」으로 고른 봇 MCP 도구(T15) — 나머지는 권한 모드·승인 카드를 지난다
        ...botMcp.allowedTools,
      ]),
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
              const {
                tool_name: toolName,
                tool_input: toolInput,
                permission_mode: mode,
              } = input as {
                tool_name?: string;
                tool_input?: unknown;
                permission_mode?: string;
              };
              const live = deps.live?.();
              const decision =
                toolName === undefined
                  ? null
                  : preToolDecision(
                      toolName,
                      mode ?? live?.permissionMode ?? spec.permissionMode,
                      botMcp.allowedTools,
                    );
              if (decision === null) return {};
              // 사람이 이 런에서 「항상 허용」한 것은 묻게 만들지 않는다 — `ask` 는 CLI 세션 규칙을 덮어 카드가 다시 뜬다
              const allowed = live?.alwaysAllowed ?? deps.alwaysAllowed;
              if (
                decision === "ask" &&
                allowed?.has(alwaysAllowKey(toolName as string, toolInput, spec.workdir))
              )
                return {};
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
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: deps.live?.().turnFacts ?? start.turnFacts,
              },
            }),
          ],
        },
      ],
    },
    // alwaysLoad 는 서버 설정이 아니라 도구마다 _meta 로 실린다 — sdk.ts createMcpServer 가 붙인다
    // 봇 MCP 는 dodok 과 나란히(T6) — 이름 dodok 은 계약이 거절해 여기 오지 않는다. dodok 을 뒤에 두어 덮이지 않게 한다
    mcpServers: { ...botMcp.servers, dodok: deps.mcpServer as SdkMcpServer },
    // strictMcpConfig 이 없으면 로그인한 계정의 claude.ai 커넥터가 MCP 로 붙는다(5.6).
    // settingSources [] — 사람 저장소의 .claude/settings.json·CLAUDE.md 를 끌어오지 않는다(6의 2)
    strictMcpConfig: true,
    settingSources: [],
    includePartialMessages: true,
    // 추론 글 — 넘기지 않으면 thinking_delta 가 빈 글로 온다(ADR 0007 4.1). SDK 의 thinking 옵션은 type 까지 정해 버려
    // 모델마다 다른 CLI 기본(adaptive·enabled)을 덮으므로, 표시 방식만 CLI 플래그로 넘긴다
    ...(deps.thinkingDisplay ? { extraArgs: { [THINKING_DISPLAY_FLAG]: THINKING_DISPLAY } } : {}),
    env,
    ...(deps.executable === undefined ? {} : { pathToClaudeCodeExecutable: deps.executable }),
    ...(deps.canUseTool ? { canUseTool: deps.canUseTool } : {}),
  };
}

const THINKING_DISPLAY_FLAG = "thinking-display";
const THINKING_DISPLAY = "summarized";
/**
 * --thinking-display 를 아는 것으로 확인한 가장 낮은 CLI 판 — SDK 0.3.283 의 번들 CLI(2.1.283)가 안다. 모르는 플래그를 받은 CLI 는
 * 「error: unknown option」으로 런 전체가 실패하므로, 판을 모르거나 이보다 낮으면 넘기지 않는다(추론 글 없이 START/END 만)
 */
export const THINKING_DISPLAY_MIN_CLI = "2.1.283";
export function supportsThinkingDisplay(cliVersion: string | undefined): boolean {
  if (cliVersion === undefined) return false;
  return compareVersions(cliVersion, THINKING_DISPLAY_MIN_CLI) >= 0;
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
  /** 쓰는 CLI 의 판(설치본은 --version, 번들은 빌드가 구운 값) — 모르면 없다 */
  cliVersion?: string;
  /** 세션별 마지막 total_cost_usd(세션 누적값 — ADR 0007 5.9). 러너 프로세스 메모리에만 있다 */
  costs: Map<string, number>;
  signal: AbortSignal;
  now?: () => number;
  closeGraceMs?: number;
  /** 러너 로그 한 줄 — 세션을 어느 길(새로·resume·거절 뒤 resume)로 열었는지 남긴다. 실연에서 그 길을 가리려고 */
  log?: (line: string) => void;
  /**
   * 백그라운드 작업(백그라운드 작업 스펙 5.2) — 드라이버가 세션 프로세스 맵과 훅을 준다. 작업이 남은 result 뒤 프로세스를 붙들고,
   * 붙든 세션의 다음 런은 같은 프로세스로 들어간다. 없으면 첫 result 에서 닫는다(지금 동작)
   */
  background?: BackgroundContext;
  /** 시험이 줄인다 — 알림 뒤 CLI 가 턴을 열기를 기다리는 시간(session-process SELF_TURN_WAIT_MS) */
  selfTurnWaitMs?: number;
};

export type BackgroundContext = {
  hooks: BackgroundHooks;
  /** 세션 키 → 그 세션의 CLI 프로세스(도는 것·붙든 것). 프로세스가 끝나면 빠진다 */
  sessions: Map<string, SessionProcess>;
};

/** 붙든 프로세스에 이어 넣은 런의 설정 가운데 도는 중에 못 바꾼 것 — 웹이 그 런 카드에 D6 문구를 붙인다 */
export const HELD_SETTINGS_EVENT = "dodok.held_settings";

/**
 * `<봇 폴더>/SOUL.md` = 머리 줄 + 서버 정의. 새 파일(`wx` — 이미 있는 것·링크를 따라가지 않는다)에 쓰고 rename 으로 바꾼다 —
 * SOUL.md 가 링크여도 링크 자체가 바뀌고 링크가 가리키는 곳에는 쓰지 않는다
 */
export async function writeSoul(dir: string, soul: string, runId: string): Promise<void> {
  const tmp = join(dir, `.SOUL.md.${runId}.tmp`);
  try {
    await writeFile(tmp, `${RUNNER_BOT_SOUL_HEADER}\n\n${soul}`, { flag: "wx", mode: 0o600 });
    await rename(tmp, join(dir, "SOUL.md"));
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/**
 * 런 하나. 붙든 프로세스가 없으면 query() 하나 = CLI 프로세스 하나를 새로 열고 프롬프트 하나를 보낸다(ADR 0007 6의 1). 턴 사실은 훅
 * 문맥에만 있으므로 훅 문맥이 요청에서 빠지는 두 경우(앞 턴 처리 중 보낸 프롬프트·interrupt 직후 프롬프트 — 4.5)를 만들지 않도록
 * 도는 턴에 프롬프트를 더 보내지 않는다. 결과는 ctx.sink 로 한 번만 나간다(final·error 중 하나) — 던지지 않는다.
 * 예외 하나: 새 세션으로 연 CLI 가 「이미 있는 세션」으로 거절하면 resume 으로 한 번 다시 연다(첫 query 는 스트림 전에 죽었다).
 * 백그라운드 작업이 남은 채 턴이 끝나면 프로세스를 붙들고(ctx.background), 그 세션의 다음 런은 같은 프로세스의 다음 턴이 된다
 */
export async function runOnce(spec: ClaudeRunSpec, ctx: RunContext): Promise<void> {
  const { start } = spec;
  // 중지로 끝난 런도 final 로 닫는다 — 어댑터가 dispatch 뒤 추적하던 런을 놓아준다(판정 R1)
  if (ctx.signal.aborted) return void ctx.sink.final(abortedFinal(undefined, ctx.signal.reason));
  const runId = start.deliver.runId;
  const command = start.deliver.command;
  // 서버를 지나도 막는 명령은 한 번 더 막는다(에이전트 명령 스펙 5.3 — 이중 방어)
  if (command !== undefined) {
    const verdict = checkCommand("claude", command.name, command.args);
    if (!verdict.ok) return void ctx.sink.error("VALIDATION", verdict.message);
  }
  // 봇 런 — 봇 폴더(workdir)의 SOUL.md 를 서버 정의로 다시 쓴다(러너 봇 스펙 B4). 못 써도 런은 돈다(지시는 서버가 이미 넣었다)
  const bot = start.agent.bot;
  if (bot !== undefined) {
    try {
      await writeSoul(spec.workdir, bot.soul, runId);
    } catch (error) {
      ctx.log?.(`dodok-runner: 런 ${runId} SOUL.md 를 쓰지 못했습니다 — ${String(error)}`);
    }
  }
  const held = await heldProcessFor(spec, ctx);
  if (held === "aborted") return void ctx.sink.final(abortedFinal(undefined, ctx.signal.reason));
  // heldProcessFor 가 쥐여 준 자리 — 턴을 열지 않고 나가면 놓는다. 안 놓으면 그 세션의 다음 런이 whenIdle 에서 영영 기다리고
  // 프로세스도 닫히지 않는다(리뷰 B1)
  let reservation: SessionProcess | undefined = held;
  try {
    return await runOnceReserved(spec, ctx, held, () => (reservation = undefined));
  } finally {
    reservation?.unreserve();
  }
}

/** runOnce 의 나머지 — heldAtStart 의 자리는 handOff() 를 부르기 전까지 runOnce 가 쥐고 있다(이른 반환이면 runOnce 가 놓는다) */
async function runOnceReserved(
  spec: ClaudeRunSpec,
  ctx: RunContext,
  heldAtStart: SessionProcess | undefined,
  handOff: () => void,
): Promise<void> {
  const { start } = spec;
  const sessionId = start.providerSessionId;
  const runId = start.deliver.runId;
  const command = start.deliver.command;
  let held: SessionProcess | undefined | "aborted" = heldAtStart;
  let resume = false;
  if (held === undefined) {
    let lookup = "";
    try {
      // SDK 는 요약을 뽑을 수 없는 세션도 undefined 로 돌려준다 — 그러면 아래 재시도가 받친다
      resume = await ctx.sdk.sessionExists(sessionId, spec.workdir);
    } catch {
      // 전사를 못 읽으면 새 세션으로 연다 — 같은 id 의 전사가 실제로 있으면 CLI 가 거절하고 아래 재시도가 받친다
      lookup = "(전사 확인 실패)";
    }
    ctx.log?.(`dodok-runner: 런 ${runId} 세션 ${resume ? "resume" : "새로 열기"}${lookup}`);
  } else {
    ctx.log?.(`dodok-runner: 런 ${runId} 세션 붙든 프로세스로 이어 넣기`);
  }
  if (ctx.signal.aborted) return void ctx.sink.final(abortedFinal(undefined, ctx.signal.reason));
  // 받기 실패는 그 이미지만 뺀다 — loadImageBlocks 는 던지지 않는다. 명령 런은 글 그대로라 이미지를 싣지 않는다
  const images =
    command === undefined
      ? await loadImageBlocks(start.deliver, ctx.sink.http, ctx.signal)
      : { blocks: [], failed: 0 };
  if (ctx.signal.aborted) return void ctx.sink.final(abortedFinal(undefined, ctx.signal.reason));
  const alwaysAllowed: AlwaysAllowed = new Set();
  const botMcp = assembleBotMcp(spec, ctx.log);
  if (held !== undefined) {
    // 여기부터 자리는 runHeldTurn 이 쥔다 — 턴을 열거나 스스로 놓는다
    handOff();
    const outcome = await runHeldTurn(spec, ctx, held, images, alwaysAllowed, botMcp);
    if (outcome === "done") return;
    if (outcome === "aborted") return void ctx.sink.final(abortedFinal(undefined, ctx.signal.reason));
    // 기다리는 사이 프로세스가 닫혀 갔다 — 끝나기를 기다렸다가 새로 연다
    held = await heldProcessFor(spec, ctx);
    if (held === "aborted") return void ctx.sink.final(abortedFinal(undefined, ctx.signal.reason));
    if (held !== undefined) {
      held.unreserve();
      return void ctx.sink.error("INTERNAL", "Claude Code 세션 프로세스를 이어 쓰지 못했습니다");
    }
    try {
      resume = await ctx.sdk.sessionExists(sessionId, spec.workdir);
    } catch {
      resume = false;
    }
  }
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
  // 붙든 프로세스는 감싸개(플러그인 임시 디렉터리)를 계속 읽는다 — 그 프로세스가 끝날 때 치운다
  let keptBy: SessionProcess | undefined;
  try {
    let outcome = await attempt(spec, ctx, resume, images, plugins, alwaysAllowed, botMcp);
    if (outcome.result === "session-in-use") {
      if (ctx.signal.aborted) return void ctx.sink.final(abortedFinal(undefined, ctx.signal.reason));
      ctx.log?.(`dodok-runner: 런 ${runId} 이미 있는 세션이라 resume 으로 다시 엽니다`);
      outcome = await attempt(spec, ctx, true, images, plugins, alwaysAllowed, botMcp);
    }
    if (outcome.result === "held") keptBy = outcome.process;
  } finally {
    if (keptBy && wrappers) {
      const w = wrappers;
      keptBy.onExit(() => w.dispose());
    } else {
      await wrappers?.dispose().catch(() => {});
    }
  }
}

/**
 * 이 런을 넣을 붙든 프로세스 — 없으면 undefined(새로 연다). 붙든 프로세스에 도는 턴(추가 응답)이 있으면 그 턴이 끝날 때까지 기다리고
 * (한 번에 한 턴), 풀리면 그 자리를 쥔 채 돌려준다 — 곧바로 턴을 열거나 unreserve 한다. 기다리다 중지되면 "aborted".
 * 끝나 가는 프로세스는 끝날 때까지 기다린다 — 같은 세션 파일을 두 CLI 가 함께 쓰지 않게(ADR 0007 4.3). 세션이 리셋됐거나(다른 세션
 * id) 작업 디렉터리·로그인 자리·CLI 가 바뀌었으면 옛 프로세스의 작업은 이어 갈 수 없다 — 놓고(작업이 꺼진다) 새로 연다
 */
async function heldProcessFor(
  spec: ClaudeRunSpec,
  ctx: RunContext,
): Promise<SessionProcess | undefined | "aborted"> {
  const bg = ctx.background;
  if (bg === undefined) return undefined;
  const sp = bg.sessions.get(spec.start.deliver.sessionKey);
  if (sp === undefined) return undefined;
  const opened = openedOf.get(sp);
  const compatible =
    sp.sessionId === spec.start.providerSessionId &&
    opened !== undefined &&
    opened.workdir === spec.workdir &&
    opened.configDir === spec.configDir &&
    opened.executable === ctx.executable;
  if (sp.reusable() && compatible) {
    if (!(await sp.whenIdle(ctx.signal))) return "aborted";
    if (sp.reusable()) return sp;
    sp.unreserve();
  } else if (sp.reusable()) {
    ctx.log?.(`dodok-runner: 런 ${spec.start.deliver.runId} 세션이 바뀌어 붙든 프로세스를 놓습니다`);
    sp.release();
  }
  await sp.exited;
  return undefined;
}

const NO_IMAGES = { blocks: [], failed: 0 };

/** 프로세스를 연 설정 — 붙든 프로세스에 이어 넣는 런과 견준다(D6) */
type OpenedSettings = {
  workdir: string;
  configDir: string | undefined;
  executable: string | undefined;
  model: string | null;
  permissionMode: string;
  effort: RunSpec["effort"] | null;
  append: string;
  allowedTools: string;
  disallowedTools: string;
  mcpServers: string;
  dodokServer: SdkMcpServer;
  plugins: CommandWrapperPlugin[];
  costKind: RunnerRunFinal["costKind"];
  /** 마지막으로 이 프로세스에 넣은 런 — 스스로 연 턴(추가 응답)이 그 정의·문맥을 잇는다 */
  last: { spec: ClaudeRunSpec; ctx: RunContext };
};
const openedOf = new WeakMap<SessionProcess, OpenedSettings>();

const sortedKey = (list: readonly string[] | undefined) => JSON.stringify([...(list ?? [])].sort());

/** 런 하나의 바인딩 — 도구·승인·훅이 붙든 프로세스에서도 지금 런을 보게 */
function bindingFor(spec: ClaudeRunSpec, ctx: RunContext, alwaysAllowed: AlwaysAllowed): RunBinding {
  const { start } = spec;
  return {
    runId: start.deliver.runId,
    deliver: start.deliver,
    sessionKey: start.deliver.sessionKey,
    signal: ctx.signal,
    turnFacts: start.turnFacts,
    permissionMode: spec.permissionMode,
    alwaysAllowed,
    sink: ctx.sink,
    post: createPoster({
      workdir: spec.workdir,
      deliver: start.deliver,
      http: ctx.sink.http,
      send: (m) => ctx.sink.post(m),
      mask: ctx.sink.mask,
      signal: ctx.signal,
      now: ctx.now ?? Date.now,
    }),
    canUseTool: runScopedAllowAlways(
      createCanUseTool({
        runId: start.deliver.runId,
        sessionKey: start.deliver.sessionKey,
        workdir: spec.workdir,
        emit: (p) => ctx.sink.requestApproval(p),
        withdraw: (id) => ctx.sink.withdrawApproval(id),
        waitDecision: (id, signal) => ctx.sink.waitDecision(id, signal),
        signal: ctx.signal,
        alwaysAllowed,
      }),
      ctx.background !== undefined,
      alwaysAllowed,
      spec.workdir,
    ),
  };
}

/**
 * 「항상 허용」을 런 단위로 묶는다(백그라운드 작업 스펙 5.2). 제안이 있는 승인은 CLI 의 세션 규칙(updatedPermissions destination
 * session)으로 가는데, 붙든 프로세스에서는 그 규칙이 다음 런까지 남는다 — 붙들 수 있는 프로세스면 규칙을 CLI 로 보내지 않고 그 요청
 * 그대로를 이 런의 alwaysAllowed 에 넣는다(제안의 넓은 규칙보다 좁다). 붙들지 않는 프로세스는 런이 끝나면 CLI 도 끝나 지금 그대로다
 */
function runScopedAllowAlways(
  canUseTool: CanUseTool,
  holdable: boolean,
  alwaysAllowed: AlwaysAllowed,
  workdir: string,
): CanUseTool {
  if (!holdable) return canUseTool;
  return async (toolName, input, options) => {
    const result = await canUseTool(toolName, input, options);
    if (result?.behavior !== "allow" || !("updatedPermissions" in result)) return result;
    alwaysAllowed.add(alwaysAllowKey(toolName, input, workdir));
    const { updatedPermissions: _session, ...rest } = result as typeof result & {
      updatedPermissions?: unknown;
    };
    return rest;
  };
}

/**
 * 명령 런의 이름을 그 런의 CLI 명령 목록으로 다시 봐야 하나(에이전트 명령 C4 이중 방어) — 사람 명령·스킬(이름에 `:`)과 허용 내장은
 * checkCommand 가 이미 통과시켰다. 나머지는 스킬 별칭일 때만 넘긴다
 */
export function needsAliasCheck(command: DeliverCommand): boolean {
  const key = command.name.toLowerCase();
  return !key.includes(":") && !CLAUDE_BUILTIN_ALLOWED.has(key);
}

/** 그 이름이 내장이 아닌 줄(사람 스킬)의 별칭인가 — 내장 이름·별칭과 겹치면 CLI 가 내장으로 읽을 수 있어 아니라고 본다 */
export function isSkillAlias(name: string, list: readonly SdkSlashCommand[]): boolean {
  const key = name.toLowerCase();
  const lower = (names: readonly string[] | undefined) => (names ?? []).map((n) => n.toLowerCase());
  if (list.some((c) => c.builtin === true && [c.name.toLowerCase(), ...lower(c.aliases)].includes(key)))
    return false;
  return list.some((c) => c.builtin !== true && lower(c.aliases).includes(key));
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
  alwaysAllowed: AlwaysAllowed,
  botMcp: BotMcp,
): Promise<{ result: TurnResult; process?: SessionProcess }> {
  const { start } = spec;
  const now = ctx.now ?? Date.now;
  const binding = bindingFor(spec, ctx, alwaysAllowed);
  const sessionKey = start.deliver.sessionKey;
  const bg = ctx.background;
  const sp = createSessionProcess({
    sessionKey,
    sessionId: start.providerSessionId,
    workdir: spec.workdir,
    binding,
    ...(bg ? { hooks: bg.hooks } : {}),
    now,
    closeGraceMs: ctx.closeGraceMs ?? ABORT_CLOSE_MS,
    ...(ctx.selfTurnWaitMs === undefined ? {} : { selfTurnWaitMs: ctx.selfTurnWaitMs }),
    ...(ctx.log ? { log: ctx.log } : {}),
  });
  const retryable = (error: unknown) =>
    !resume && isSessionInUseText(error instanceof Error ? error.message : String(error));
  // dodok 도구·승인 콜백은 지금 턴의 런으로 — 제어 호출의 runId 도 지금 런으로 바꿔 싣는다
  const dodokServer = createDodokMcpServer({
    sdk: ctx.sdk,
    post: (input) => sp.bindingRef.current.post(input),
    tools: createControlTools({
      runId: start.deliver.runId,
      call: (call) => {
        const b = sp.bindingRef.current;
        return b.sink.control({ ...call, runId: b.runId });
      },
      runnerControl: hasRunnerControl(spec),
    }),
  });
  const options = buildQueryOptions(spec, {
    baseEnv: ctx.baseEnv,
    ...(ctx.executable === undefined ? {} : { executable: ctx.executable }),
    thinkingDisplay: supportsThinkingDisplay(ctx.cliVersion),
    mcpServer: dodokServer,
    canUseTool: (toolName, input, opts) => sp.bindingRef.current.canUseTool(toolName, input, opts),
    resume,
    plugins,
    alwaysAllowed,
    botMcp,
    live: () => sp.bindingRef.current,
  });
  let q: SdkQuery;
  try {
    q = ctx.sdk.query({ prompt: sp.input(), options });
  } catch (error) {
    if (retryable(error)) return { result: "session-in-use" };
    failedRun(ctx.sink, error);
    return { result: "done" };
  }
  openedOf.set(sp, {
    workdir: spec.workdir,
    configDir: spec.configDir,
    executable: ctx.executable,
    model: spec.model,
    permissionMode: spec.permissionMode,
    effort: spec.effort ?? null,
    append: start.channelRulesAppend,
    allowedTools: sortedKey(options.allowedTools),
    disallowedTools: sortedKey(options.disallowedTools),
    mcpServers: JSON.stringify(botMcp.servers),
    dodokServer,
    plugins,
    costKind: "subscription_estimate",
    last: { spec, ctx },
  });
  if (bg) {
    sp.onSelfTurn((run) => runFollowupTurn(sp, bg, run));
    bg.sessions.set(sessionKey, sp);
    void sp.exited.then(() => {
      if (bg.sessions.get(sessionKey) === sp) bg.sessions.delete(sessionKey);
    });
  }
  sp.attach(q);
  const result = await runTurn(spec, ctx, sp, binding, images, { costDiff: resume, retryable });
  return { result, process: sp };
}

/**
 * 붙든 프로세스에 다음 런을 넣는다. 도는 중에 바꿀 수 있는 설정(모델·권한 모드·effort·봇 MCP 서버)은 턴 전에 바꾸고, 못 바꾸는 것
 * (채널 규칙·허용·막는 도구)은 프로세스를 연 값으로 잇고 그 런에 HELD_SETTINGS_EVENT 를 낸다(D6)
 */
async function runHeldTurn(
  spec: ClaudeRunSpec,
  ctx: RunContext,
  sp: SessionProcess,
  images: { blocks: SdkImageBlock[]; failed: number },
  alwaysAllowed: AlwaysAllowed,
  botMcp: BotMcp,
): Promise<"done" | "aborted" | "retry"> {
  const binding = bindingFor(spec, ctx, alwaysAllowed);
  const fields = await applyRunSettings(spec, ctx, sp, botMcp);
  // 설정을 바꾸는 사이 CLI 가 스스로 턴을 열었으면 그 턴 뒤로 다시 선다
  while (!sp.idleNow()) {
    sp.unreserve();
    if (!(await sp.whenIdle(ctx.signal))) return "aborted";
    if (!sp.reusable()) {
      sp.unreserve();
      return "retry";
    }
  }
  if (ctx.signal.aborted) {
    sp.unreserve();
    return "aborted";
  }
  const opened = openedOf.get(sp);
  if (opened) opened.last = { spec, ctx };
  if (fields.length > 0)
    ctx.sink.event({ type: "CUSTOM", runId: binding.runId, name: HELD_SETTINGS_EVENT, value: { fields } });
  await runTurn(spec, ctx, sp, binding, images, { costDiff: true, retryable: () => false });
  return "done";
}

/**
 * CLI 가 작업 알림 뒤 스스로 연 턴을 서버가 받아 준 추가 응답 런으로 돌린다(스펙 5.3). 프롬프트는 없다 — 턴 사실(훅 문맥)도 붙지
 * 않는다(5.8). 정의·문맥은 이 프로세스에 마지막으로 넣은 런의 것, 보내는 곳은 서버가 준 deliver(처음 응답의 스레드)다
 */
async function runFollowupTurn(
  sp: SessionProcess,
  bg: BackgroundContext,
  run: { runId: string; deliver: RunBinding["deliver"] },
): Promise<void> {
  const opened = openedOf.get(sp);
  if (!opened) return;
  const { spec: lastSpec, ctx: lastCtx } = opened.last;
  const followup = bg.hooks.openFollowup({
    runId: run.runId,
    deliver: run.deliver,
    workdir: lastSpec.workdir,
  });
  try {
    const spec: ClaudeRunSpec = {
      ...lastSpec,
      start: { ...lastSpec.start, deliver: run.deliver, turnFacts: "" },
    };
    const ctx: RunContext = { ...lastCtx, sink: followup.sink, signal: followup.signal };
    const binding = bindingFor(spec, ctx, new Set());
    await runTurn(spec, ctx, sp, binding, NO_IMAGES, {
      costDiff: true,
      retryable: () => false,
      prompt: false,
    });
  } finally {
    followup.close();
  }
}

/** D6 — 바꿀 수 있는 것은 바꾸고, 못 바꾼(또는 바꾸다 실패한) 설정 이름을 돌려준다 */
async function applyRunSettings(
  spec: ClaudeRunSpec,
  ctx: RunContext,
  sp: SessionProcess,
  botMcp: BotMcp,
): Promise<string[]> {
  const opened = openedOf.get(sp);
  if (!opened) return [];
  const q = sp.query();
  const held: string[] = [];
  const tryChange = async (field: string, change: () => Promise<unknown>, commit: () => void) => {
    try {
      await change();
      commit();
    } catch {
      held.push(field);
    }
  };
  if (spec.model !== opened.model)
    await tryChange(
      "model",
      () => q.setModel(spec.model ?? undefined),
      () => (opened.model = spec.model),
    );
  if (spec.permissionMode !== opened.permissionMode)
    await tryChange(
      "permissionMode",
      () => q.setPermissionMode(spec.permissionMode),
      () => (opened.permissionMode = spec.permissionMode),
    );
  const effort = spec.effort ?? null;
  if (effort !== opened.effort)
    await tryChange(
      "effort",
      () => q.applyFlagSettings({ effortLevel: effort }),
      () => (opened.effort = effort),
    );
  const mcpServers = JSON.stringify(botMcp.servers);
  if (mcpServers !== opened.mcpServers)
    await tryChange(
      "mcpServers",
      () => q.setMcpServers({ ...botMcp.servers, dodok: opened.dodokServer } as never),
      () => (opened.mcpServers = mcpServers),
    );
  // 못 바꾸는 것 — 이 런이 새로 열었다면 넣었을 옵션과 견준다
  const would = buildQueryOptions(spec, {
    baseEnv: ctx.baseEnv,
    mcpServer: opened.dodokServer,
    resume: true,
    plugins: opened.plugins,
    botMcp,
  });
  if (spec.start.channelRulesAppend !== opened.append) held.push("channelRulesAppend");
  if (sortedKey(would.allowedTools) !== opened.allowedTools) held.push("allowedTools");
  if (sortedKey(would.disallowedTools) !== opened.disallowedTools) held.push("disallowedTools");
  return held;
}

type TurnResult = "done" | "held" | "session-in-use";

function failedRun(sink: RunSink, error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  const code: ErrorCode = isAuthFailureText(text) ? "PROVIDER_AUTH" : "INTERNAL";
  const head =
    code === "PROVIDER_AUTH" ? `러너의 ${CLAUDE_CODE_LABEL} 로그인을 확인하세요` : "Claude Code 실행 실패";
  // 가림·길이 자르기는 sink 가 한다
  sink.error(code, `${head}: ${text}`);
}

/**
 * 한 런의 턴 — 프롬프트를 넣고 그 턴의 메시지를 이벤트로, result 를 final 로 낸다. 런의 끝은 그 프롬프트의 턴에서 나온 result 다.
 * 작업이 남았으면 프로세스를 붙들고 "held", 아니면 입력을 닫고 프로세스가 끝날 때까지 읽는다
 */
async function runTurn(
  spec: ClaudeRunSpec,
  ctx: RunContext,
  sp: SessionProcess,
  binding: RunBinding,
  images: { blocks: SdkImageBlock[]; failed: number },
  o: {
    /** 비용을 세션 누적값의 차이로 — resume 한 프로세스·붙든 프로세스의 턴 */
    costDiff: boolean;
    retryable: (error: unknown) => boolean;
    /** false — CLI 가 스스로 연 턴(추가 응답)이라 넣을 프롬프트가 없다 */
    prompt?: boolean;
  },
): Promise<TurnResult> {
  const { start } = spec;
  const sessionId = start.providerSessionId;
  const now = ctx.now ?? Date.now;
  const sink = binding.sink;
  const signal = binding.signal;
  const q = sp.query();
  const opened = openedOf.get(sp);
  const mapper = createStreamMapper(now, {
    runId: binding.runId,
    mask: sink.mask,
    command: start.deliver.command !== undefined,
  });
  const turn = sp.turn(binding);

  let interrupted = false;
  const onAbort = () => {
    interrupted = true;
    mapper.markInterrupted(abortStopReason(signal.reason));
    q.interrupt().catch(() => {});
    // 붙들 수 있는 프로세스는 result 가 오면 유예를 거둔다(finishTurn) — interrupt 는 백그라운드 작업을 죽이지 않는다(ADR 5.11)
    sp.closeLater();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  let ended = false;
  let holding = false;
  let sawMessage = false;
  let costKind: RunnerRunFinal["costKind"] = opened?.costKind ?? "subscription_estimate";
  const end = () => {
    ended = true;
    // 작업이 남았으면 붙든다 — 아니면 입력을 닫아 CLI 가 끝나게 하고, 끝나지 않으면 유예 뒤 닫는다
    if (sp.finishTurn()) {
      holding = true;
      turn.done();
    }
  };

  // total_cost_usd 는 세션 누적값이다 — resume 한 프로세스의 첫 result 에 앞 런 비용이 이미 들어 있다(ADR 0007 5.9). 붙든 프로세스의
  // 다음 턴은 같은 프로세스의 직전 누적값과의 차이다
  let costRecorded = false;
  const recordCost = (total: number | undefined): number | undefined => {
    costRecorded = true;
    if (typeof total !== "number") return undefined;
    const prev = ctx.costs.get(sessionId);
    const cost = !o.costDiff ? total : prev === undefined ? undefined : Math.max(0, total - prev);
    // 비정상 종료한 CLI 의 result 는 0 을 실을 수 있다 — 이어 간 세션의 알던 누적값을 0 으로 되돌리지 않는다
    if (total > 0 || !o.costDiff) ctx.costs.set(sessionId, total);
    return cost;
  };

  try {
    // 입력은 런의 끝(프롬프트 턴의 result)까지 열어 둔다 — 닫으면 SDK 가 stdin 을 닫아 권한 콜백·SDK MCP 가 멈춘다.
    // 명령 런의 이름이 사람 명령·허용 내장이 아니면 프롬프트를 내기 전에 이 CLI 의 목록으로 스킬 별칭인지 본다 — 아니면(목록을 못
    // 받아도) 프롬프트 없이 VALIDATION 으로 닫는다. 서버가 같은 판정을 하지만 목록을 모를 때 넘기므로 여기가 마지막 자리다
    const command = start.deliver.command;
    let blocked = false;
    if (o.prompt !== false && command !== undefined && needsAliasCheck(command)) {
      let alias = false;
      try {
        alias = isSkillAlias(command.name, await q.supportedCommands());
      } catch {
        alias = false;
      }
      blocked = !alias;
    }
    if (blocked) {
      sink.error("VALIDATION", COMMAND_BLOCKED_MESSAGE);
      end();
    } else if (o.prompt !== false) {
      sp.send({
        type: "user",
        message: { role: "user", content: promptContent(start, images) },
        parent_tool_use_id: null,
      });
    }
    for await (const m of turn) {
      sawMessage = true;
      if (ended) continue;
      const raw = m as { type?: string; subtype?: string; apiKeySource?: string; total_cost_usd?: number };
      if (raw.type === "system" && raw.subtype === "init" && raw.apiKeySource) {
        costKind = API_KEY_SOURCES.has(raw.apiKeySource) ? "api" : "subscription_estimate";
        if (opened) opened.costKind = costKind;
      }
      for (const item of mapper.map(m)) {
        if (ended) break;
        if (item.event) {
          sink.event(item.event);
        } else if (item.final) {
          const { totalCostUsd, ...rest } = item.final;
          const costUsd = recordCost(totalCostUsd);
          // 세부는 입력을 닫기 전에 묻는다 — 닫으면 CLI 가 끝나 제어 요청에 답하지 않는다. 중지된 턴은 묻지 않는다(작성기 칩 스펙 C7)
          const contextBreakdown = interrupted || signal.aborted ? undefined : await fetchContextBreakdown(q);
          const usage = contextBreakdown === undefined ? rest.usage : { ...rest.usage, contextBreakdown };
          sink.final({
            ...rest,
            ...(usage === undefined ? {} : { usage }),
            ...(costUsd === undefined ? {} : { costUsd }),
            costKind,
          });
          end();
        } else if (item.error) {
          sink.error(item.error.code, item.error.message);
          end();
        }
      }
      // 오류로 끝난 턴도 누적 비용을 싣는다 — 다음 런의 차이가 맞도록 기록만 한다
      if (ended && raw.type === "result" && !costRecorded) recordCost(raw.total_cost_usd);
    }
    if (!ended) {
      if (interrupted) sink.final(abortedFinal(costKind, signal.reason));
      else sink.error("INTERNAL", "Claude Code 가 결과 없이 끝났습니다");
    }
  } catch (error) {
    // 마지막 result 뒤에 CLI 가 exit 1 로 끝나 반복자가 던질 수 있다(ADR 0007 4.4) — 런은 이미 끝났다
    if (!ended) {
      if (interrupted) sink.final(abortedFinal(costKind, signal.reason));
      else if (!sawMessage && o.retryable(error)) return "session-in-use";
      else failedRun(sink, error);
    }
  } finally {
    ended = true;
    signal.removeEventListener("abort", onAbort);
    if (!holding) {
      sp.endInput();
      sp.cancelClose();
      q.close();
    }
  }
  return holding ? "held" : "done";
}

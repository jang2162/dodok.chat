import { z } from "zod";
import { MENTION_TOKEN_RE } from "./mention";

// 에이전트 명령(에이전트 명령 스펙 C2·C4·C10) — 웹과 서버가 같은 함수로 글을 명령으로 알아보고 막는다. 처리는 러너(Claude Code)·
// OpenClaw 가 한다 — dodok 은 알아보기·막기·전달만

/** 명령 이름 — Claude 플러그인 명령의 `plugin:name` 포함. 뒤는 공백이나 글 끝이어야 한다(`/usr/bin` 이 명령이 되지 않게) */
const NAME = "[A-Za-z0-9][A-Za-z0-9:_-]{0,63}";
const MENTION = MENTION_TOKEN_RE.source;
// 칩 뒤 공백은 \s(nbsp 포함). 인자 안의 공백은 그대로 둔다
const MENTION_COMMAND_RE = new RegExp(`^${MENTION}\\s/(${NAME})(?:\\s+([\\s\\S]*))?$`);
const DIRECT_COMMAND_RE = new RegExp(`^/(${NAME})(?:\\s+([\\s\\S]*))?$`);
const MENTION_IN_ARGS_RE = new RegExp(MENTION);

export type ParsedAgentCommand = { agentId: string; name: string; args: string };

/**
 * 글이 정확히 「에이전트 멘션 토큰 하나 + 공백 + `/이름` + (공백 + 인자)」이면 명령이다. `directAgentId`(1:1 에이전트 DM)면 맨 앞
 * `/이름`. 첨부가 있는지는 부르는 쪽이 본다. 맨 앞 `/stop` 은 작성기의 중지라 명령이 아니다. 인자에 멘션 토큰이 있으면 명령이
 * 아니다 — 명령으로 보면 인자 속 에이전트를 조용히 부르지 않게 된다(C2 「멘션 하나」). 평범한 글로 흘러 멘션 모두가 런을 받는다
 */
export function parseAgentCommand(text: string, opts: { directAgentId?: string }): ParsedAgentCommand | null {
  const body = text.trim();
  const m = MENTION_COMMAND_RE.exec(body);
  if (m) {
    if (m[1] !== "a") return null;
    const args = (m[4] ?? "").trimEnd();
    if (MENTION_IN_ARGS_RE.test(args)) return null;
    return { agentId: m[2] as string, name: m[3] as string, args };
  }
  if (!opts.directAgentId) return null;
  const d = DIRECT_COMMAND_RE.exec(body);
  if (!d || d[1] === "stop") return null;
  const args = (d[2] ?? "").trimEnd();
  if (MENTION_IN_ARGS_RE.test(args)) return null;
  return { agentId: opts.directAgentId, name: d[1] as string, args };
}

export type CommandVerdict =
  | { ok: true }
  | { ok: false; reason: "blocked" | "use_chips" | "new_session" | "use_stop"; message: string };

export type CommandProgram = "claude" | "openclaw";

export const COMMAND_BLOCKED_MESSAGE = "이 명령은 dodok 에서 쓸 수 없습니다";
const BLOCKED: CommandVerdict = { ok: false, reason: "blocked", message: COMMAND_BLOCKED_MESSAGE };
const USE_STOP: CommandVerdict = { ok: false, reason: "use_stop", message: "중지는 `/stop` 만 쓰세요" };
const NEW_SESSION: CommandVerdict = { ok: false, reason: "new_session", message: "새 세션을 여세요" };
const USE_CHIPS: CommandVerdict = {
  ok: false,
  reason: "use_chips",
  message: "모델은 작성기 칩에서 바꾸세요",
};

const NESTED: CommandVerdict = {
  ok: false,
  reason: "blocked",
  message: "명령 인자에 다른 `/` 명령을 넣을 수 없습니다",
};

/**
 * 러너(Claude Code)에서 넘기는 내장 명령(C4) — 허용 목록이다. 내장은 판마다 늘고(`/insights`·`/heapdump` 처럼 그 머신의 다른 세션
 * 기록·프로세스 메모리를 건드리는 것도 있다) 목록 밖은 막는다. model·clear 는 안내로 막는다. 사람 명령·스킬(이름에 `:`)과 그 별칭은
 * 넘긴다(C5). 이름은 핀한 CLI 판의 supportedCommands() 실측 — `cost` 는 내장 `usage` 의 별칭이고(`stats` 별칭은 넘기지 않는다),
 * `help` 는 이 판에 없다(재리뷰 N6)
 */
export const CLAUDE_BUILTIN_ALLOWED: ReadonlySet<string> = new Set(["compact", "context", "usage", "cost"]);

/**
 * 별칭 목록을 몰라도 늘 막는 내장 — 로그인·설정과, 그 머신의 다른 세션 기록·프로세스 메모리를 건드리는 것. 허용 목록 밖은 어차피
 * 막히지만 이 이름들은 목록을 모르는 자리(웹·끊긴 러너)에서도 보내기 전에 막는다
 */
const CLAUDE_ALWAYS_BLOCKED: ReadonlySet<string> = new Set([
  "login",
  "logout",
  "config",
  "insights",
  "heapdump",
  "recap",
]);

export type CheckCommandOptions = {
  /**
   * claude 만 — 그 프로젝트의 사람 스킬 별칭(이름에 `:` 이 없는 이름). 주면 이름에 `:` 이 없고 내장 허용 목록에도 없는 이름은 이
   * 안에 있을 때만 넘긴다. 안 주면(목록을 모른다 — 러너가 끊겼거나 웹이 아직 목록을 받지 않았다) 넘기고 러너가 그 런의 명령 목록으로
   * 다시 본다
   */
  skillAliases?: ReadonlySet<string>;
};

/**
 * OpenClaw 허용 목록(C10) — 2026.9.4 `docs/tools/slash-commands.md` 의 명령·지시어 중 호스트·설정·세션을 건드리지 않는 것.
 * 설명은 그 문서의 한 줄을 옮겼다. 스킬은 `/skill <이름>` 으로
 */
export const OPENCLAW_COMMANDS: ReadonlyArray<{ name: string; description: string; argumentHint?: string }> =
  [
    { name: "status", description: "실행·런타임 상태, Gateway 가동 시간, 플러그인 상태, 사용량" },
    { name: "help", description: "짧은 도움말" },
    { name: "commands", description: "명령 목록" },
    { name: "whoami", description: "내 발신자 id" },
    {
      name: "usage",
      description: "답마다 붙는 사용량 표시를 바꾸거나 비용 요약을 본다",
      argumentHint: "off|tokens|full|reset|cost",
    },
    { name: "compact", description: "세션 컨텍스트를 압축한다", argumentHint: "[지시]" },
    { name: "skill", description: "이름으로 스킬을 실행한다", argumentHint: "<이름> [입력]" },
    {
      name: "think",
      description: "생각 수준을 정하거나 세션 설정을 지운다",
      argumentHint: "<level|default>",
    },
    { name: "fast", description: "빠른 모드를 보거나 정한다", argumentHint: "[status|auto|on|off|default]" },
    { name: "verbose", description: "자세한 출력을 켜고 끈다", argumentHint: "on|off|full" },
    { name: "reasoning", description: "추론 보이기를 켜고 끈다", argumentHint: "[on|off|stream]" },
    { name: "queue", description: "실행 중 대기열 동작을 정한다", argumentHint: "<mode>" },
    {
      name: "model",
      description: "이 세션의 모델을 보거나 고른다",
      argumentHint: "[name|default|list|status]",
    },
  ];
const OPENCLAW_ALLOWED: ReadonlySet<string> = new Set(OPENCLAW_COMMANDS.map((c) => c.name));
/** `/model` 의 기본값 쓰기 범위 — 에이전트·전역 설정을 바꾸므로 막는다 */
const OPENCLAW_MODEL_SCOPE_FLAGS: ReadonlySet<string> = new Set(["-g", "--global", "-a", "--agent"]);

/**
 * 명령을 그 프로그램에 넘겨도 되나(C4·C10). 웹(보내기 전)·서버(런 전)·러너·플러그인(이중 방어)이 같이 쓴다.
 * OpenClaw 는 텍스트 명령 본문 어디서든 지시어(`/think`·`/elevated`·`/exec`·`/model` …)를 뽑아 세션에 저장하므로, 인자에 줄바꿈이나
 * `/` 로 시작하는 토큰이 하나라도 있으면 막는다(`/skill` 도 — 그 입력 글도 같은 본문이다)
 */
export function checkCommand(
  program: CommandProgram,
  name: string,
  args: string,
  opts: CheckCommandOptions = {},
): CommandVerdict {
  const key = name.toLowerCase();
  if (key === "stop") return USE_STOP;
  if (program === "claude") {
    if (key === "model") return USE_CHIPS;
    if (key === "clear") return NEW_SESSION;
    if (CLAUDE_ALWAYS_BLOCKED.has(key)) return BLOCKED;
    if (key.includes(":") || CLAUDE_BUILTIN_ALLOWED.has(key)) return { ok: true };
    if (opts.skillAliases === undefined) return { ok: true };
    const aliases = new Set([...opts.skillAliases].map((a) => a.toLowerCase()));
    return aliases.has(key) ? { ok: true } : BLOCKED;
  }
  if (key === "new" || key === "reset") return NEW_SESSION;
  if (!OPENCLAW_ALLOWED.has(key)) return BLOCKED;
  if (/[\r\n]/.test(args) || /(?:^|\s)\//.test(args)) return NESTED;
  if (key === "model" && args.split(/\s+/).some((t) => OPENCLAW_MODEL_SCOPE_FLAGS.has(t.toLowerCase()))) {
    return BLOCKED;
  }
  return { ok: true };
}

/** 에이전트 명령 한 줄 — 러너 commands.list·OpenClaw 고정 목록. 자동완성 도움말이고, claude 는 별칭이 스킬 별칭 판정에 쓰인다 */
export const AgentCommand = z.object({
  name: z.string().max(64),
  description: z.string().max(200),
  argumentHint: z.string().max(200).optional(),
  aliases: z.array(z.string().max(64)).max(8).optional(),
});
export type AgentCommand = z.infer<typeof AgentCommand>;

export const AGENT_COMMANDS_MAX = 200;

/** 런 시작에 싣는 명령(InboundDeliver.command) — 러너·플러그인은 머리말 없이 `/<name>[ <args>]` 만 보낸다 */
export const DeliverCommand = z.object({
  name: z.string().regex(new RegExp(`^${NAME}$`)),
  args: z.string().max(4000),
});
export type DeliverCommand = z.infer<typeof DeliverCommand>;

/**
 * 명령 목록에서 사람 스킬 별칭(checkCommand 의 skillAliases) — 이름에 `:` 이 있는 줄(사람 명령·스킬)의 별칭만. 내장의 별칭은 넣지
 * 않는다(러너가 내장 목록에서 뺀 이름을 별칭으로 되살리지 않게)
 */
export function skillAliasesOf(commands: readonly AgentCommand[]): Set<string> {
  return new Set(commands.filter((c) => c.name.includes(":")).flatMap((c) => c.aliases ?? []));
}

/** 명령 런이 넘길 글 — 러너 프롬프트·플러그인 본문 */
export function formatCommandText(command: DeliverCommand): string {
  return command.args ? `/${command.name} ${command.args}` : `/${command.name}`;
}

/**
 * 대화의 에이전트별 명령 목록(GET …/agent-commands). supported false 면 옛 판이거나 끊겼다 — 목록은 비어 있다. listFailed 면 지원은
 * 하는데 이번에 목록을 받지 못했다(일시 실패·루트 없음) — 목록은 비어 있고, 부르는 쪽은 스킬 별칭을 「모른다」로 본다(재리뷰 N3)
 */
export const AgentCommandsResponse = z.object({
  agents: z.array(
    z.object({
      agentId: z.string(),
      commands: z.array(AgentCommand).max(AGENT_COMMANDS_MAX),
      supported: z.boolean(),
      listFailed: z.boolean().optional(),
    }),
  ),
});
export type AgentCommandsResponse = z.infer<typeof AgentCommandsResponse>;

/** 옛 러너·플러그인(능력 commands 없음)의 시스템 줄(C7) */
export const COMMANDS_UNSUPPORTED_MESSAGE =
  "이 에이전트는 명령을 지원하지 않습니다 — 러너·플러그인을 업데이트하세요";

/** 답 글이 없는 명령 런을 닫는 한 줄(C13) */
export function commandDoneText(name: string): string {
  return `\`/${name}\` 완료`;
}

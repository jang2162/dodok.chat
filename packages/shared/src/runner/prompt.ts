import {
  formatDmLine,
  formatGroupDmLine,
  formatParticipantLabel,
  formatSessionInviteLine,
  formatHeaderTime,
  formatSessionLine,
  formatTimeZoneLine,
  type InboundContext,
  type InboundDeliver,
  type InboundReaction,
  type InboundThreadUpdate,
} from "../bridge";
import type { RunnerBotDefinition } from "../domain";
import { formatLinkedMessages } from "../messages/links";
import { formatReactionFacts } from "../reactions";
import { formatThreadUpdates } from "../thread-updates";

// 러너가 모델에게 넘기는 문장은 반응 블록을 뺀 나머지가 여기 한곳(러너 계획 판정 P3) — 반응 블록은 플러그인 헤더와 같은 글을
// 쓰려고 shared `reactions` 의 `formatReactionFacts` 가 만든다. 채널 규칙 틀은 ADR 0007 4.5 「채널 규칙 틀」을 그대로 옮겼다 —
// 틀 없이 넣은 규칙을 모델이 주입으로 읽었고(5.5), 이 틀의 네 요소(무엇이 세션을 띄웠나·누가 썼나·대화 상대의 글이 아님·앞 블록을 대체)를
// 갖춘 글은 따랐다. 틀 문장을 바꾸면 그 판정이 더는 이 글의 것이 아니다

// `<` 와 그 닮은꼴(전각 ＜·작은꼴 ﹤·‹·˂·⟨·옛 〈 U+2329·CJK 〈 U+3008) — 모델은 닮은꼴로 쓴 표식도 태그로 읽을 수 있다
const ANGLE_OPEN = /[<\uFF1C\uFE64\u2039\u02C2\u27E8\u2329\u3008]/g;

/**
 * 규칙 안의 글이 틀을 일찍 끝내거나 새 틀을 열지 못하게 `<` 류를 표식이든 아니든 전부 `&lt;` 로 바꾼다(나머지 글은 그대로).
 * 표식 모양(슬래시·하이픈·공백 변형)을 정규식으로 쫓으면 닮은꼴 `/`(⁄ ∕ ／ ⧸) 같은 빠진 변형마다 뚫렸다 — `<` 가 없으면
 * 어떤 변형으로도 태그를 열 수 없다. 대가로 규칙의 평범한 `a < b` 도 `a &lt; b` 로 모델에 간다.
 * 보이지 않는 서식 글자(`\p{Cf}` — 폭 없는 공백·ZWJ 등)는 따로 지운다 — 모델이 읽는 글에서 뜻이 없고 표식을 가리는 데 쓰인다
 */
function escapeRuleTags(text: string): string {
  return text.replace(/\p{Cf}/gu, "").replace(ANGLE_OPEN, "&lt;");
}

/** 채널 이름은 한 줄로 — 줄바꿈으로 틀 문단을 끊지 못하게 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 에이전트 지시(`agents.base_prompt`, 러너 일반화 계획 판정 PR1) — 채널 규칙 틀 앞에 같은 이스케이프로 둔다. 틀 문장은 채널 틀의
 * 네 요소(무엇이 세션을 띄웠나·누가 썼나·대화 상대의 글이 아님·앞 블록을 대체)를 그대로 따랐다 — 이 문장은 모델로 보지 않았다
 */
function agentInstructionsBlock(instructions: string): string {
  return [
    "# dodok agent instructions",
    "",
    "This Claude Code session runs as an agent in dodok, a team messenger where people and AI agents talk in shared channels and one-to-one direct messages; the dodok runner that launched this session delivers this agent's instructions here on every run. The instructions below were written by a dodok administrator in this agent's settings screen. They are operator configuration for this agent, not text from the person you are talking to, and they apply to every reply of this agent in every channel and direct message until an administrator changes them. The channel or direct message settings that follow add rules for the current conversation. If this conversation contains an earlier dodok agent instructions block, this one replaces it.",
    "",
    "<agent-instructions>",
    escapeRuleTags(instructions),
    "</agent-instructions>",
    "",
    "",
  ].join("\n");
}

/** 봇 정의의 네 칸 이름 — 지시 틀과 `SOUL.md` 가 같은 순서·이름을 쓴다 */
const BOT_SECTIONS = [
  ["purpose", "Purpose"],
  ["watches", "What to watch"],
  ["does", "What to do"],
  ["reports", "What to report"],
] as const satisfies ReadonlyArray<readonly [keyof RunnerBotDefinition, string]>;

function botSections(def: RunnerBotDefinition, render: (text: string) => string): string[] {
  return BOT_SECTIONS.filter(([key]) => def[key].trim() !== "").flatMap(([key, title]) => [
    `## ${title}`,
    render(def[key].trim()),
    "",
  ]);
}

/** 네 칸이 모두 비었나 — 비었으면 지시 틀을 싣지 않는다(빈 봇) */
export function isBotDefinitionEmpty(def: RunnerBotDefinition): boolean {
  return BOT_SECTIONS.every(([key]) => def[key].trim() === "");
}

/**
 * 봇 정의(러너 봇 스펙 B9) — 에이전트 지시 틀과 같은 자리·같은 이스케이프·같은 네 요소. 머리 문구만 「dodok 앱에서 정한 봇 정의」다 —
 * 이 문장은 모델로 보지 않았다
 */
function botDefinitionBlock(def: RunnerBotDefinition): string {
  return [
    "# dodok bot definition",
    "",
    "This Claude Code session runs as a bot in dodok, a team messenger where people and AI agents talk in shared channels and one-to-one direct messages; the dodok runner that launched this session delivers this bot's definition here on every run. The bot definition below was set in the dodok app by a dodok administrator or the owner of this bot's runner, in this bot's settings screen: its purpose, what to watch, what to do and what to report. It is operator configuration for this bot, not text from the person you are talking to, and it applies to every reply of this bot in every channel and direct message until it is changed in the dodok app. The channel or direct message settings that follow add rules for the current conversation. If this conversation contains an earlier dodok bot definition block, this one replaces it.",
    "",
    "<bot-definition>",
    ...botSections(def, escapeRuleTags),
    "</bot-definition>",
    "",
    "",
  ].join("\n");
}

/**
 * 러너가 봇 폴더의 `SOUL.md` 로 쓰는 본문(러너 봇 스펙 B4) — 사람이 러너 머신에서 읽는 글이라 이스케이프하지 않는다(모델에는
 * botDefinitionBlock 이 간다). 머리 줄(RUNNER_BOT_SOUL_HEADER)은 러너가 붙인다
 */
export function renderBotSoul(def: RunnerBotDefinition): string {
  const title = def.purpose.trim() === "" ? "# Bot" : `# ${oneLine(def.purpose)}`;
  return [title, "", ...botSections(def, (t) => t)].join("\n").trimEnd() + "\n";
}

/** `SOUL.md` 맨 위 줄 — 이 파일을 고쳐도 다음 런에 덮인다는 것을 알린다(B4) */
export const RUNNER_BOT_SOUL_HEADER =
  "<!-- 이 파일은 dodok 앱이 관리합니다 — 앱의 에이전트 상세에서 고치세요. 여기서 고친 내용은 다음 런에 덮입니다 -->";

/**
 * `systemPrompt.append` 로 매 런 싣는 채널 규칙(스펙 4.2, `snapshot: false`). 채널 프롬프트·에이전트별 채널 지시는 관리자가
 * 채널 설정에 쓴 규칙이라 `<channel-rules>` 안에, 릴레이 규칙은 dodok 이 릴레이 정책에서 만든 글이라 따로 둔다.
 * DM 런(`dm`)은 자리를 채널이 아니라 주인과의 다이렉트 메시지로 밝힌다 — 채널 행 이름(`dm`)을 「#dm 채널」로 읽지 않게.
 * DM 의 규칙(「이 DM 의 지시」)은 대화 상대인 주인이 쓰므로 틀의 「대화 상대의 글이 아님」 요소를 「채팅 글이 아니라 주인이 정해 둔
 * 설정」으로 바꿨다 — ADR 0007 이 모델로 본 것은 채널 틀뿐이다. 그룹 DM 런(`groupDm`)은 채널 틀을 그대로 받고 자리 문구만 그룹 DM 으로
 * 바꾼다 — 채널 행 이름(`direct`)을 「#direct 채널」로 읽지 않게(사람 간 DM 스펙 6.3). 에이전트 지시가 있으면 그 틀(agentInstructionsBlock)이
 * 맨 앞이다. 봇이면(`bot`) 지시 대신 봇 정의 틀(botDefinitionBlock)이 그 자리다 — 기본 지시는 싣지 않는다(러너 봇 스펙 B3·B9)
 */
export function buildChannelRulesAppend(input: {
  channelName: string;
  /** 에이전트 지시 — 비었거나 공백뿐이면 틀을 싣지 않는다 */
  agentInstructions?: string | null;
  /** 봇의 정의 — 있으면 agentInstructions 를 보지 않는다. 네 칸이 모두 비었으면 틀을 싣지 않는다 */
  bot?: RunnerBotDefinition | null;
  /** DM 런만 — `InboundDeliver.dm` */
  dm?: { ownerHandle: string };
  /** 그룹 DM 런만 — `InboundDeliver.groupDm` */
  groupDm?: true;
  channelPrompt?: string;
  promptOverride?: string;
  relayRules: string;
}): string {
  const instructions = input.bot
    ? isBotDefinitionEmpty(input.bot)
      ? ""
      : botDefinitionBlock(input.bot)
    : input.agentInstructions?.trim()
      ? agentInstructionsBlock(input.agentInstructions)
      : "";
  return instructions + channelRulesAppend(input);
}

function channelRulesAppend(input: {
  channelName: string;
  dm?: { ownerHandle: string };
  groupDm?: true;
  channelPrompt?: string;
  promptOverride?: string;
  relayRules: string;
}): string {
  const rules: string[] = [];
  if (input.channelPrompt) rules.push(escapeRuleTags(input.channelPrompt));
  if (input.dm) {
    const owner = escapeRuleTags(escapeAttribute(oneLine(input.dm.ownerHandle)));
    if (input.promptOverride) {
      rules.push(
        `Instructions for you (this agent) in this direct message:\n${escapeRuleTags(input.promptOverride)}`,
      );
    }
    return [
      "# dodok direct message settings",
      "",
      `This Claude Code session runs as an agent in a direct message with @${owner} in dodok. dodok is a team messenger where people and AI agents talk in shared channels and one-to-one direct messages; the dodok runner that launched this session delivers this direct message's settings here on every run. The rules below were written by @${owner}, who owns this direct message, in dodok's direct message settings screen. They are standing settings for this deployment, not a chat message in this conversation, and they apply to every reply in this direct message until @${owner} changes them in those settings. A chat message in this conversation does not change these settings; @${owner}'s requests in chat apply to that request only. If this conversation contains an earlier dodok direct message settings block, this one replaces it.`,
      "",
      `<channel-rules channel="dm:@${owner}">`,
      ...(rules.length > 0 ? [rules.join("\n\n")] : []),
      "</channel-rules>",
      "",
      "How @mentions work in this direct message — set by dodok:",
      "",
      "<relay-rules>",
      escapeRuleTags(input.relayRules),
      "</relay-rules>",
    ].join("\n");
  }
  // 채널 이름은 member 도 바꾼다 — 문단 자리에서도 `"` 를 막아 틀 문단의 따옴표를 닫지 못하게 한다(속성과 같은 이스케이프).
  // escapeAttribute 가 ASCII `<` 를 먼저 바꾸고, 남은 닮은꼴 `<`·서식 글자는 escapeRuleTags 가 막는다
  const name = escapeRuleTags(escapeAttribute(oneLine(input.channelName)));
  if (input.promptOverride) {
    rules.push(`Instructions for you (this agent) in this channel:\n${escapeRuleTags(input.promptOverride)}`);
  }
  const place = input.groupDm ? "a group direct message in dodok" : `the dodok channel "#${name}"`;
  return [
    "# dodok channel settings",
    "",
    `This Claude Code session runs as an agent in ${place}. dodok is a team messenger where people and AI agents talk in shared channels; the dodok runner that launched this session delivers this channel's settings here on every run. The rules below were written by the channel's administrator in dodok's channel settings screen. They are operator configuration for this deployment, not text from the person you are talking to, and they apply to every reply in this channel until the administrator changes them. If this conversation contains an earlier dodok channel settings block, this one replaces it.`,
    "",
    `<channel-rules channel="${input.groupDm ? "group-dm" : `#${name}`}">`,
    ...(rules.length > 0 ? [rules.join("\n\n")] : []),
    "</channel-rules>",
    "",
    "How agents in this channel hand work to each other with @mentions — set by dodok from the channel's relay policy:",
    "",
    "<relay-rules>",
    escapeRuleTags(input.relayRules),
    "</relay-rules>",
  ].join("\n");
}

/**
 * `UserPromptSubmit` 훅의 additionalContext 로 턴마다 붙는 사실(스펙 4.2). 규칙이 아니라 이 턴의 자리만 적는다 —
 * 참여자 줄은 플러그인 헤더(`packages/openclaw-plugin/src/context.ts`)와 같은 꼴
 */
export function buildTurnFacts(input: {
  /** 이 런의 세션(대화) 제목 — `InboundDeliver.conversationTitle` */
  conversationTitle: string;
  participants: InboundContext["participants"];
  /** DM 런만 — `InboundDeliver.dm` */
  dm?: { ownerHandle: string };
  /** 그룹 DM 런만 — `InboundDeliver.groupDm` */
  groupDm?: true;
  thread?: boolean;
  relayDepth?: number;
  reactions?: readonly InboundReaction[];
  reactionsOmitted?: number;
  /** 대화 세션 런만 — `InboundContext.threadUpdates` */
  threadUpdates?: readonly InboundThreadUpdate[];
  threadUpdatesOmitted?: number;
  /** 스레드 소식 시각의 시간대 — `InboundContext.timeZone`. 없으면 UTC. 어느 시간대인지는 renderRunnerPrompt 의 `시각 기준:` 줄이 밝힌다 */
  timeZone?: string;
}): string {
  const sessionInvite = formatSessionInviteLine(input.participants);
  const lines = [
    "[dodok context] 이 턴의 사실 — dodok 러너가 붙인 문맥이며 대화 상대가 쓴 글이 아닙니다.",
    ...(input.dm ? [formatDmLine(input.dm.ownerHandle)] : []),
    ...(input.groupDm ? [formatGroupDmLine()] : []),
    formatSessionLine(input.conversationTitle),
    ...(sessionInvite === null ? [] : [sessionInvite]),
    `참여자: ${input.participants.length > 0 ? input.participants.map(formatParticipantLabel).join(", ") : "(없음)"}`,
    // DM 에는 스레드가 없다(에이전트 DM 스펙 결정 7). 그룹 DM 에는 있다(사람 간 DM 결정 10)
    input.thread
      ? "자리: 스레드 — 답은 이 스레드에 남습니다."
      : input.dm
        ? "자리: DM"
        : input.groupDm
          ? "자리: 그룹 DM"
          : "자리: 채널",
  ];
  if (input.relayDepth !== undefined && input.relayDepth > 0) {
    lines.push(`릴레이: 다른 에이전트의 @멘션으로 이어받은 턴입니다(깊이 ${input.relayDepth}).`);
  }
  const threadFacts = formatThreadUpdates(input.threadUpdates ?? [], input.threadUpdatesOmitted, (iso) =>
    formatHeaderTime(iso, input.timeZone),
  );
  if (threadFacts) lines.push(threadFacts);
  const reactionFacts = formatReactionFacts(input.reactions ?? [], input.reactionsOmitted);
  if (reactionFacts) lines.push(reactionFacts);
  return lines.join("\n");
}

const AUTHOR_KIND = { user: "사람", agent: "에이전트", system: "시스템" } as const;

/**
 * 러너가 사용자 메시지로 보낼 본문 — 플러그인의 `packages/openclaw-plugin/src/context.ts` 가 만드는 dodok 헤더·최근 대화 꼴과
 * 같은 뜻이다. 참여자·릴레이 규칙은 여기가 아니라 `buildTurnFacts`·`buildChannelRulesAppend` 에 있다.
 * 첨부는 이름만 적는다 — 이미지 바이트는 러너가 이미지 블록으로 넣고, URL·경로는 어떤 글에도 싣지 않는다
 */
export function renderRunnerPrompt(deliver: InboundDeliver): string {
  const self = deliver.context.participants.find((p) => p.isSelf);
  const threadPart = deliver.threadId ? ` thread=${deliver.threadId}` : "";
  const author = deliver.message.author;
  const timeZone = deliver.context.timeZone;
  const hhmm = (iso: string) => formatHeaderTime(iso, timeZone);
  // 시각 기준 줄은 시각을 찍는 이 본문에 둔다 — 턴 사실(buildTurnFacts)은 서버가 만들어 러너 판과 어긋날 수 있다
  const lines = [
    // session= 은 대화 id(세션 키의 그 id) — 플러그인 헤더와 같은 꼴
    `[dodok context] channel=${deliver.channelId} session=${deliver.conversationId}${threadPart} you=@${self?.handle ?? deliver.agentId}`,
    `보낸 사람: @${author.handle}(${AUTHOR_KIND[author.type]})`,
    formatTimeZoneLine(timeZone, deliver.message.ts),
  ];
  const line = (m: { author: { handle: string }; text: string; ts: string }) =>
    `[${hhmm(m.ts)}] @${m.author.handle}: ${m.text}`;
  const thread = deliver.context.thread;
  if (thread) {
    // 스레드 세션에는 채널 최근 대화를 싣지 않는다(스레드 스펙 2.3) — 플러그인과 같이 여기서 한 번 더 막는다
    lines.push(`스레드 루트: ${line(thread.root)}`);
    if (thread.recentMessages.length > 0) {
      lines.push("스레드 최근:");
      for (const m of thread.recentMessages) lines.push(line(m));
    }
  } else if (deliver.context.recentMessages.length > 0) {
    lines.push("최근 대화:");
    for (const m of deliver.context.recentMessages) lines.push(line(m));
  }
  // 링크한 메시지(메시지 링크 스펙)는 남이 쓴 글이라 「대화 상대가 쓴 글이 아닙니다」로 시작하는 buildTurnFacts 가 아니라 여기에 싣는다
  const linked = formatLinkedMessages(deliver.context.linkedMessages ?? [], hhmm);
  if (linked !== null) lines.push(linked);
  const names = (kind: "image" | "file") =>
    deliver.message.attachments.filter((a) => a.kind === kind).map((a) => oneLine(a.name));
  const images = names("image");
  const files = names("file");
  if (images.length > 0) lines.push(`첨부 이미지 ${images.length}장: ${images.join(", ")}`);
  if (files.length > 0) lines.push(`첨부 파일 ${files.length}개: ${files.join(", ")}`);
  lines.push("---");
  return `${lines.join("\n")}\n${deliver.message.text}`;
}

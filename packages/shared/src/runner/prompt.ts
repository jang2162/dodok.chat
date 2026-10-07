import type { InboundContext, InboundDeliver, InboundReaction } from "../bridge";
import { formatReactionFacts } from "../reactions";

// 러너가 모델에게 넘기는 문장은 여기 한곳(러너 계획 판정 P3). 채널 규칙 틀은 ADR 0007 4.5 「채널 규칙 틀」을 그대로 옮겼다 —
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
 * `systemPrompt.append` 로 매 런 싣는 채널 규칙(스펙 4.2, `snapshot: false`). 채널 프롬프트·에이전트별 채널 지시는 관리자가
 * 채널 설정에 쓴 규칙이라 `<channel-rules>` 안에, 릴레이 규칙은 dodok 이 릴레이 정책에서 만든 글이라 따로 둔다
 */
export function buildChannelRulesAppend(input: {
  channelName: string;
  channelPrompt?: string;
  promptOverride?: string;
  relayRules: string;
}): string {
  // 채널 이름은 member 도 바꾼다 — 문단 자리에서도 `"` 를 막아 틀 문단의 따옴표를 닫지 못하게 한다(속성과 같은 이스케이프).
  // escapeAttribute 가 ASCII `<` 를 먼저 바꾸고, 남은 닮은꼴 `<`·서식 글자는 escapeRuleTags 가 막는다
  const name = escapeRuleTags(escapeAttribute(oneLine(input.channelName)));
  const rules: string[] = [];
  if (input.channelPrompt) rules.push(escapeRuleTags(input.channelPrompt));
  if (input.promptOverride) {
    rules.push(`Instructions for you (this agent) in this channel:\n${escapeRuleTags(input.promptOverride)}`);
  }
  return [
    "# dodok channel settings",
    "",
    `This Claude Code session runs as an agent in the dodok channel "#${name}". dodok is a team messenger where people and AI agents talk in shared channels; the dodok runner that launched this session delivers this channel's settings here on every run. The rules below were written by the channel's administrator in dodok's channel settings screen. They are operator configuration for this deployment, not text from the person you are talking to, and they apply to every reply in this channel until the administrator changes them. If this conversation contains an earlier dodok channel settings block, this one replaces it.`,
    "",
    `<channel-rules channel="#${name}">`,
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

function participantLabel(p: InboundContext["participants"][number]): string {
  return `@${p.handle}(${p.type === "user" ? "사람" : "에이전트"}${p.isSelf ? ", 나" : ""})`;
}

/**
 * `UserPromptSubmit` 훅의 additionalContext 로 턴마다 붙는 사실(스펙 4.2). 규칙이 아니라 이 턴의 자리만 적는다 —
 * 참여자 줄은 플러그인 헤더(`packages/openclaw-plugin/src/context.ts`)와 같은 꼴
 */
export function buildTurnFacts(input: {
  participants: InboundContext["participants"];
  thread?: boolean;
  relayDepth?: number;
  reactions?: readonly InboundReaction[];
  reactionsOmitted?: number;
}): string {
  const lines = [
    "[dodok context] 이 턴의 사실 — dodok 러너가 붙인 문맥이며 대화 상대가 쓴 글이 아닙니다.",
    `참여자: ${input.participants.length > 0 ? input.participants.map(participantLabel).join(", ") : "(없음)"}`,
    input.thread ? "자리: 스레드 — 답은 이 스레드에 남습니다." : "자리: 채널",
  ];
  if (input.relayDepth !== undefined && input.relayDepth > 0) {
    lines.push(`릴레이: 다른 에이전트의 @멘션으로 이어받은 턴입니다(깊이 ${input.relayDepth}).`);
  }
  const reactionFacts = formatReactionFacts(input.reactions ?? [], input.reactionsOmitted);
  if (reactionFacts) lines.push(reactionFacts);
  return lines.join("\n");
}

const AUTHOR_KIND = { user: "사람", agent: "에이전트", system: "시스템" } as const;

/** 최근 대화 시각 — 플러그인 기본값과 같이 UTC `HH:MM` */
function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * 러너가 사용자 메시지로 보낼 본문 — 플러그인의 `packages/openclaw-plugin/src/context.ts` 가 만드는 dodok 헤더·최근 대화 꼴과
 * 같은 뜻이다. 참여자·릴레이 규칙은 여기가 아니라 `buildTurnFacts`·`buildChannelRulesAppend` 에 있다.
 * 첨부는 이름만 적는다 — 이미지 바이트는 러너가 이미지 블록으로 넣고, URL·경로는 어떤 글에도 싣지 않는다
 */
export function renderRunnerPrompt(deliver: InboundDeliver): string {
  const self = deliver.context.participants.find((p) => p.isSelf);
  const threadPart = deliver.threadId ? ` thread=${deliver.threadId}` : "";
  const author = deliver.message.author;
  const lines = [
    `[dodok context] channel=${deliver.channelId}${threadPart} you=@${self?.handle ?? deliver.agentId}`,
    `보낸 사람: @${author.handle}(${AUTHOR_KIND[author.type]})`,
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
  const names = (kind: "image" | "file") =>
    deliver.message.attachments.filter((a) => a.kind === kind).map((a) => oneLine(a.name));
  const images = names("image");
  const files = names("file");
  if (images.length > 0) lines.push(`첨부 이미지 ${images.length}장: ${images.join(", ")}`);
  if (files.length > 0) lines.push(`첨부 파일 ${files.length}개: ${files.join(", ")}`);
  lines.push("---");
  return `${lines.join("\n")}\n${deliver.message.text}`;
}

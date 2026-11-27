import type { LinkedMessage } from "../bridge";
import { foldHeaderText, LINKED_MESSAGES_MAX } from "../bridge";

/** 한 글에서 찾는 메시지 링크 수의 상한 — 서버가 펼치는 수(InboundContext.linkedMessages)와 웹 카드 수가 같다 */
export const MESSAGE_LINKS_MAX = LINKED_MESSAGES_MAX;

/**
 * 메시지를 여는 주소의 경로+쿼리(오리진 없음) — 웹이 `window.location.origin` 을 앞에 붙인다. 채널·DM·그룹 DM 모두 세션 화면 주소에
 * `?m=` 을 붙이고, 스레드 답글이면 스레드 주소에 붙인다(메시지 링크 스펙 「주소」)
 */
export function messageLinkPath(p: {
  channelId: string;
  conversationId: string;
  messageId: string;
  threadRootId?: string;
}): string {
  const thread = p.threadRootId ? `/t/${p.threadRootId}` : "";
  return `/c/${p.channelId}/s/${p.conversationId}${thread}?m=${p.messageId}`;
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
// 쿼리는 공백·괄호·꺾쇠·따옴표에서 끊는다 — 마크다운 링크 `[글](url)` 의 닫는 괄호가 주소에 붙지 않게
const LINK_TAIL = new RegExp(`^/c/${UUID}/s/${UUID}(?:/t/${UUID})?/?\\?([^\\s<>()\\[\\]"'\`]*)`);
// m 값은 id 꼴 앞부분만 본다 — 문장 끝 구두점(`…?m=<id>.`)이 붙어도 그 앞에서 끝난다
const M_PARAM = new RegExp(`^m=(${UUID})(?![0-9a-zA-Z])`);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 본문에서 같은 오리진의 메시지 링크를 찾아 메시지 id(소문자)를 나온 순서대로, 같은 id 는 한 번, 최대 MESSAGE_LINKS_MAX 개 돌려준다.
 * 다른 오리진은 보통 링크다. 쿼리에서 `m` 의 자리는 상관없다(`?x=1&m=…`)
 */
export function findMessageLinks(text: string, origin: string): string[] {
  const base = origin.replace(/\/+$/, "");
  if (base === "") return [];
  const found: string[] = [];
  const starts = new RegExp(escapeRegExp(base), "gi");
  for (const hit of text.matchAll(starts)) {
    const tail = LINK_TAIL.exec(text.slice(hit.index + hit[0].length));
    if (!tail) continue;
    for (const param of (tail[1] ?? "").split("&")) {
      const m = M_PARAM.exec(param);
      if (!m) continue;
      const id = m[1]!.toLowerCase();
      if (!found.includes(id)) found.push(id);
      break;
    }
    if (found.length >= MESSAGE_LINKS_MAX) break;
  }
  return found;
}

// 대화 주소 — 세션(`/c/<채널>/s/<대화>`)·스레드·메시지 링크 모두. 대화 id 뒤에 id 글자가 이어지면 다른 주소다
const CONVERSATION_TAIL = new RegExp(`^/c/${UUID}/s/(${UUID})(?![0-9a-zA-Z-])`);

/**
 * 본문에서 같은 오리진의 대화 주소(세션·스레드·메시지 링크)를 찾아 대화 id(소문자)를 나온 순서대로, 같은 id 는 한 번, 최대
 * MESSAGE_LINKS_MAX 개 돌려준다. 사람이 그 런의 트리거 글에 붙인 DM 대화를 그 런에서만 읽게 하는 판정(서버 auth/channel-access.ts
 * linkedConversationIds)이 쓴다
 */
export function findConversationLinks(text: string, origin: string): string[] {
  const base = origin.replace(/\/+$/, "");
  if (base === "") return [];
  const found: string[] = [];
  const starts = new RegExp(escapeRegExp(base), "gi");
  for (const hit of text.matchAll(starts)) {
    const tail = CONVERSATION_TAIL.exec(text.slice(hit.index + hit[0].length));
    if (!tail) continue;
    const id = tail[1]!.toLowerCase();
    if (!found.includes(id)) found.push(id);
    if (found.length >= MESSAGE_LINKS_MAX) break;
  }
  return found;
}

const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

/**
 * 링크한 메시지를 에이전트가 읽는 글 — 플러그인 헤더(`formatInboundContext`)와 러너 사용자 메시지(`renderRunnerPrompt`)가 같이 쓴다.
 * 본문 둘째 줄부터 두 칸 들여쓴다 — 남이 쓴 글의 `---`·`참여자:` 줄이 줄 머리에 와 헤더의 끝이나 서버가 붙인 사실처럼 읽히지 않게.
 * 머리 줄의 이름·제목은 한 줄로 접는다. 빈 목록이면 null
 */
export function formatLinkedMessages(
  list: readonly LinkedMessage[],
  hhmm: (iso: string) => string,
): string | null {
  if (list.length === 0) return null;
  const lines: string[] = [];
  list.forEach((m, i) => {
    const title = foldHeaderText(m.conversationTitle);
    const where = [
      `#${foldHeaderText(m.channelName)}`,
      `세션 「${title === "" ? "새 세션" : title}」`,
      ...(m.threadRootId ? ["스레드"] : []),
    ].join(" · ");
    const [first = "", ...rest] = m.text.split(LINE_BREAK);
    lines.push(`링크한 메시지 ${i + 1}:`);
    lines.push(`[${hhmm(m.ts)}] @${foldHeaderText(m.author.handle)} (${where}): ${first}`.trimEnd());
    for (const line of rest) lines.push(line.trim() === "" ? "" : `  ${line}`);
    if (m.root)
      lines.push(`  스레드 루트: @${foldHeaderText(m.root.author.handle)}: ${foldHeaderText(m.root.text)}`);
    if (m.attachments.length > 0) lines.push(`  첨부: ${m.attachments.map(foldHeaderText).join(", ")}`);
  });
  return lines.join("\n");
}

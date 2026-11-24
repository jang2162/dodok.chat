import type { InboundThreadUpdate } from "../bridge";

/** 줄바꿈으로 헤더 줄을 지어내지 못하게 한 줄로 접는다 */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/**
 * 대화 세션의 에이전트가 지난 턴 뒤 그 대화의 스레드들에 새로 달린 답글을 읽는 글. 플러그인 헤더와 러너 턴 사실이 같은 함수를
 * 써서 두 어댑터의 문구가 갈라지지 않는다. 시각 꼴은 부르는 쪽의 「최근 대화」와 같게 hhmm 으로 받는다. 비면 "".
 */
export function formatThreadUpdates(
  updates: readonly InboundThreadUpdate[],
  omitted: number | undefined,
  hhmm: (iso: string) => string,
): string {
  if (updates.length === 0) return "";
  const lines = ["스레드 소식(지난 턴 뒤 이 세션의 스레드에 새로 달린 답글):"];
  for (const u of updates) {
    lines.push(`- 「${oneLine(u.rootExcerpt)}」 새 답글 ${u.newReplies}(최근 ${u.recent.length}):`);
    for (const m of u.recent) lines.push(`  [${hhmm(m.ts)}] @${m.author.handle}: ${oneLine(m.text)}`);
  }
  if (omitted !== undefined && omitted > 0) lines.push(`(외 스레드 ${omitted}개)`);
  return lines.join("\n");
}

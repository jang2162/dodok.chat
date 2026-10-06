import type { InboundReaction } from "../bridge";

/**
 * 에이전트가 지난 턴 뒤 자기 메시지에 달린 리액션을 읽는 글. 플러그인 헤더와 러너 턴 사실이 같은 함수를 써서 두 어댑터의
 * 문구가 갈라지지 않는다. 줄 순서는 at 오름차순, 비면 "".
 */
export function formatReactionFacts(reactions: readonly InboundReaction[], omitted?: number): string {
  if (reactions.length === 0) return "";
  const lines = [...reactions]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((r) => `- @${r.by} ${r.emoji} "${r.excerpt}"`);
  return [
    "반응(지난 턴 뒤 네 메시지에 달린 것):",
    ...lines,
    ...(omitted !== undefined && omitted > 0 ? [`(외 ${omitted}개)`] : []),
  ].join("\n");
}

/**
 * OpenClaw id → 핸들 기본값(규칙 `^[a-z0-9_-]{2,32}$`). 소문자, 규칙 밖 글자는 -, 연속 - 는 하나, 앞뒤 - 제거,
 * 비면 agent, 2자 미만은 0 채움, 32자 자르기(자른 끝의 - 도 뗀다)
 */
export function handleFrom(providerAgentId: string): string {
  const base = providerAgentId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (base || "agent").padEnd(2, "0").slice(0, 32).replace(/-+$/, "");
}

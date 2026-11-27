import { HANDLE_CHAR_CLASS } from "@dodok/shared";

const OUTSIDE = new RegExp(`[^${HANDLE_CHAR_CLASS}]+`, "gu");

/**
 * OpenClaw id → 핸들 기본값(shared `Handle` — 영문 소문자·숫자·_·- 와 한글 완성형 음절, 2~32글자). NFC·소문자, 규칙 밖 글자는 -,
 * 연속 - 는 하나, 앞뒤 - 제거, 비면 agent, 2자 미만은 0 채움, 32자 자르기(자른 끝의 - 도 뗀다)
 */
export function handleFrom(providerAgentId: string): string {
  const base = providerAgentId
    .normalize("NFC")
    .toLowerCase()
    .replace(OUTSIDE, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (base || "agent").padEnd(2, "0").slice(0, 32).replace(/-+$/, "");
}

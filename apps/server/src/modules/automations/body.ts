/**
 * 웹훅 원문 → 문구 아래 붙일 블록(자동화 스펙 「웹훅」 절 「엔드포인트」 표의 본문 줄). 원문은 문자열로만 다루고 해석은 에이전트에게
 * 맡긴다(스펙 결정 2) — JSON 타입이면 읽기 좋게 다시 들여 쓸 뿐이다. 멘션 토큰 꼴은 여기서 바꾸지 않는다: 게시
 * (createAutomationMessage)가 원문 몫을 무력화하므로 여기서도 바꾸면 두 번 바뀐다
 */

/** 블록 안 글의 상한(글자 = 코드 포인트) — 넘으면 자르고 「…(잘림)」을 붙인다 */
export const WEBHOOK_BLOCK_MAX = 8000;
const TRUNCATED = "…(잘림)";

/**
 * JSON 타입이면 2칸 들여쓰기로 다시 쓴 json 블록, 아니면(텍스트·폼·타입 없음·깨진 JSON) 원문 그대로의 블록. 본문이 비었거나 공백뿐이면
 * undefined — 문구만 게시한다
 */
export function webhookBlock(raw: string, contentType: string | undefined): string | undefined {
  if (raw.trim() === "") return undefined;
  const json = isJsonType(contentType) ? reindent(raw) : undefined;
  const text = truncate(json ?? raw);
  // 펜스는 블록에 들어가는 글의 가장 긴 백틱 줄보다 길게 — 원문 속 ``` 가 블록을 닫지 못한다(계획 Review Focus 2)
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${json === undefined ? "" : "json"}\n${text}\n${fence}`;
}

/** application/json 과 +json 접미(application/vnd.github+json 등) — 파라미터(charset)는 떼고 대소문자는 가리지 않는다 */
function isJsonType(contentType: string | undefined): boolean {
  const type = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json");
}

/** 깨졌거나 다시 쓸 수 없는 JSON(너무 깊은 중첩 — stringify 가 RangeError)은 undefined — 원문 그대로의 블록이 된다 */
function reindent(raw: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return undefined;
  }
}

/** 코드 포인트로 센다 — UTF-16 단위로 자르면 경계의 이모지가 짝 없는 서로게이트로 남는다 */
function truncate(text: string): string {
  const chars = Array.from(text);
  return chars.length > WEBHOOK_BLOCK_MAX
    ? `${chars.slice(0, WEBHOOK_BLOCK_MAX).join("")}${TRUNCATED}`
    : text;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return longest;
}

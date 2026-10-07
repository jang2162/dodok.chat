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

/**
 * 다시 쓰기 상한 — 하나라도 넘으면 다시 쓰지 않고 원문 그대로의 블록(8,000자 자르기만). stringify(v, null, 2) 는 줄마다 깊이의 두
 * 배만큼 칸을 넣어 깊이의 제곱으로 불어난다: 12 KB 의 `[`×6000 + `]`×6000 이 72M 자를 만들며 1.3~2.2초·힙 1.2 GB. 처리기 안에서
 * 동기로 돌아 그동안 브리지·wire·러너가 모두 멈춘다. 다시 재려면 별도 Node 24 프로세스의 메인 스레드에서 상한 없는 다시 쓰기로
 * webhookBlock 을 한 번 부른다 — 테스트 워커는 스택이 작아 6000 에서 stringify 가 던진다(automations.body.test.ts 「깊이」 사례 주석)
 */
export const REINDENT_LIMITS = {
  /** 중첩한 배열·객체 수 — 64단을 다시 쓴 글은 약 8K 자(2×깊이²)로 작다 */
  depth: 64,
  /** 값 수(루트·잎 포함) — 64 KiB 본문의 값은 많아야 약 32K 개(`[0,0,…]`) */
  nodes: 10_000,
  /** 다시 쓴 글의 길이(UTF-16 단위, 위로 어림) — 블록에는 8,000자만 들어가지만 보통 크기의 JSON 은 다시 쓴 뒤 자른다 */
  length: 256 * 1024,
} as const;

/** 깨졌거나 상한을 넘는 JSON 은 undefined — 원문 그대로의 블록이 된다 */
function reindent(raw: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return withinReindentLimits(value) ? JSON.stringify(value, null, 2) : undefined;
}

/**
 * 다시 쓴 글을 만들지 않고 상한 안인지 본다(스택 반복 — 재귀는 깊은 입력에서 스택을 넘는다). 길이는 위로 어림한다: 자식마다
 * 줄바꿈·들여쓰기(2×깊이)·쉼표, 키는 따옴표 친 길이 + 「: 」, 컨테이너마다 괄호 둘과 닫는 줄, 잎은 JSON.stringify 길이
 */
function withinReindentLimits(root: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  let length = 0;
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { value, depth } = next;
    if (++nodes > REINDENT_LIMITS.nodes) return false;
    if (value !== null && typeof value === "object") {
      if (depth >= REINDENT_LIMITS.depth) return false;
      length += 3 + 2 * depth;
      const children: Array<[string | undefined, unknown]> = Array.isArray(value)
        ? value.map((item: unknown) => [undefined, item])
        : Object.entries(value);
      for (const [key, child] of children) {
        length += 2 + 2 * (depth + 1) + (key === undefined ? 0 : JSON.stringify(key).length + 2);
        stack.push({ value: child, depth: depth + 1 });
      }
    } else {
      length += JSON.stringify(value).length;
    }
    if (length > REINDENT_LIMITS.length) return false;
  }
  return true;
}

/**
 * 코드 포인트로 센다 — UTF-16 단위로 자르면 경계의 이모지가 짝 없는 서로게이트로 남는다. 8,001번째에서 멈춘다(긴 글 전체를 코드 포인트
 * 배열로 만들지 않는다)
 */
function truncate(text: string): string {
  let count = 0;
  for (let i = 0; i < text.length; count++) {
    if (count === WEBHOOK_BLOCK_MAX) return `${text.slice(0, i)}${TRUNCATED}`;
    i += (text.codePointAt(i) as number) > 0xffff ? 2 : 1;
  }
  return text;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return longest;
}

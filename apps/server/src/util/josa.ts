/**
 * 앞말의 받침에 따라 조사를 고른다 — 시스템 메시지를 「@dev 이(가)」처럼 병기하지 않게(계획서 8장 이월).
 *
 * 웹의 `apps/web/src/lib/josa.ts` 와 같은 규칙을 서버에도 둔다. shared 로 올리지 않는 이유는 이것이 계약이 아니라
 * 문구를 다듬는 규칙이고, 웹은 브라우저 번들·서버는 노드라 쓰임새가 갈리기 때문이다(계획서 태스크 0).
 *
 * 받침을 보는 대상은 세 가지다.
 * - 한글 음절(가~힣): 코드포인트로 종성을 바로 계산한다.
 * - 숫자: 읽는 소리(영·일·이·삼…)의 받침.
 * - 로마자: 핸들은 `[a-z0-9_-]` 라(shared `Handle`) 한글 음절이 올 수 없다. 흔히 읽는 소리로 어림한다 —
 *   `l`·`m`·`n` 으로 끝나면 받침(핀·팀·툴), 그 밖의 자음은 「브·드·트」처럼 모음을 붙여 읽어 받침이 없다(데브).
 *   끝의 묵음 `e` 는 앞 글자로 판단한다(google→글, name→임). 어림이라 영어 낱말에 따라 틀릴 수 있다.
 *
 * 판단할 수 없는 글자(기호·이모지 등)로 끝나면 받침 없는 쪽을 쓴다.
 */

const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;

/** 읽는 소리의 받침: 영(ㅇ)·일(ㄹ)·삼(ㅁ)·육(ㄱ)·칠(ㄹ)·팔(ㄹ) 에는 있고 이·사·오·구 에는 없다 */
const DIGIT_FINAL: Record<string, boolean> = {
  "0": true,
  "1": true,
  "2": false,
  "3": true,
  "4": false,
  "5": false,
  "6": true,
  "7": true,
  "8": true,
  "9": false,
};

/** 소리의 끝이 받침으로 닫히는 로마자 */
const LATIN_FINAL = new Set(["l", "m", "n"]);

/** 마지막 글자에 받침이 있는지. 한글·숫자·로마자가 아니면 없는 것으로 본다 */
export function hasFinalConsonant(word: string): boolean {
  const letters = [...word.trim()];
  let last = letters.at(-1)?.toLowerCase() ?? "";
  // 끝의 묵음 e 는 앞 글자가 소리를 낸다(google → 구글, name → 네임)
  if (last === "e" && letters.length > 1) last = letters.at(-2)?.toLowerCase() ?? "";
  const code = last.codePointAt(0) ?? 0;
  if (code >= HANGUL_START && code <= HANGUL_END) return (code - HANGUL_START) % 28 !== 0;
  return DIGIT_FINAL[last] ?? LATIN_FINAL.has(last);
}

/**
 * 받침에 맞는 조사를 돌려준다 — `josa(handle, "을", "를")`.
 * 짝은 「받침 있음, 받침 없음」 순서다(을/를 · 이/가 · 은/는 · 과/와).
 */
export const josa = (word: string, withFinal: string, withoutFinal: string): string =>
  hasFinalConsonant(word) ? withFinal : withoutFinal;

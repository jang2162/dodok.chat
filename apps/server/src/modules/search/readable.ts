/**
 * 검색 스니펫의 「읽는 글」 — 저장 본문(마크다운·멘션 토큰)을 화면에 보이는 글자로 바꾸고, 글자마다 원문 위치를 붙여 둔다.
 * 색인·검색어 일치는 원문 위에서 나므로(검색어 안 `@핸들` 은 토큰으로 바꿔 찾는다) 강조 범위는 원문 위치로 옮겨 와야 한다.
 * 정규식을 차례로 치환하면 그 위치를 잃어서 한 번 훑는 스캐너로 만든다.
 *
 * 마크다운은 렌더러가 아니라 휴리스틱으로 걷는다 — 표·HTML 은 그대로 남고, 짝이 안 맞는 강조 표시도 남는다.
 * 목표는 「스니펫에 `**`·`#`·`](https://…)` 같은 문법이 보이지 않는 것」이지 웹 렌더와 글자 단위로 같은 것이 아니다
 *
 * ⚠ 강조·링크는 여는 표시마다 줄 끝까지 닫는 짝을 찾으므로 한 줄 안에서 길이의 제곱으로 느려진다 — 100 KB(본문 상한) 한 줄의
 * `*a ` 반복이 수 초다(`readableGlyphs("*a ".repeat(33_333), () => undefined)` 를 window 없이 tsx 로 잰다). 그래서 본문은
 * readableWindow 로 고른 창만 변환한다 — 창 하나는 같은 꼴에서 몇 ms 이고, search.snippet-window.test.ts 가 창 길이를 지킨다
 */

/** 화면 글자 하나(코드 포인트)와 그 글자를 낳은 원문 범위(UTF-16 오프셋, [from, to)) */
export type Glyph = { ch: string; from: number; to: number };

/** 원문 범위 [from, to)(UTF-16 오프셋) */
export type Span = { from: number; to: number };

/** 멘션 토큰 `<@a|u:id>` → 보일 핸들. 모르면 undefined — 웹 MentionChip 처럼 「@알 수 없음」으로 그린다 */
export type HandleOf = (kind: "a" | "u", id: string) => string | undefined;

const UNKNOWN_MENTION = "알 수 없음";

// shared MENTION_TOKEN_RE 와 같은 꼴이다 — 거기는 g 플래그라 위치 고정(y) 매칭에 쓸 수 없다
const MENTION_AT = /<@(a|u):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/y;
const FENCE_LINE = / {0,3}(`{3,}|~{3,})[^\n]*/y;
const HR_LINE = / {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*(?=\n|$)/y;
const LINE_MARKER = / {0,3}(?:#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/y;
const INLINE_CODE = /(`+)([^`\n]*?)\1(?!`)/y;
// 링크 글 안의 대괄호 짝은 한 겹까지 — 배지 꼴 `[![그림](a.svg)](주소)` 를 한 링크로 본다. 두 갈래의 첫 글자가 달라(`[` 와 그 밖)
// 되짚기가 갈라지지 않는다 — 갈래를 겹치게 고치면 닫히지 않는 줄에서 지수로 느려진다
const LINK = /!?\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\((?:[^)\s]*)(?:\s+"[^"\n]*")?\)/y;
const AUTOLINK = /<(https?:\/\/[^>\s]+)>/y;
// 같은 표시로 닫히는 짝만 걷는다 — 「2 * 3」 같은 외짝 별표는 남는다. 여는 표시는 같은 글자 덩어리 전체여야 한다 —
// 아니면 「x ** y ** z」 의 `**` 가 공백 앞이라 실패한 뒤 앞 `*` 하나가 여는 표시로 되잡힌다
const EMPHASIS = /(\*{1,3}(?!\*)|_{1,3}(?!_)|~~)(?=\S)[^\n]*?\S\1/y;
const ESCAPE = /\\([!-/:-@[-`{-~])/y;
const WORD = /[\p{L}\p{N}]/u;

function at(re: RegExp, text: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text);
}

/** 일치 앞뒤로 변환할 원문 길이(UTF-16) — 스니펫에 보이는 글자(앞뒤 64·강조 396)보다 넉넉하고, 창 하나의 최악 변환이 몇 ms 안이다 */
export const READABLE_WINDOW_SPAN = 2048;

/**
 * 원문 [from, to) 를 스니펫으로 보일 때 변환할 창 — 앞뒤 READABLE_WINDOW_SPAN 안. 창 안에 줄 경계가 있으면 일치가 든 줄 쪽으로
 * 줄 경계에 맞춰 줄인다(넓히면 긴 줄에서 다시 느려진다). 줄 한가운데서 자르면 그 자리의 멘션 토큰은 통째로 넣고, 잘린 강조·링크는
 * 짝을 못 찾아 원문 글자로 남는다
 */
export function readableWindow(raw: string, from: number, to: number): Span {
  let start = Math.max(0, from - READABLE_WINDOW_SPAN);
  let end = Math.min(raw.length, to + READABLE_WINDOW_SPAN);
  if (start > 0) {
    const nl = raw.indexOf("\n", start - 1);
    if (nl >= 0 && nl < from) start = nl + 1;
    else start = tokenAcross(raw, start) ?? start;
  }
  if (end < raw.length) {
    const nl = raw.lastIndexOf("\n", end);
    if (nl >= to) end = nl;
    else {
      const token = tokenAcross(raw, end);
      if (token !== undefined) end = token + TOKEN_LENGTH;
    }
  }
  return { from: start, to: end };
}

const TOKEN_LENGTH = "<@a:00000000-0000-0000-0000-000000000000>".length;

/** pos 가 멘션 토큰 한가운데면 그 토큰의 시작 */
function tokenAcross(raw: string, pos: number): number | undefined {
  const open = raw.lastIndexOf("<@", pos - 1);
  return open >= 0 && open > pos - TOKEN_LENGTH && at(MENTION_AT, raw, open) ? open : undefined;
}

/**
 * 원문 → 화면 글자. 공백 덩어리는 공백 하나로, 앞뒤 공백은 걷는다. window 를 주면 그 창만 변환한다 — 창 앞은 코드 펜스 상태만
 * 줄머리로 훑어 이어받고(인라인 표시는 줄을 넘지 않는다), 창 끝 너머는 보지 않는다
 */
export function readableGlyphs(raw: string, handleOf: HandleOf, window?: Span): Glyph[] {
  const from = window?.from ?? 0;
  if (window !== undefined && window.to < raw.length) raw = raw.slice(0, window.to);
  const out: Glyph[] = [];
  const emit = (text: string, from: number, to: number) => {
    for (const ch of text) out.push({ ch, from, to });
  };
  const literal = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      const ch = String.fromCodePoint(raw.codePointAt(i) as number);
      out.push({ ch, from: i, to: i + ch.length });
      i += ch.length;
    }
  };
  // 링크·강조의 닫는 쪽 — 여는 쪽을 만났을 때 적어 두고, 그 자리에 오면 건너뛴다
  const skipAt = new Map<number, number>();
  let fence = fenceBefore(raw, from);
  let pos = from;
  let lineStart = from === 0 || raw[from - 1] === "\n";
  while (pos < raw.length) {
    const jump = skipAt.get(pos);
    if (jump !== undefined) {
      pos = jump;
      continue;
    }
    if (lineStart) {
      ({ pos, fence } = lineHead(raw, pos, fence));
      lineStart = false;
      continue; // 줄머리가 본문 끝까지 먹었을 수 있다
    }
    const ch = raw[pos] as string;
    if (ch === "\n") {
      emit("\n", pos, pos + 1);
      pos += 1;
      lineStart = true;
      continue;
    }
    if (fence !== undefined) {
      const end = raw.indexOf("\n", pos);
      literal(pos, end < 0 ? raw.length : end);
      pos = end < 0 ? raw.length : end;
      continue;
    }
    const step = inline(raw, pos, ch);
    if (step === undefined) {
      const next = pos + String.fromCodePoint(raw.codePointAt(pos) as number).length;
      literal(pos, next);
      pos = next;
      continue;
    }
    switch (step.kind) {
      case "code":
        literal(step.innerFrom, step.innerTo);
        pos = step.end;
        break;
      case "mention":
        emit(`@${handleOf(step.type, step.id) ?? UNKNOWN_MENTION}`, pos, step.end);
        pos = step.end;
        break;
      case "open":
        skipAt.set(step.closeAt, step.end);
        pos = step.innerFrom;
        break;
      case "escaped":
        literal(pos + 1, pos + 2);
        pos += 2;
        break;
    }
  }
  return collapseSpaces(out);
}

/**
 * 줄머리 — 코드 펜스 줄이면 펜스를 열거나 닫고 그 줄을 먹는다. 펜스 밖이면 줄머리 표시(제목·인용·목록·가로줄)를 먹는다.
 * 「> - 항목」 처럼 표시가 겹칠 수 있어 되풀이한다. 돌려준 pos 부터가 줄 안의 글이다
 */
function lineHead(
  raw: string,
  pos: number,
  fence: string | undefined,
): { pos: number; fence: string | undefined } {
  for (;;) {
    const f = at(FENCE_LINE, raw, pos);
    if (f) {
      const mark = f[1] as string;
      if (fence === undefined) return { pos: pos + f[0].length, fence: mark };
      if (mark[0] === fence[0] && mark.length >= fence.length && f[0].trim() === mark)
        return { pos: pos + f[0].length, fence: undefined };
      return { pos, fence };
    }
    if (fence !== undefined) return { pos, fence };
    const m = at(HR_LINE, raw, pos) ?? at(LINE_MARKER, raw, pos);
    if (!m || m[0].length === 0) return { pos, fence };
    pos += m[0].length;
  }
}

/** upTo 앞에서 시작한 줄들의 줄머리만 훑어 upTo 자리의 코드 펜스 상태를 구한다 */
function fenceBefore(raw: string, upTo: number): string | undefined {
  let fence: string | undefined;
  let pos = 0;
  while (pos < upTo) {
    fence = lineHead(raw, pos, fence).fence;
    const nl = raw.indexOf("\n", pos);
    if (nl < 0) break;
    pos = nl + 1;
  }
  return fence;
}

/** code·mention 은 end 로 건너뛰고, open 은 안쪽(innerFrom)을 이어 훑되 closeAt 에 오면 end 로 건너뛴다 */
type Step =
  | { kind: "code"; innerFrom: number; innerTo: number; end: number }
  | { kind: "mention"; type: "a" | "u"; id: string; end: number }
  | { kind: "open"; innerFrom: number; closeAt: number; end: number }
  | { kind: "escaped" };

function inline(raw: string, pos: number, ch: string): Step | undefined {
  switch (ch) {
    case "`": {
      const m = at(INLINE_CODE, raw, pos);
      if (!m) return undefined;
      const fence = (m[1] as string).length;
      return {
        kind: "code",
        innerFrom: pos + fence,
        innerTo: pos + m[0].length - fence,
        end: pos + m[0].length,
      };
    }
    case "<": {
      const t = at(MENTION_AT, raw, pos);
      if (t) {
        return { kind: "mention", type: t[1] as "a" | "u", id: t[2] as string, end: pos + t[0].length };
      }
      const a = at(AUTOLINK, raw, pos);
      if (!a) return undefined;
      const end = pos + a[0].length;
      return { kind: "open", innerFrom: pos + 1, closeAt: end - 1, end };
    }
    case "!":
    case "[": {
      const l = at(LINK, raw, pos);
      if (!l) return undefined;
      const open = ch === "!" ? 2 : 1;
      const closeAt = pos + open + (l[1] as string).length;
      return { kind: "open", innerFrom: pos + open, closeAt, end: pos + l[0].length };
    }
    case "*":
    case "_":
    case "~": {
      const e = at(EMPHASIS, raw, pos);
      if (!e) return undefined;
      const mark = (e[1] as string).length;
      const end = pos + e[0].length;
      // 밑줄은 단어 안에서 강조가 아니다(snake_case)
      if (ch === "_" && (WORD.test(raw[pos - 1] ?? "") || WORD.test(raw[end] ?? ""))) return undefined;
      return { kind: "open", innerFrom: pos + mark, closeAt: end - mark, end };
    }
    case "\\": {
      return at(ESCAPE, raw, pos) ? { kind: "escaped" } : undefined;
    }
    default:
      return undefined;
  }
}

/** 마크다운이 아닌 글(첨부 이름) — 글자 그대로, 공백만 접는다 */
export function plainGlyphs(raw: string): Glyph[] {
  const out: Glyph[] = [];
  let i = 0;
  for (const ch of raw) {
    out.push({ ch, from: i, to: i + ch.length });
    i += ch.length;
  }
  return collapseSpaces(out);
}

function collapseSpaces(glyphs: Glyph[]): Glyph[] {
  const out: Glyph[] = [];
  for (const g of glyphs) {
    if (!/\s/.test(g.ch)) {
      out.push(g);
      continue;
    }
    const last = out.at(-1);
    if (last === undefined) continue;
    // 공백이 아닌 글자는 " " 가 아니므로 끝 글자가 " " 면 접은 공백이다
    if (last.ch === " ") last.to = g.to;
    else out.push({ ch: " ", from: g.from, to: g.to });
  }
  if (out.at(-1)?.ch === " ") out.pop();
  return out;
}

/**
 * 강조할 화면 범위 [first, last] — 원문 일치 [from, to) 에 걸친 글자 전부. 화면 글자가 하나도 안 걸리면 undefined.
 * 글자는 원문 순서로 나와 from·to 가 줄지 않으므로 이분 탐색한다 — 일치 후보마다 부르기 때문이다
 */
export function glyphRange(glyphs: Glyph[], from: number, to: number): [number, number] | undefined {
  let lo = 0;
  let hi = glyphs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((glyphs[mid] as Glyph).to > from) hi = mid;
    else lo = mid + 1;
  }
  let last = lo - 1;
  while (last + 1 < glyphs.length && (glyphs[last + 1] as Glyph).from < to) last++;
  return last < lo ? undefined : [lo, last];
}

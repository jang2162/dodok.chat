/**
 * 코어의 레거시 첨부 관례 — 단독 줄 `MEDIA:<경로|URL>`. 폴백 최종본과 스트리밍 델타가 같은 줄 정의를 쓴다.
 * 대소문자는 가리지 않는다 — 코어는 줄 머리 여섯 글자를 toUpperCase 로 `MEDIA:` 와 비교하고 `/\bMEDIA:…/gi` 로 뽑는다(9.4·9.5 같음).
 * `MEDIA` 와 콜론 사이 공백은 코어도 허용하지 않는다.
 */
const MEDIA_LINE_START = /^[ \t]*MEDIA:/i;
const MEDIA_LINE = new RegExp(`${MEDIA_LINE_START.source}[^\\n]*(?:\\n|$)`, "gim");
const MEDIA_PREFIX = "MEDIA:";

/** 코어의 MEDIA: 줄을 걷는다 — 폴백 최종본이 호스트 경로를 채널에 저장하지 않게(스펙 4.6) */
export function stripMediaLines(text: string): { text: string; dropped: number } {
  let dropped = 0;
  const out = text.replace(MEDIA_LINE, () => {
    dropped++;
    return "";
  });
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), dropped };
}

/**
 * 스트리밍 델타용 줄 단위 필터의 상태(결함 A·Ruling 6). 경로가 델타 여럿으로 쪼개져 오므로 줄 처음 조각을 쥔다.
 * pending: 줄 처음부터 붙잡은 조각(MEDIA: 줄이거나 그 접두일 수 있다). midLine: 이 줄의 앞부분을 이미 내보냈다.
 */
export type MediaLineFilter = { pending: string; midLine: boolean; dropped: number };

export function createMediaLineFilter(): MediaLineFilter {
  return { pending: "", midLine: false, dropped: 0 };
}

/** 앞 공백·탭을 걷고 MEDIA: 로 시작하거나 그 접두면(공백뿐인 조각 포함) 아직 판정할 수 없다 */
function mayBeMediaLine(head: string): boolean {
  if (MEDIA_LINE_START.test(head)) return true;
  return MEDIA_PREFIX.startsWith(head.replace(/^[ \t]*/, "").toUpperCase());
}

/** 조각을 넣고 지금 내보낼 텍스트를 돌려준다(빈 문자열일 수 있다). MEDIA: 줄은 줄바꿈까지 버린다 */
export function feedMediaLineFilter(state: MediaLineFilter, delta: string): string {
  let rest = state.pending + delta;
  state.pending = "";
  let out = "";
  while (rest !== "") {
    const nl = rest.indexOf("\n");
    if (state.midLine) {
      if (nl < 0) return out + rest;
      out += rest.slice(0, nl + 1);
      rest = rest.slice(nl + 1);
      state.midLine = false;
      continue;
    }
    if (nl >= 0) {
      const line = rest.slice(0, nl + 1);
      if (MEDIA_LINE_START.test(line)) state.dropped++;
      else out += line;
      rest = rest.slice(nl + 1);
      continue;
    }
    if (mayBeMediaLine(rest)) state.pending = rest;
    else {
      out += rest;
      state.midLine = true;
    }
    break;
  }
  return out;
}

/** 런(메시지)이 끝났다 — 붙잡은 것이 MEDIA: 줄이면 버리고, 접두였을 뿐이면 내보낸다. 상태는 처음으로 돌아간다 */
export function endMediaLineFilter(state: MediaLineFilter): string {
  const held = state.pending;
  state.pending = "";
  state.midLine = false;
  if (!MEDIA_LINE_START.test(held)) return held;
  state.dropped++;
  return "";
}

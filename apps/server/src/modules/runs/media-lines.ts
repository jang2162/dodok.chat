/** 코어의 레거시 첨부 관례(단독 줄 `MEDIA:<경로|URL>`)를 걷는다 — 폴백 최종본이 호스트 경로를 채널에 저장하지 않게(스펙 4.6) */
const MEDIA_LINE = /^[ \t]*MEDIA:[^\n]*(?:\n|$)/gm;

export function stripMediaLines(text: string): { text: string; dropped: number } {
  let dropped = 0;
  const out = text.replace(MEDIA_LINE, () => {
    dropped++;
    return "";
  });
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), dropped };
}

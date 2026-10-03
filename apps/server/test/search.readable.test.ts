import { describe, expect, it } from "vitest";
import { glyphRange, plainGlyphs, readableGlyphs } from "../src/modules/search/readable";

const DEV = "0199a0b7-0000-7000-8000-00000000d0e1";
const handleOf = (kind: "a" | "u", id: string) => (kind === "a" && id === DEV ? "dev" : undefined);
const read = (raw: string) =>
  readableGlyphs(raw, handleOf)
    .map((g) => g.ch)
    .join("");

describe("readableGlyphs — 읽는 글", () => {
  it.each([
    ["제목·강조", "# 제목 **굵게** *기울임* ___둘 다___", "제목 굵게 기울임 둘 다"],
    ["취소선·인라인 코드(백틱 둘)", "~~지움~~ ``a`b`` 끝", "지움 a`b 끝"],
    [
      "링크·이미지·자동 링크",
      '[글](https://x.y "제목") ![그림](a.png) <https://x.y/z>',
      "글 그림 https://x.y/z",
    ],
    ["인용 안 목록·할 일", "> - [x] 했다\n> 1. 둘째", "했다 둘째"],
    ["가로줄", "위\n\n---\n아래", "위 아래"],
    ["~~~ 펜스·안쪽 표시는 그대로", "~~~\n# **아님**\n~~~", "# **아님**"],
    ["닫히지 않은 펜스는 끝까지 코드", "```\n*그대로*", "*그대로*"],
    ["펜스 안의 정보 문자열 줄은 닫는 줄이 아니다", "```\n```js\n본문\n```", "```js 본문"],
    ["역슬래시 이스케이프", "\\*별\\* \\_밑줄\\_", "*별* _밑줄_"],
    ["단어 안 밑줄·외짝 별표", "a_b_c 2 * 3", "a_b_c 2 * 3"],
    ["펜스·인라인 코드 안의 멘션 토큰은 풀지 않는다", `\`<@a:${DEV}>\``, `<@a:${DEV}>`],
    ["멘션 — 아는 id·모르는 id", `<@a:${DEV}> <@u:${DEV}>`, "@dev @알 수 없음"],
    ["아스트랄 문자는 글자 하나", "😀**😀**", "😀😀"],
  ])("%s", (_name, raw, want) => {
    expect(read(raw)).toBe(want);
  });

  it("글자마다 그 글자를 낳은 원문 범위 — 멘션은 토큰 전체", () => {
    const raw = `**가** <@a:${DEV}>`;
    const glyphs = readableGlyphs(raw, handleOf);
    expect(glyphs[0]).toEqual({ ch: "가", from: 2, to: 3 });
    const tokenAt = raw.indexOf("<@");
    expect(glyphs.slice(2).map((g) => [g.from, g.to])).toEqual(
      Array.from({ length: 4 }, () => [tokenAt, raw.length]),
    );
  });

  it("glyphRange — 원문 범위에 걸친 화면 글자 전부, 하나도 안 걸리면 undefined", () => {
    const raw = "앞 **보고서** 뒤";
    const glyphs = readableGlyphs(raw, handleOf);
    // 「**보고」(원문 2~6) → 화면 「보고」
    const r = glyphRange(glyphs, 2, 6);
    expect(
      r &&
        glyphs
          .slice(r[0], r[1] + 1)
          .map((g) => g.ch)
          .join(""),
    ).toBe("보고");
    // 표시 「**」 만(원문 2~4) — 화면 글자가 없다
    expect(glyphRange(glyphs, 2, 4)).toBeUndefined();
  });

  it("plainGlyphs — 마크다운을 보지 않고 공백만 접는다", () => {
    expect(
      plainGlyphs("**a**   b.pdf")
        .map((g) => g.ch)
        .join(""),
    ).toBe("**a** b.pdf");
  });
});

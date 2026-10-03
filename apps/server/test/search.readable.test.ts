import { describe, expect, it } from "vitest";
import {
  glyphRange,
  plainGlyphs,
  READABLE_WINDOW_SPAN,
  readableGlyphs,
  readableWindow,
} from "../src/modules/search/readable";

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
    ["인라인 코드 안의 멘션 토큰은 풀지 않는다", `\`<@a:${DEV}>\``, `<@a:${DEV}>`],
    ["펜스 안 줄머리의 멘션 토큰도 풀지 않는다", `\`\`\`\n<@a:${DEV}> 끝\n\`\`\``, `<@a:${DEV}> 끝`],
    ["링크 글 안의 이미지 한 겹(배지 꼴)", "[![빌드](https://x.y/b.svg)](https://x.y) 뒤", "빌드 뒤"],
    ["링크 글 안의 대괄호 짝은 글자로", "[a [b] c](https://x.y)", "a [b] c"],
    ["공백에 둘러싸인 별표 두 개는 강조가 아니다", "x ** y ** z", "x ** y ** z"],
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

  it("창 — 창 밖 원문은 글자를 낳지 않고, 창 안은 통째로 볼 때와 같은 글자다", () => {
    const raw = "# 첫 줄\n**둘째** 줄\n- 셋째 [링크](https://x.y)\n넷째";
    const from = raw.indexOf("**둘째");
    const to = raw.indexOf("\n넷째");
    const all = readableGlyphs(raw, handleOf);
    const part = readableGlyphs(raw, handleOf, { from, to });
    expect(part.every((g) => g.from >= from && g.to <= to)).toBe(true);
    expect(part).toEqual(all.filter((g) => g.from >= from && g.to <= to));
  });

  it("창 — 창 앞에서 열린 코드 펜스 안이면 창 안도 코드로 본다", () => {
    const raw = `\`\`\`\n${"x\n".repeat(10)}**그대로** <@a:${DEV}>\n\`\`\`\n**걷음**`;
    const from = raw.indexOf("**그대로");
    expect(
      readableGlyphs(raw, handleOf, { from, to: raw.length })
        .map((g) => g.ch)
        .join(""),
    ).toBe(`**그대로** <@a:${DEV}> 걷음`);
  });

  it("창 — 줄 한가운데서 시작하면 거기를 줄머리로 보지 않는다", () => {
    const raw = "앞 글자 # 제목 아님";
    const from = raw.indexOf("#");
    expect(
      readableGlyphs(raw, handleOf, { from, to: raw.length })
        .map((g) => g.ch)
        .join(""),
    ).toBe("# 제목 아님");
  });

  describe("readableWindow — 변환할 원문 창", () => {
    it("100 KB 한 줄이어도 일치 앞뒤 READABLE_WINDOW_SPAN 남짓만 고른다", () => {
      for (const unit of ["*a ", "![a", "[a"]) {
        const raw = `${unit.repeat(16_000)}목표어${unit.repeat(16_000)}`;
        const from = raw.indexOf("목표어");
        const w = readableWindow(raw, from, from + 3);
        expect(w.from).toBeLessThanOrEqual(from);
        expect(w.to).toBeGreaterThanOrEqual(from + 3);
        expect(w.to - w.from).toBeLessThanOrEqual(2 * READABLE_WINDOW_SPAN + 3);
      }
    });

    it("짧은 본문은 통째로", () => {
      const raw = "짧은 **본문** 이다";
      expect(readableWindow(raw, 4, 6)).toEqual({ from: 0, to: raw.length });
    });

    it("줄 경계가 창 안에 있으면 거기서 자른다 — 일치가 든 줄은 남긴다", () => {
      const line = "가".repeat(100);
      const raw = `${`${line}\n`.repeat(60)}목표어 줄\n${`${line}\n`.repeat(60)}`;
      const from = raw.indexOf("목표어");
      const w = readableWindow(raw, from, from + 3);
      expect(w.from === 0 || raw[w.from - 1] === "\n").toBe(true);
      expect(w.to === raw.length || raw[w.to] === "\n").toBe(true);
      expect(w.from).toBeLessThan(from);
      expect(w.to).toBeGreaterThan(from + 3);
    });

    it("줄 한가운데서 자르는 자리가 멘션 토큰 안이면 토큰을 통째로 넣는다", () => {
      const token = `<@a:${DEV}>`;
      const pad = "가".repeat(READABLE_WINDOW_SPAN - 20);
      const raw = `${"나".repeat(50)}${token}${pad}목표어${pad}${token}${"나".repeat(50)}`;
      const from = raw.indexOf("목표어");
      const w = readableWindow(raw, from, from + 3);
      expect(w.from).toBe(raw.indexOf(token));
      expect(w.to).toBe(raw.lastIndexOf(token) + token.length);
    });
  });
});

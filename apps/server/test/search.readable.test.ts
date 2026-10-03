import { describe, expect, it, vi } from "vitest";
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
    ["인용·목록 안 가로줄 — 표시를 먹은 뒤에도 가로줄", "> ---\n- * * *\n뒤", "뒤"],
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

  it.each(["```", "~~~"])("창 — 창 앞에서 열린 코드 펜스(%s) 안이면 창 안도 코드로 본다", (fence) => {
    const raw = `${fence}\n${"x\n".repeat(10)}**그대로** <@a:${DEV}>\n${fence}\n**걷음**`;
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

  it("창 끝이 쌍을 갈라도 같은 창을 수만 번 변환해 던지지 않는다 — 최적화된 codePointAt 은 잘린 문자열 끝 너머를 읽는다", () => {
    const raw = `${"가".repeat(100)}😀${"나".repeat(100)}`;
    const high = raw.indexOf("😀");
    const window = { from: high - 20, to: high + 1 };
    for (let i = 0; i < 50_000; i++) {
      const glyphs = readableGlyphs(raw, handleOf, window);
      if (glyphs.length !== 21 || glyphs.at(-1)?.to !== high + 1) {
        throw new Error(`${i}번째: ${JSON.stringify(glyphs.at(-1))}`);
      }
    }
  });

  it("창 앞은 펜스 표시가 든 줄만 줄머리로 훑는다", () => {
    const raw = `${"- 항목\n".repeat(10_000)}\`\`\`\n코드\n\`\`\`\n${"- 항목\n".repeat(10_000)}목표어`;
    const from = raw.indexOf("목표어");
    // 줄머리 훑기는 늘 FENCE_LINE 부터 시도한다 — 그 시도 수로 줄머리를 훑은 줄 수를 센다
    const exec = vi.spyOn(RegExp.prototype, "exec");
    try {
      expect(
        readableGlyphs(raw, handleOf, { from, to: raw.length })
          .map((g) => g.ch)
          .join(""),
      ).toBe("목표어");
      const fenceTries = exec.mock.contexts.filter((re) => (re as RegExp).source.includes("`{3,}")).length;
      expect(fenceTries).toBeLessThanOrEqual(3);
    } finally {
      exec.mockRestore();
    }
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

    it("양 끝은 서로게이트 쌍을 가르지 않는다", () => {
      const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
      const raw = "😀".repeat(3000);
      for (let from = 2040; from < 2060; from++) {
        // 홀수 from 은 쌍 한가운데 — 창 시작(from - SPAN)·끝(from + 1 + SPAN)이 쌍을 가를 자리다
        const w = readableWindow(raw, from, from + 1);
        expect(isLow(raw.charCodeAt(w.from))).toBe(false);
        expect(w.to === raw.length || !isLow(raw.charCodeAt(w.to))).toBe(true);
      }
    });

    it("옆 줄이 길어 줄 경계로 줄이면 그쪽 문맥이 남지 않을 때는 줄 한가운데서 자른다", () => {
      const before = `${"가".repeat(3000)}\n목표어 뒤`;
      const b = before.indexOf("목표어");
      expect(readableWindow(before, b, b + 3).from).toBe(b - READABLE_WINDOW_SPAN);
      const after = `앞 목표어\n${"나".repeat(3000)}`;
      const a = after.indexOf("목표어");
      expect(readableWindow(after, a, a + 3).to).toBe(a + 3 + READABLE_WINDOW_SPAN);
      const head = `제목\n${"다".repeat(3000)}`;
      expect(readableWindow(head, 0, 0).to).toBe(READABLE_WINDOW_SPAN);
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

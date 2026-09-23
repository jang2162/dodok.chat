import { describe, expect, it } from "vitest";
import {
  createMediaLineFilter,
  endMediaLineFilter,
  feedMediaLineFilter,
  stripMediaLines,
} from "../src/modules/runs/media-lines";

describe("stripMediaLines — 호스트 경로가 채널에 새지 않게(스파이크 2-10)", () => {
  it("단독 줄 MEDIA: 를 걷는다", () => {
    expect(stripMediaLines("결과\n\nMEDIA:/Users/x/a.png")).toEqual({ text: "결과", dropped: 1 });
    expect(stripMediaLines("  MEDIA: https://e.com/a.png\n본문\nMEDIA:./b.pdf")).toEqual({
      text: "본문",
      dropped: 2,
    });
  });
  it("줄 가운데의 MEDIA: 는 건드리지 않는다", () => {
    expect(stripMediaLines("이건 MEDIA: 라는 단어")).toEqual({ text: "이건 MEDIA: 라는 단어", dropped: 0 });
  });
  it("MEDIA 줄뿐이면 빈 문자열", () => {
    expect(stripMediaLines("MEDIA:/a.png\nMEDIA:/b.png\n")).toEqual({ text: "", dropped: 2 });
  });
  it("걷고 남은 빈 줄 셋 이상은 둘로", () => {
    expect(stripMediaLines("가\n\nMEDIA:/a\n\n나")).toEqual({ text: "가\n\n나", dropped: 1 });
  });
  it("대소문자를 가리지 않는다 — 코어가 줄 머리를 toUpperCase 로 비교해 뽑는다", () => {
    expect(stripMediaLines("가\nmedia:/Users/x/a.png\n나\n  Media: /Users/y/b.png")).toEqual({
      text: "가\n나",
      dropped: 2,
    });
  });
  it("MEDIA 와 콜론 사이 공백은 MEDIA: 줄이 아니다 — 코어도 줄 머리 여섯 글자가 MEDIA: 여야 뽑는다", () => {
    expect(stripMediaLines("MEDIA :/Users/x")).toEqual({ text: "MEDIA :/Users/x", dropped: 0 });
  });
});

/** 조각마다 내보낸 것과 런 끝에 내보낸 것 */
function stream(chunks: string[]): { out: string[]; end: string; dropped: number } {
  const f = createMediaLineFilter();
  const out = chunks.map((c) => feedMediaLineFilter(f, c));
  const end = endMediaLineFilter(f);
  return { out, end, dropped: f.dropped };
}
const joined = (r: { out: string[]; end: string }) => r.out.join("") + r.end;

describe("미디어 줄 필터 — 스트리밍 델타의 MEDIA: 줄을 걷는다(결함 A)", () => {
  it("델타 여럿으로 쪼개진 MEDIA: 줄은 줄째 버린다", () => {
    const r = stream(["결과\nME", "DIA:/Us", "ers/x/a.png"]);
    expect(r.out).toEqual(["결과\n", "", ""]);
    expect(r.end).toBe("");
    expect(r.dropped).toBe(1);
  });
  it("실연 모양 — 경로가 셋으로 쪼개지고 줄바꿈으로 끝나도 경로 조각이 하나도 안 나간다", () => {
    const r = stream(["끝났어요.\n\n", "MEDIA:/Users/someone", "/.openclaw-d", "ev/workspace/hello.txt\n"]);
    expect(joined(r)).toBe("끝났어요.\n\n");
    expect(r.out.join("")).not.toContain("/Users/");
  });
  it("줄 가운데의 MEDIA: 는 그대로 — 앞 조각이 이미 나간 줄이면 뒤 조각이 MEDIA: 로 시작해도 줄 처음이 아니다", () => {
    expect(joined(stream(["이건 MEDIA: 라는 단어"]))).toBe("이건 MEDIA: 라는 단어");
    const r = stream(["SOCIAL ", "MEDIA:", " 광고"]);
    expect(r.out).toEqual(["SOCIAL ", "MEDIA:", " 광고"]);
  });
  it("SOCIAL MEDIA 로 끝나는 줄은 줄 처음이 아니라 그대로", () => {
    expect(stream(["SOCIAL MEDIA"]).out).toEqual(["SOCIAL MEDIA"]);
  });
  it("「MEDIA」 한 단어 줄로 끝나면 붙잡았다가 런 끝에 내보낸다", () => {
    const r = stream(["보통 글\n", "MEDIA"]);
    expect(r.out).toEqual(["보통 글\n", ""]);
    expect(r.end).toBe("MEDIA");
    expect(r.dropped).toBe(0);
  });
  it("MEDI 접두로 끝나면 런 끝에 내보낸다", () => {
    expect(stream(["MEDI"])).toEqual({ out: [""], end: "MEDI", dropped: 0 });
  });
  it("「MEDIA」 뒤에 콜론이 아닌 글자가 오면 곧바로 풀려난다", () => {
    expect(stream(["MEDIA", "TION 이야기"]).out).toEqual(["", "MEDIATION 이야기"]);
  });
  it("MEDIA: 줄 뒤에 이어지는 보통 줄은 나간다", () => {
    const r = stream(["MEDIA:/a.png\n다음 줄", "\n끝"]);
    expect(r.out).toEqual(["다음 줄", "\n끝"]);
    expect(joined(r)).toBe("다음 줄\n끝");
  });
  it("줄바꿈 없이 끝나는 MEDIA: 줄은 런 끝에 버린다", () => {
    const r = stream(["결과\n", "MEDIA:/Users/x/a.png"]);
    expect(r).toEqual({ out: ["결과\n", ""], end: "", dropped: 1 });
  });
  it("\\r\\n 줄바꿈 — MEDIA: 줄은 \\r\\n 째, 보통 줄은 그대로", () => {
    expect(joined(stream(["가\r\nMEDIA:/a", ".png\r\n나\r\n"]))).toBe("가\r\n나\r\n");
  });
  it("앞 공백·탭 뒤의 MEDIA: 도 걷는다(stripMediaLines 와 같은 줄 정의)", () => {
    const r = stream([" \t", "MEDIA:/a.png\n", "본문"]);
    expect(r.out).toEqual(["", "", "본문"]);
    expect(stripMediaLines(" \tMEDIA:/a.png\n본문").text).toBe("본문");
  });
  it("늦추지 않는다 — M 으로 시작하는 보통 줄은 두 번째 글자에서 곧바로 풀려난다", () => {
    expect(stream(["M", "a", "rkdown 표"]).out).toEqual(["", "Ma", "rkdown 표"]);
    expect(stream(["Markdown"]).out).toEqual(["Markdown"]);
    expect(stream(["안녕", "하세요"]).out).toEqual(["안녕", "하세요"]);
  });
  it("대소문자를 가리지 않는다 — media:·Media:·쪼개진 me + DIA: 모두 줄째 버린다", () => {
    expect(joined(stream(["가\nmedia:/Users/x/a.png\n나"]))).toBe("가\n나");
    expect(joined(stream(["가\n", "Media: /Users/x", "/a.png\n", "나"]))).toBe("가\n나");
    const r = stream(["가\nme", "DIA:/Us", "ers/x/a.png"]);
    expect(r.out).toEqual(["가\n", "", ""]);
    expect(r).toMatchObject({ end: "", dropped: 1 });
  });
  it("소문자 접두도 붙잡았다가 판정한다 — mediation 은 콜론 자리에서 풀려난다", () => {
    expect(stream(["medi", "ation"]).out).toEqual(["", "mediation"]);
    expect(stream(["medi"])).toEqual({ out: [""], end: "medi", dropped: 0 });
  });
  it("MEDIA 와 콜론 사이 공백은 보통 줄이다(코어와 같다)", () => {
    expect(joined(stream(["MEDIA", " :/Users/x\n"]))).toBe("MEDIA :/Users/x\n");
  });
  it("endMediaLineFilter 뒤 상태는 처음으로 돌아간다 — 붙잡은 것도 줄 가운데 표시도 남지 않는다", () => {
    const f = createMediaLineFilter();
    expect(feedMediaLineFilter(f, "MEDI")).toBe("");
    expect(endMediaLineFilter(f)).toBe("MEDI");
    expect(endMediaLineFilter(f)).toBe("");
    expect(feedMediaLineFilter(f, "줄 가운데")).toBe("줄 가운데");
    expect(endMediaLineFilter(f)).toBe("");
    expect(feedMediaLineFilter(f, "MEDIA:/Users/x\n다음")).toBe("다음");
  });
  it("여러 줄이 한 조각에 오면 MEDIA: 줄만 빠진다", () => {
    const r = stream(["가\nMEDIA:/a\n나\n  MEDIA: https://e.com/b.png\n다"]);
    expect(r.out).toEqual(["가\n나\n다"]);
    expect(r.dropped).toBe(2);
  });
});

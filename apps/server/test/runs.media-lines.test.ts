import { describe, expect, it } from "vitest";
import { stripMediaLines } from "../src/modules/runs/media-lines";

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
});

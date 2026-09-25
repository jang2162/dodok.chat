import { SEARCH_SNIPPET_CLOSE as C, SEARCH_SNIPPET_OPEN as O } from "@dodok/shared";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Snippet, snippetParts } from "./highlight";

describe("스니펫 표시 문자 → 조각", () => {
  it("STX·ETX 사이가 강조 조각", () => {
    expect(snippetParts(`…앞 ${O}배포${C} 뒤 ${O}배포${C}…`)).toEqual([
      { text: "…앞 ", mark: false },
      { text: "배포", mark: true },
      { text: " 뒤 ", mark: false },
      { text: "배포", mark: true },
      { text: "…", mark: false },
    ]);
  });

  it("짝이 맞지 않는 표시는 글자로 남기지 않는다 — 닫히지 않은 여는 표시는 끝까지 강조, 짝 없는 닫는 표시는 버린다", () => {
    expect(snippetParts(`a${C}b${O}c`)).toEqual([
      { text: "ab", mark: false },
      { text: "c", mark: true },
    ]);
    expect(snippetParts(`${O}${O}x${C}${C}`)).toEqual([{ text: "x", mark: true }]);
  });

  it("표시가 없으면 한 조각, 빈 문자열이면 없음", () => {
    expect(snippetParts("그냥 글")).toEqual([{ text: "그냥 글", mark: false }]);
    expect(snippetParts("")).toEqual([]);
  });
});

describe("<Snippet>", () => {
  it("강조는 <mark>, HTML 로 읽힐 문자열은 글자 그대로 나온다(Review Focus 4)", () => {
    const { container } = render(
      <Snippet text={`<img src=x onerror=alert(1)> ${O}<b>굵게</b>${C} &amp; "따옴표" %_*`} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe("<b>굵게</b>");
    expect(container.textContent).toBe(`<img src=x onerror=alert(1)> <b>굵게</b> &amp; "따옴표" %_*`);
  });
});

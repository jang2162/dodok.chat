import { Handle } from "@dodok/shared";
import { expect, it } from "vitest";
import { handleFrom } from "./handleFrom";

it.each([
  ["dev", "dev"],
  ["Main Agent", "main-agent"],
  ["a", "a0"],
  ["--X__y--", "x__y"],
  // 한글 완성형 음절은 핸들 글자다 — 자모 단독·다른 문자는 -
  ["한글만", "한글만"],
  ["개발 봇", "개발-봇"],
  ["ㅋㅋ", "agent"],
  ["개발봇".normalize("NFD"), "개발봇"],
  ["x".repeat(40), "x".repeat(32)],
  // 32자로 자른 끝이 - 면 떼어 낸다
  [`${"a".repeat(31)} b`, "a".repeat(31)],
])("%s → %s", (input, out) => {
  expect(handleFrom(input)).toBe(out);
  expect(Handle.safeParse(handleFrom(input)).success).toBe(true);
});

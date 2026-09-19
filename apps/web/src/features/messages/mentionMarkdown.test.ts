import { expect, it } from "vitest";
import { MENTION_HREF_PREFIX, mentionsToMarkdown } from "./mentionMarkdown";

const A = "01a00000-0000-7000-8000-00000000000a";
it("토큰을 해시 링크로 바꾸고 모르는 id 는 알 수 없음", () => {
  const resolve = (k: "a" | "u", id: string) => (k === "a" && id === A ? "dev" : undefined);
  expect(mentionsToMarkdown(`<@a:${A}> 안녕 <@u:${A}>`, resolve)).toBe(
    `[@dev](${MENTION_HREF_PREFIX}a-${A}) 안녕 [@알 수 없음](${MENTION_HREF_PREFIX}u-${A})`,
  );
  // 본문이 흉내 낼 수 없게 페이지마다 뽑은 값이 붙는다
  expect(MENTION_HREF_PREFIX).toMatch(/^#mention-\d+-$/);
});

import { expect, it } from "vitest";
import { mentionsToMarkdown } from "./mentionMarkdown";

const A = "01a00000-0000-7000-8000-00000000000a";
it("토큰을 해시 링크로 바꾸고 모르는 id 는 알 수 없음", () => {
  const resolve = (k: "a" | "u", id: string) => (k === "a" && id === A ? "dev" : undefined);
  expect(mentionsToMarkdown(`<@a:${A}> 안녕 <@u:${A}>`, resolve)).toBe(
    `[@dev](#mention-a-${A}) 안녕 [@알 수 없음](#mention-u-${A})`,
  );
});

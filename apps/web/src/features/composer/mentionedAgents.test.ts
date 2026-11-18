import { describe, expect, it } from "vitest";
import { mentionedAgentIds } from "./mentionedAgents";

const mention = (id: string) => ({ type: "mention", attrs: { id, label: id } });

describe("mentionedAgentIds [작성기 도구 줄 스펙 T6]", () => {
  it("a: 멘션만 모은다 — 사람(u:)·글자 @ 는 뺀다", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [mention("a:A1"), { type: "text", text: " @A9 " }, mention("u:U1")] },
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [mention("a:A2")] }] }],
        },
      ],
    };
    expect(mentionedAgentIds(doc)).toEqual(new Set(["A1", "A2"]));
  });

  it("빈 문서는 빈 집합", () => {
    expect(mentionedAgentIds({ type: "doc", content: [{ type: "paragraph" }] })).toEqual(new Set());
    expect(mentionedAgentIds({ type: "doc" })).toEqual(new Set());
  });
});

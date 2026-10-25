import { formatReactionFacts, type InboundDeliver, type InboundReaction } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { buildInboundText, channelPromptContext, formatInboundContext } from "../src/context";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const deliver: InboundDeliver = {
  deliveryId: "01a09fc9-d204-7551-89d6-38544d07a101",
  kind: "message",
  channelId: CH,
  conversationId: CH,
  agentId: "researcher",
  sessionKey: `agent:researcher:dodok:channel:${CH}`,
  runId: "01a09fc9-d204-7551-89d6-38544d07a103",
  message: {
    id: "01a09fc9-d204-7551-89d6-38544d07a104",
    author: { type: "user", handle: "jang", displayName: "장병현" },
    text: "@researcher 이 버그 원인 찾아줘",
    attachments: [],
    ts: "2026-09-14T00:14:00Z",
  },
  context: {
    recentMessages: [
      {
        author: { type: "user", handle: "jang", displayName: "장병현" },
        text: "로그인이 가끔 실패해",
        ts: "2026-09-14T00:12:00Z",
      },
      {
        author: { type: "agent", handle: "planner", displayName: "Planner" },
        text: "재현 조건을 모아보죠",
        ts: "2026-09-14T00:13:00Z",
      },
    ],
    participants: [
      { type: "user", handle: "jang", displayName: "장병현", isSelf: false },
      { type: "agent", handle: "researcher", displayName: "Researcher", isSelf: true },
      { type: "agent", handle: "planner", displayName: "Planner", isSelf: false },
    ],
    relayRules:
      "다른 에이전트에게 일을 넘길 때만 @핸들을 쓰세요 — @멘션하면 그 에이전트가 이어받습니다(최대 4턴). 언급만 할 때는 @ 없이 이름만 쓰세요.",
    channelPrompt: "이 채널은 버그 분류용입니다.",
    promptOverride: "간결하게 답하세요.",
  },
  options: {},
};

describe("formatInboundContext", () => {
  it("스펙 8.3 형식 (Asia/Seoul 시각) — channelPrompt·promptOverride 줄은 헤더에 넣지 않는다", () => {
    expect(formatInboundContext(deliver, { timeZone: "Asia/Seoul" })).toBe(
      [
        `[dodok context] channel=${CH} you=@researcher`,
        "참여자: @jang(사람), @researcher(에이전트, 나), @planner(에이전트)",
        "릴레이 규칙: 다른 에이전트에게 일을 넘길 때만 @핸들을 쓰세요 — @멘션하면 그 에이전트가 이어받습니다(최대 4턴). 언급만 할 때는 @ 없이 이름만 쓰세요.",
        "최근 대화:",
        "[09:12] @jang: 로그인이 가끔 실패해",
        "[09:13] @planner: 재현 조건을 모아보죠",
        "---",
      ].join("\n"),
    );
  });
  it("최근 대화가 없으면 그 절이 빠진다", () => {
    const out = formatInboundContext({ ...deliver, context: { ...deliver.context, recentMessages: [] } });
    expect(out).not.toContain("최근 대화:");
    expect(out.endsWith("---")).toBe(true);
  });
  it("기본 시간대는 UTC", () => {
    expect(formatInboundContext(deliver)).toContain("[00:12] @jang");
  });
});

describe("formatInboundContext 리액션", () => {
  const REACTIONS: InboundReaction[] = [
    {
      messageId: "01a09fc9-d204-7551-89d6-38544d07a110",
      excerpt: "재현 조건",
      emoji: "👍",
      by: "jang",
      at: "2026-09-14T00:15:00Z",
    },
    {
      messageId: "01a09fc9-d204-7551-89d6-38544d07a111",
      excerpt: "원인 후보",
      emoji: "🎉",
      by: "mia",
      at: "2026-09-14T00:16:00Z",
    },
  ];
  const withReactions = (reactions?: InboundReaction[], reactionsOmitted?: number): InboundDeliver => ({
    ...deliver,
    context: { ...deliver.context, reactions, reactionsOmitted },
  });

  it("리액션이 있으면 `---` 바로 앞에 formatReactionFacts 결과를 줄째로 싣는다", () => {
    const lines = formatInboundContext(withReactions(REACTIONS, 3), { timeZone: "Asia/Seoul" }).split("\n");
    const facts = formatReactionFacts(REACTIONS, 3).split("\n");
    expect(lines.at(-1)).toBe("---");
    expect(lines.slice(-1 - facts.length, -1)).toEqual(facts);
  });
  it("없거나 빈 배열이면 반응 줄이 없고 헤더는 이전과 글자까지 같다", () => {
    const base = formatInboundContext(deliver, { timeZone: "Asia/Seoul" });
    expect(formatInboundContext(withReactions(undefined), { timeZone: "Asia/Seoul" })).toBe(base);
    expect(formatInboundContext(withReactions([], 2), { timeZone: "Asia/Seoul" })).toBe(base);
    expect(base).not.toContain("반응(");
  });
});

describe("formatInboundContext 스레드", () => {
  const ROOT = "01a09fc9-d204-7551-89d6-38544d07a1aa";
  const threaded: InboundDeliver = {
    ...deliver,
    sessionKey: `agent:researcher:dodok:channel:${CH}:thread:${ROOT}`,
    threadId: ROOT,
    context: {
      ...deliver.context,
      thread: {
        root: {
          author: { type: "user", handle: "jang", displayName: "장병현" },
          text: "배포 순서 정리하자",
          ts: "2026-09-14T00:10:00Z",
        },
        recentMessages: [
          {
            author: { type: "agent", handle: "planner", displayName: "Planner" },
            text: "DB 먼저요",
            ts: "2026-09-14T00:11:00Z",
          },
        ],
      },
    },
  };

  it("스레드 루트·스레드 최근 줄을 싣고 채널 최근 대화는 싣지 않는다", () => {
    expect(formatInboundContext(threaded, { timeZone: "Asia/Seoul" })).toBe(
      [
        `[dodok context] channel=${CH} thread=${ROOT} you=@researcher`,
        "참여자: @jang(사람), @researcher(에이전트, 나), @planner(에이전트)",
        "릴레이 규칙: 다른 에이전트에게 일을 넘길 때만 @핸들을 쓰세요 — @멘션하면 그 에이전트가 이어받습니다(최대 4턴). 언급만 할 때는 @ 없이 이름만 쓰세요.",
        "스레드 루트: [09:10] @jang: 배포 순서 정리하자",
        "스레드 최근:",
        "[09:11] @planner: DB 먼저요",
        "---",
      ].join("\n"),
    );
  });

  it("스레드 런에서도 리액션 블록이 `---` 바로 앞에 실린다", () => {
    const reactions: InboundReaction[] = [
      {
        messageId: "01a09fc9-d204-7551-89d6-38544d07a110",
        excerpt: "DB 먼저요",
        emoji: "👍",
        by: "jang",
        at: "2026-09-14T00:15:00Z",
      },
    ];
    const lines = formatInboundContext(
      { ...threaded, context: { ...threaded.context, reactions, reactionsOmitted: 2 } },
      { timeZone: "Asia/Seoul" },
    ).split("\n");
    const facts = formatReactionFacts(reactions, 2).split("\n");
    expect(lines.at(-1)).toBe("---");
    expect(lines.slice(-1 - facts.length, -1)).toEqual(facts);
    expect(lines).toContain("스레드 루트: [09:10] @jang: 배포 순서 정리하자");
  });

  it("스레드 최근 메시지가 없으면 그 줄이 빠진다", () => {
    const out = formatInboundContext({
      ...threaded,
      context: { ...threaded.context, thread: { ...threaded.context.thread!, recentMessages: [] } },
    });
    expect(out).toContain("스레드 루트: [00:10] @jang: 배포 순서 정리하자");
    expect(out).not.toContain("스레드 최근:");
    expect(out).not.toContain("최근 대화:");
  });
});

describe("buildInboundText", () => {
  it("헤더 다음 줄에 본문", () => {
    const out = buildInboundText(deliver);
    expect(out.endsWith("---\n@researcher 이 버그 원인 찾아줘")).toBe(true);
  });
});

describe("channelPromptContext", () => {
  it("channelPrompt·promptOverride 를 이 순서로 ChannelPromptContext 항목에 담는다", () => {
    expect(channelPromptContext(deliver)).toEqual([
      "채널 프롬프트: 이 채널은 버그 분류용입니다.",
      "채널 지시: 간결하게 답하세요.",
    ]);
  });
  it("하나만 있으면 그 항목만", () => {
    expect(
      channelPromptContext({ ...deliver, context: { ...deliver.context, promptOverride: undefined } }),
    ).toEqual(["채널 프롬프트: 이 채널은 버그 분류용입니다."]);
    expect(
      channelPromptContext({ ...deliver, context: { ...deliver.context, channelPrompt: undefined } }),
    ).toEqual(["채널 지시: 간결하게 답하세요."]);
  });
  it("둘 다 없으면 undefined", () => {
    expect(
      channelPromptContext({
        ...deliver,
        context: { ...deliver.context, channelPrompt: undefined, promptOverride: undefined },
      }),
    ).toBeUndefined();
  });
});

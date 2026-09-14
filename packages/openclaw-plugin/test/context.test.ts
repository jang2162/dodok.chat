import type { InboundDeliver } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { buildInboundText, formatInboundContext, placeChannelPrompt } from "../src/context";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const deliver: InboundDeliver = {
  deliveryId: "01a09fc9-d204-7551-89d6-38544d07a101",
  kind: "message",
  channelId: CH,
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
    relayRules: "다른 에이전트를 @멘션하면 그 에이전트가 이어받습니다. 최대 4턴.",
    channelPrompt: "이 채널은 버그 분류용입니다.",
    promptOverride: "간결하게 답하세요.",
  },
  options: {},
};

describe("formatInboundContext", () => {
  it("스펙 8.3 형식 (Asia/Seoul 시각, channelPrompt 기본 제외)", () => {
    expect(formatInboundContext(deliver, { timeZone: "Asia/Seoul" })).toBe(
      [
        `[dodok context] channel=${CH} you=@researcher`,
        "참여자: @jang(사람), @researcher(에이전트, 나), @planner(에이전트)",
        "릴레이 규칙: 다른 에이전트를 @멘션하면 그 에이전트가 이어받습니다. 최대 4턴.",
        "채널 지시: 간결하게 답하세요.",
        "최근 대화:",
        "[09:12] @jang: 로그인이 가끔 실패해",
        "[09:13] @planner: 재현 조건을 모아보죠",
        "---",
      ].join("\n"),
    );
  });
  it("includeChannelPrompt면 채널 프롬프트 줄이 참여자 줄 다음에 온다", () => {
    const out = formatInboundContext(deliver, { includeChannelPrompt: true });
    expect(out.split("\n")[3]).toBe("채널 프롬프트: 이 채널은 버그 분류용입니다.");
  });
  it("최근 대화가 없으면 그 절이 빠진다", () => {
    const out = formatInboundContext({
      ...deliver,
      context: { ...deliver.context, recentMessages: [], promptOverride: undefined },
    });
    expect(out).not.toContain("최근 대화:");
    expect(out).not.toContain("채널 지시:");
    expect(out.endsWith("---")).toBe(true);
  });
  it("기본 시간대는 UTC", () => {
    expect(formatInboundContext(deliver)).toContain("[00:12] @jang");
  });
});

describe("buildInboundText", () => {
  it("헤더 다음 줄에 본문", () => {
    const out = buildInboundText(deliver);
    expect(out.endsWith("---\n@researcher 이 버그 원인 찾아줘")).toBe(true);
  });
});

describe("placeChannelPrompt", () => {
  it("모드가 없으면 채널 프롬프트를 인바운드에 싣지 않는다 (Gateway 설정 systemPrompt 경로만)", () => {
    expect(placeChannelPrompt(deliver, undefined)).toEqual({ contextOptions: {} });
  });
  it("prefix 면 컨텍스트 헤더에 채널 프롬프트 줄을 넣는다 (계획서 5.2 (b))", () => {
    expect(placeChannelPrompt(deliver, "prefix")).toEqual({ contextOptions: { includeChannelPrompt: true } });
  });
  it("context 면 헤더 대신 ChannelPromptContext 항목 한 줄로 넘긴다", () => {
    expect(placeChannelPrompt(deliver, "context")).toEqual({
      contextOptions: {},
      channelPromptContext: ["채널 프롬프트: 이 채널은 버그 분류용입니다."],
    });
  });
  it("인바운드에 channelPrompt 가 없으면 모드와 무관하게 싣지 않는다", () => {
    const bare = { ...deliver, context: { ...deliver.context, channelPrompt: undefined } };
    expect(placeChannelPrompt(bare, "prefix")).toEqual({ contextOptions: {} });
    expect(placeChannelPrompt(bare, "context")).toEqual({ contextOptions: {} });
  });
});

import type { InboundDeliver } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { buildInboundText } from "../src/context";
import { dodokSessionKey, toDeliverResult, toInboundFacts } from "../src/inbound";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";

function deliver(overrides: Partial<InboundDeliver> = {}): InboundDeliver {
  return {
    deliveryId: "01a09fc9-d204-7551-89d6-38544d07a101",
    kind: "message",
    channelId: CH,
    agentId: "main",
    sessionKey: `agent:main:dodok:channel:${CH}`,
    runId: "01a09fc9-d204-7551-89d6-38544d07a103",
    message: {
      id: "01a09fc9-d204-7551-89d6-38544d07a104",
      author: { type: "user", handle: "jang", displayName: "장병현" },
      text: "@main Reply with exactly: PONG",
      attachments: [],
      ts: "2026-09-15T00:14:00Z",
    },
    context: {
      recentMessages: [],
      participants: [
        { type: "user", handle: "jang", displayName: "장병현", isSelf: false },
        { type: "agent", handle: "main", displayName: "Main", isSelf: true },
      ],
      relayRules: "최대 4턴",
    },
    options: {},
    ...overrides,
  };
}

describe("dodokSessionKey", () => {
  it("계획서 5.8 형식", () => {
    expect(dodokSessionKey("main", CH)).toBe(`agent:main:dodok:channel:${CH}`);
  });
});

describe("toInboundFacts", () => {
  it("사람 인바운드 → 디스패치 입력 (봇 루프 사실 없음)", () => {
    const d = deliver();
    const res = toInboundFacts(d, { accountId: "default" });
    expect(res).toEqual({
      ok: true,
      facts: {
        accountId: "default",
        channelId: CH,
        agentId: "main",
        sessionKey: `agent:main:dodok:channel:${CH}`,
        target: `channel:${CH}`,
        messageId: d.message.id,
        timestamp: Date.parse("2026-09-15T00:14:00Z"),
        sender: { id: "user:jang", name: "장병현", isBot: false },
        body: buildInboundText(d),
        rawBody: "@main Reply with exactly: PONG",
        correlation: { deliveryId: d.deliveryId, runId: d.runId, replyToInboundId: d.message.id },
      },
    });
  });

  it("에이전트 작성자면 봇 루프 보호 사실(scope·대화·쌍·eventId)을 싣는다", () => {
    const d = deliver({
      agentId: "fin",
      sessionKey: `agent:fin:dodok:channel:${CH}`,
      message: {
        id: "01a09fc9-d204-7551-89d6-38544d07a105",
        author: { type: "agent", handle: "main", displayName: "Main" },
        text: "@fin PONG 을 받았어, 이어서 한 줄 요약해 줘",
        attachments: [],
        ts: "2026-09-15T00:15:00Z",
      },
      context: {
        recentMessages: [],
        participants: [
          { type: "agent", handle: "main", displayName: "Main", isSelf: false },
          { type: "agent", handle: "fin", displayName: "Fin", isSelf: true },
        ],
        relayRules: "최대 4턴",
      },
    });
    const res = toInboundFacts(d, { accountId: "default" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.facts.sender).toEqual({ id: "agent:main", name: "Main", isBot: true });
    expect(res.facts.botLoopProtection).toEqual({
      scopeId: "default",
      conversationId: CH,
      senderId: "agent:main",
      receiverId: "agent:fin",
      eventId: d.deliveryId,
    });
  });

  it("세션 키가 agentId·channelId 와 어긋나면 거부한다", () => {
    const res = toInboundFacts(deliver({ sessionKey: `agent:other:dodok:channel:${CH}` }), {
      accountId: "default",
    });
    expect(res).toEqual({
      ok: false,
      error: `sessionKey 불일치: 기대 agent:main:dodok:channel:${CH}, 받음 agent:other:dodok:channel:${CH}`,
    });
  });

  it("세션 키에 접미사(:g2, :thread:1 등)가 붙어 있으면 거부한다 — 채널당 에이전트별 1세션 원형만 받는다", () => {
    for (const suffix of [":g2", ":g3", ":thread:1", ":", "x"]) {
      const res = toInboundFacts(deliver({ sessionKey: `agent:main:dodok:channel:${CH}${suffix}` }), {
        accountId: "default",
      });
      expect(res.ok).toBe(false);
    }
  });

  it("컨텍스트 포맷 옵션을 buildInboundText 로 넘긴다", () => {
    const d = deliver({
      context: {
        ...deliver().context,
        recentMessages: [
          {
            author: { type: "user", handle: "jang", displayName: "장병현" },
            text: "안녕",
            ts: "2026-09-15T00:13:00Z",
          },
        ],
      },
    });
    const res = toInboundFacts(d, { accountId: "default", context: { timeZone: "Asia/Seoul" } });
    expect(res.ok && res.facts.body).toContain("[09:13] @jang: 안녕");
  });
});

describe("toDeliverResult", () => {
  it("런이 시작되면 dispatch + providerRunId(onAgentRunStart 로 본 runId)", () => {
    expect(toDeliverResult({ kind: "dispatch" }, "01a09fc9-d204-7551-89d6-38544d07a103")).toStrictEqual({
      admission: "dispatch",
      providerRunId: "01a09fc9-d204-7551-89d6-38544d07a103",
    });
  });

  it("코어가 dispatch 로 받았지만 runId 를 못 봤으면 providerRunId 를 생략한다", () => {
    expect(toDeliverResult({ kind: "dispatch" })).toStrictEqual({ admission: "dispatch" });
  });

  it("코어 drop 은 사유를 그대로 옮기고, 사유가 비면 unknown", () => {
    expect(toDeliverResult({ kind: "drop", reason: "bot-loop-protection" })).toStrictEqual({
      admission: "drop",
      reason: "bot-loop-protection",
    });
    expect(toDeliverResult({ kind: "drop", reason: " " })).toStrictEqual({
      admission: "drop",
      reason: "unknown",
    });
  });

  it("런 없이 끝나는 다른 kind(handled·observeOnly)도 drop — 사유에 kind 를 앞세운다", () => {
    expect(toDeliverResult({ kind: "handled", reason: "command" })).toStrictEqual({
      admission: "drop",
      reason: "handled:command",
    });
    expect(toDeliverResult({ kind: "observeOnly" })).toStrictEqual({
      admission: "drop",
      reason: "observeOnly",
    });
  });
});

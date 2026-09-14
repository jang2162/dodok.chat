import type { InboundDeliver } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { buildInboundText } from "../src/context";
import { dodokSessionKey, toInboundFacts } from "../src/inbound";

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

  it("세대 2 이상이면 :g<N> 을 붙인다 (채널 프롬프트가 바뀌면 새 세션으로 회전 — 스파이크 3 P6)", () => {
    expect(dodokSessionKey("main", CH, 1)).toBe(`agent:main:dodok:channel:${CH}`);
    expect(dodokSessionKey("main", CH, 2)).toBe(`agent:main:dodok:channel:${CH}:g2`);
  });

  it("세대는 1 이상의 정수여야 한다", () => {
    expect(() => dodokSessionKey("main", CH, 0)).toThrow();
    expect(() => dodokSessionKey("main", CH, 1.5)).toThrow();
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

  it("세대 회전 키(:g<N>)는 받아들이고 facts.sessionKey 에 그대로 싣는다", () => {
    const res = toInboundFacts(deliver({ sessionKey: `agent:main:dodok:channel:${CH}:g3` }), {
      accountId: "default",
    });
    expect(res.ok && res.facts.sessionKey).toBe(`agent:main:dodok:channel:${CH}:g3`);
  });

  it("세대 접미사가 :g<N>(N≥2) 모양이 아니면 거부한다", () => {
    for (const suffix of [":g1", ":g0", ":gx", ":thread:1", ":g2:extra"]) {
      const res = toInboundFacts(deliver({ sessionKey: `agent:main:dodok:channel:${CH}${suffix}` }), {
        accountId: "default",
      });
      expect(res.ok).toBe(false);
    }
  });

  it("컨텍스트 포맷 옵션을 buildInboundText 로 넘긴다", () => {
    const d = deliver({ context: { ...deliver().context, channelPrompt: "채널 P" } });
    const res = toInboundFacts(d, { accountId: "default", context: { includeChannelPrompt: true } });
    expect(res.ok && res.facts.body).toContain("채널 프롬프트: 채널 P");
  });
});

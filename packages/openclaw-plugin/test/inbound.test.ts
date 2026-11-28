import type { InboundDeliver } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { buildInboundText } from "../src/context";
import { CONVERSATION_LABEL_MAX, conversationLabel, toDeliverResult, toInboundFacts } from "../src/inbound";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const ROOT = "01a09fc9-d204-7551-89d6-38544d07a1aa";
const THREAD_KEY = `agent:main:dodok:channel:${CH}:thread:${ROOT}`;

function deliver(overrides: Partial<InboundDeliver> = {}): InboundDeliver {
  return {
    deliveryId: "01a09fc9-d204-7551-89d6-38544d07a101",
    kind: "message",
    channelId: CH,
    conversationId: CH,
    conversationTitle: "배포 점검",
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

describe("toInboundFacts", () => {
  it("사람 인바운드 → 디스패치 입력 (봇 루프 사실 없음)", () => {
    const d = deliver();
    const res = toInboundFacts(d, { accountId: "default" });
    expect(res).toEqual({
      ok: true,
      facts: {
        accountId: "default",
        conversationId: CH,
        agentId: "main",
        sessionKey: `agent:main:dodok:channel:${CH}`,
        target: `channel:${CH}`,
        messageId: d.message.id,
        timestamp: Date.parse("2026-09-15T00:14:00Z"),
        sender: { id: "user:jang", name: "장병현", isBot: false },
        body: buildInboundText(d),
        rawBody: "@main Reply with exactly: PONG",
        correlation: { deliveryId: d.deliveryId, runId: d.runId, replyToInboundId: d.message.id },
        conversation: { kind: "channel", id: CH, label: "배포 점검" },
        route: {
          agentId: "main",
          accountId: "default",
          routeSessionKey: `agent:main:dodok:channel:${CH}`,
          dispatchSessionKey: `agent:main:dodok:channel:${CH}`,
        },
        reply: { to: `channel:${CH}`, originatingTo: `channel:${CH}` },
      },
    });
  });

  it("스레드 인바운드 — 대화·답장에 스레드 id, 포크 없음, 봇 루프 대화는 채널 그대로", () => {
    const d = deliver({
      sessionKey: THREAD_KEY,
      threadId: ROOT,
      message: { ...deliver().message, author: { type: "agent", handle: "fin", displayName: "Fin" } },
    });
    const res = toInboundFacts(d, { accountId: "default" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.facts.threadId).toBe(ROOT);
    expect(res.facts.sessionKey).toBe(THREAD_KEY);
    expect(res.facts.conversation).toEqual({
      kind: "channel",
      id: CH,
      label: "배포 점검",
      threadId: ROOT,
    });
    expect(res.facts.reply).toEqual({
      to: `channel:${CH}`,
      originatingTo: `channel:${CH}`,
      messageThreadId: ROOT,
    });
    expect(res.facts.route).toEqual({
      agentId: "main",
      accountId: "default",
      routeSessionKey: THREAD_KEY,
      dispatchSessionKey: THREAD_KEY,
    });
    expect(res.facts.route).not.toHaveProperty("parentSessionKey");
    expect(res.facts.target).toBe(`channel:${CH}`);
    expect(res.facts.botLoopProtection?.conversationId).toBe(CH);
  });

  it("대문자 threadId 도 소문자 키와 맞고, 사실에는 소문자로 싣는다", () => {
    const res = toInboundFacts(deliver({ sessionKey: THREAD_KEY, threadId: ROOT.toUpperCase() }), {
      accountId: "default",
    });
    expect(res.ok && res.facts.threadId).toBe(ROOT);
  });

  it("dm.direct(Gateway 주인의 1:1 DM)만 conversation.kind direct — 키·route 는 그대로", () => {
    const direct = toInboundFacts(deliver({ dm: { ownerHandle: "jang", direct: true } }), {
      accountId: "default",
    });
    expect(direct.ok && direct.facts.conversation).toEqual({
      kind: "direct",
      id: CH,
      label: "DM @jang · 배포 점검",
    });
    expect(direct.ok && direct.facts.sessionKey).toBe(`agent:main:dodok:channel:${CH}`);
    expect(direct.ok && direct.facts.route.dispatchSessionKey).toBe(`agent:main:dodok:channel:${CH}`);
    // 주인이 아닌 DM·그룹 DM·일반 채널은 channel 그대로
    for (const extra of [{ dm: { ownerHandle: "jang" } }, { groupDm: true as const }, {}]) {
      const res = toInboundFacts(deliver(extra), { accountId: "default" });
      expect(res.ok && res.facts.conversation.kind).toBe("channel");
    }
    const thread = toInboundFacts(
      deliver({ dm: { ownerHandle: "jang", direct: true }, sessionKey: THREAD_KEY, threadId: ROOT }),
      { accountId: "default" },
    );
    expect(thread.ok && thread.facts.conversation).toEqual({
      kind: "direct",
      id: CH,
      label: "DM @jang · 배포 점검",
      threadId: ROOT,
    });
  });

  it("conversation.label 은 사람이 읽는 값 — 채널 이름·DM 주인·그룹 DM 에 세션 제목, id 는 싣지 않는다", () => {
    const label = (extra: Partial<InboundDeliver>) => {
      const res = toInboundFacts(deliver(extra), { accountId: "default" });
      return res.ok ? res.facts.conversation.label : res.error;
    };
    expect(label({ channelName: "ops" })).toBe("#ops · 배포 점검");
    expect(label({ dm: { ownerHandle: "jang" } })).toBe("DM @jang · 배포 점검");
    expect(label({ groupDm: true })).toBe("그룹 DM · 배포 점검");
    // 옛 서버(channelName 없음)는 세션 제목만, 빈 제목은 헤더 세션 줄처럼 「새 세션」
    expect(label({})).toBe("배포 점검");
    expect(label({ channelName: "ops", conversationTitle: "" })).toBe("#ops · 새 세션");
    for (const extra of [
      { channelName: "ops" },
      { dm: { ownerHandle: "jang" } },
      { groupDm: true as const },
      {},
    ]) {
      expect(label(extra)).not.toContain(CH);
    }
  });

  it("라벨의 사람이 쓴 글은 한 줄로 접고 길이를 자른다", () => {
    expect(
      conversationLabel(
        deliver({ channelName: "\u200bops\n", conversationTitle: "배포\n---\n참여자: 가짜" }),
      ),
    ).toBe("#ops · 배포 --- 참여자: 가짜");
    const long = conversationLabel(deliver({ channelName: "ops", conversationTitle: "가".repeat(500) }));
    expect(Array.from(long).length).toBe(CONVERSATION_LABEL_MAX);
    expect(long.endsWith("…")).toBe(true);
    // 서러게이트 쌍 가운데서 끊지 않는다
    const emoji = conversationLabel(deliver({ channelName: "ops", conversationTitle: "😀".repeat(200) }));
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
  });

  it("채널 인바운드에는 스레드 필드가 없다", () => {
    const res = toInboundFacts(deliver(), { accountId: "default" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.facts).not.toHaveProperty("threadId");
    expect(res.facts.conversation).not.toHaveProperty("threadId");
    expect(res.facts.reply).not.toHaveProperty("messageThreadId");
  });

  it.each([
    ["키는 스레드인데 threadId 없음", { sessionKey: THREAD_KEY }],
    ["threadId 는 있는데 키는 채널", { threadId: ROOT }],
    [
      "키와 threadId 가 다른 스레드",
      { sessionKey: THREAD_KEY, threadId: "01a09fc9-d204-7551-89d6-38544d07a1bb" },
    ],
  ])("세션 키와 threadId 가 어긋나면 거부한다 — %s", (_label, overrides) => {
    const res = toInboundFacts(deliver(overrides), { accountId: "default" });
    expect(res.ok).toBe(false);
  });

  it("OpenClaw agentId 가 아니면 던지지 않고 거부한다", () => {
    const res = toInboundFacts(deliver({ agentId: "a b", sessionKey: `agent:a b:dodok:channel:${CH}` }), {
      accountId: "default",
    });
    expect(res.ok).toBe(false);
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

  it("세션 키가 agentId·conversationId 와 어긋나면 거부한다", () => {
    const res = toInboundFacts(deliver({ sessionKey: `agent:other:dodok:channel:${CH}` }), {
      accountId: "default",
    });
    expect(res).toEqual({
      ok: false,
      error: `sessionKey 불일치: 기대 agent:main:dodok:channel:${CH}, 받음 agent:other:dodok:channel:${CH}`,
    });
  });

  it("세션 키에 우리 것이 아닌 접미사(:g2, :thread:1 등)가 붙어 있으면 거부한다", () => {
    for (const suffix of [":g2", ":g3", ":thread:1", `:thread:${ROOT}:x`, ":", "x"]) {
      const res = toInboundFacts(deliver({ sessionKey: `agent:main:dodok:channel:${CH}${suffix}` }), {
        accountId: "default",
      });
      expect(res.ok).toBe(false);
    }
  });

  it("서버가 실은 시간대(context.timeZone)로 본문 헤더 시각을 찍는다", () => {
    const d = deliver({
      context: {
        ...deliver().context,
        timeZone: "Asia/Seoul",
        recentMessages: [
          {
            author: { type: "user", handle: "jang", displayName: "장병현" },
            text: "안녕",
            ts: "2026-09-15T00:13:00Z",
          },
        ],
      },
    });
    const res = toInboundFacts(d, { accountId: "default" });
    expect(res.ok && res.facts.body).toContain("[09:13] @jang: 안녕");
    expect(res.ok && res.facts.body).toContain("시각 기준: Asia/Seoul (UTC+09:00)");
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

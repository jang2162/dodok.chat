// channel.ts 는 SDK 를 import 한다 — 여기서는 핀 SDK(openclaw)의 실제 route 빌더를 그대로 부른다
import { CONVERSATION_ONLY_REASON, type InboundDeliver, type OutboundMessage } from "@dodok/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../src/bridge-client";
import {
  CHAT_KINDS_LIMIT,
  getConversationChatType,
  registerBridge,
  releaseBridge,
  setConversationChatType,
} from "../src/bridge-registry";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  DODOK_BRIDGE_CAPABILITIES,
  DODOK_COMMAND_INGRESS,
  dodokChannelPlugin,
  dodokIngressConversation,
  inboundTurnParts,
  routeInboundConversation,
} from "../src/channel";
import { THREAD_ONLY_REASON } from "../src/outbound";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const OTHER_CH = "01a09fc9-d204-7551-89d6-38544d07a1cc";
const ROOT = "01a09fc9-d204-7551-89d6-38544d07a1aa";
const CHANNEL_KEY = `agent:main:dodok:channel:${CH}`;
const THREAD_KEY = `${CHANNEL_KEY}:thread:${ROOT}`;

type Plugin = {
  messaging: {
    resolveOutboundSessionRoute: (
      params: Record<string, unknown>,
    ) => { sessionKey: string; chatType: string; peer: { kind: string; id: string } } | null;
  };
  actions: { handleAction: (ctx: Record<string, unknown>) => Promise<unknown> };
  outbound: { sendText: (ctx: Record<string, unknown>) => Promise<{ messageId: string }> };
};
const plugin = dodokChannelPlugin as unknown as Plugin;

let sent: OutboundMessage[];
let bridge: BridgeClient;

beforeEach(() => {
  sent = [];
  bridge = {
    sendOutbound: async (message: OutboundMessage) => {
      sent.push(message);
      return { messageId: `m${sent.length}` };
    },
  } as unknown as BridgeClient;
  registerBridge("default", bridge);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  releaseBridge("default", bridge);
  vi.restoreAllMocks();
});

describe("resolveOutboundSessionRoute — 스레드 인식(ADR 0006 「아웃바운드와 delivery-mirror 누수」 절)", () => {
  const route = (params: Record<string, unknown>) =>
    plugin.messaging.resolveOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: `channel:${CH}`,
      ...params,
    });

  it("스레드 세션의 같은 채널 전송은 스레드 세션 키로 — mirror 가 채널 전사에 새지 않는다", () => {
    expect(route({ currentSessionKey: THREAD_KEY })?.sessionKey).toBe(THREAD_KEY);
  });

  it("threadId 가 먼저다 — 세션 문맥이 없는 코어 전송도 스레드로", () => {
    expect(route({ threadId: ROOT.toUpperCase() })?.sessionKey).toBe(THREAD_KEY);
  });

  it("스레드 세션에 다른 threadId 가 오면 그 다른 스레드 키 — precedence 가 threadId 먼저임을 고정한다", () => {
    const otherRoot = "01a09fc9-d204-7551-89d6-38544d07a1bb";
    expect(route({ currentSessionKey: THREAD_KEY, threadId: otherRoot })?.sessionKey).toBe(
      `${CHANNEL_KEY}:thread:${otherRoot}`,
    );
  });

  it("replyToId(인바운드 메시지 id)로는 스레드를 만들지 않는다 — 기본 precedence 를 쓰지 않는다", () => {
    expect(route({ currentSessionKey: THREAD_KEY, replyToId: OTHER_CH })?.sessionKey).toBe(THREAD_KEY);
    expect(route({ replyToId: OTHER_CH })?.sessionKey).toBe(CHANNEL_KEY);
  });

  it("채널 세션은 threadId 인자가 있어도 채널 키 — handleAction 이 그 인자를 쓰지 않는 것과 맞춘다", () => {
    expect(route({ currentSessionKey: CHANNEL_KEY, threadId: ROOT })?.sessionKey).toBe(CHANNEL_KEY);
    expect(route({ currentSessionKey: CHANNEL_KEY })?.sessionKey).toBe(CHANNEL_KEY);
  });

  it("다른 채널 대상이면 그 채널 키 — 스레드를 끌고 가지 않는다", () => {
    expect(route({ currentSessionKey: THREAD_KEY, target: `channel:${OTHER_CH}` })?.sessionKey).toBe(
      `agent:main:dodok:channel:${OTHER_CH}`,
    );
  });

  it("dodok 대상이 아니면 null", () => {
    expect(route({ target: "channel:general" })).toBeNull();
  });
  it("인바운드가 direct 로 넘긴 대화는 chatType 만 direct — peer 는 channel, 키는 그대로(main 으로 가지 않는다)", () => {
    const DM = "01a09fc9-d204-7551-89d6-38544d07a1dd";
    expect(route({ target: `channel:${DM}` })).toMatchObject({ chatType: "channel" });
    setConversationChatType(DM, "direct");
    const r = route({ target: `channel:${DM}`, currentSessionKey: `agent:main:dodok:channel:${DM}` });
    expect(r).toMatchObject({
      chatType: "direct",
      peer: { kind: "channel", id: DM },
      sessionKey: `agent:main:dodok:channel:${DM}`,
    });
    // 다음 인바운드가 channel 이면(주인이 바뀌었다) 되돌린다
    setConversationChatType(DM, "channel");
    expect(route({ target: `channel:${DM}` })).toMatchObject({ chatType: "channel" });
    expect(route({})).toMatchObject({ chatType: "channel" });
  });

  it("상한으로 맵에서 밀려난 direct 대화는 channel 로 떨어진다 — 세션 키·peer 는 그대로", () => {
    const DM = "01a09fc9-d204-7551-89d6-38544d07a1ee";
    const key = `agent:main:dodok:channel:${DM}`;
    setConversationChatType(DM, "direct");
    expect(route({ target: `channel:${DM}`, currentSessionKey: key })).toMatchObject({ chatType: "direct" });
    for (let n = 0; n < CHAT_KINDS_LIMIT; n++) setConversationChatType(`filler-${n}`, "channel");
    expect(route({ target: `channel:${DM}`, currentSessionKey: key })).toMatchObject({
      chatType: "channel",
      peer: { kind: "channel", id: DM },
      sessionKey: key,
    });
  });
});

describe("routeInboundConversation — dispatchInbound 가 ingress 에 넘기는 대화와 아웃바운드가 쓸 kind", () => {
  const facts = (kind: "channel" | "direct", conversationId: string) => ({
    conversationId,
    conversation: { kind, id: conversationId, label: conversationId },
  });

  it("direct facts 면 ingress 가 direct·allowFrom 을 받고, 그 대화의 kind 가 direct 로 적힌다", () => {
    const DM = "01a09fc9-d204-7551-89d6-38544d07a1f1";
    expect(routeInboundConversation(facts("direct", DM))).toEqual({
      conversation: { kind: "direct", id: DM },
      allowFrom: ["*"],
    });
    expect(getConversationChatType(DM)).toBe("direct");
  });

  it("channel facts 면 ingress 는 channel, 적힌 kind 도 channel 로 되돌린다", () => {
    const DM = "01a09fc9-d204-7551-89d6-38544d07a1f2";
    setConversationChatType(DM, "direct");
    expect(routeInboundConversation(facts("channel", DM))).toEqual({
      conversation: { kind: "channel", id: DM },
    });
    expect(getConversationChatType(DM)).toBe("channel");
  });
});

describe("dodokIngressConversation — direct 는 allowFrom 와일드카드를 함께(없으면 핀 SDK 가 drop)", () => {
  const ingress = (kind: "channel" | "direct", command = false) =>
    resolveStableChannelMessageIngress({
      channelId: "dodok",
      accountId: "default",
      cfg: {},
      identity: { key: "sender", entryIdPrefix: "dodok-entry" },
      subject: { stableId: "user:mia" },
      ...dodokIngressConversation({ kind, id: "c1" }),
      dmPolicy: "open",
      groupPolicy: "open",
      ...(command ? { command: { ...DODOK_COMMAND_INGRESS } } : {}),
    });

  it("channel 은 allowFrom 없이, direct 는 allowFrom ['*']", () => {
    expect(dodokIngressConversation({ kind: "channel", id: "c1" })).toEqual({
      conversation: { kind: "channel", id: "c1" },
    });
    expect(dodokIngressConversation({ kind: "direct", id: "c1" })).toEqual({
      conversation: { kind: "direct", id: "c1" },
      allowFrom: ["*"],
    });
  });

  it("핀 SDK — 둘 다 dispatch, 명령 갈래도 둘 다 authorized", async () => {
    for (const kind of ["channel", "direct"] as const) {
      expect((await ingress(kind)).ingress.admission).toBe("dispatch");
      expect((await ingress(kind, true)).commandAccess).toMatchObject({ requested: true, authorized: true });
    }
  });
});

describe("handleAction — 스레드 세션", () => {
  const act = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    plugin.actions.handleAction({
      channel: "dodok",
      action: "send",
      cfg: {},
      accountId: "default",
      agentId: "main",
      sessionKey: THREAD_KEY,
      params,
      ...extra,
    });

  it("세션 키에서 스레드를 풀어 OutboundMessage.threadId 에 싣는다", async () => {
    await act({ to: `channel:${CH}`, message: "스레드 답" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      conversationId: CH,
      threadId: ROOT,
      sessionKey: THREAD_KEY,
      text: "스레드 답",
    });
  });

  it.each([
    ["다른 채널", { to: `channel:${OTHER_CH}`, message: "x" }, CONVERSATION_ONLY_REASON],
    ["최상위를 뜻하는 threadId", { to: `channel:${CH}`, message: "x", threadId: "top" }, THREAD_ONLY_REASON],
  ])("%s — 고정 사유 ToolInputError, 전송 없음", async (_label, params, reason) => {
    await expect(act(params)).rejects.toMatchObject({ name: "ToolInputError", message: reason });
    expect(sent).toHaveLength(0);
  });

  it("[Review Focus 4] 채널 세션도 다른 대화(같은 채널의 다른 세션) 대상이면 고정 사유 ToolInputError, 전송 없음", async () => {
    await expect(
      act({ to: `channel:${OTHER_CH}`, message: "x" }, { sessionKey: CHANNEL_KEY }),
    ).rejects.toMatchObject({ name: "ToolInputError", message: CONVERSATION_ONLY_REASON });
    expect(sent).toHaveLength(0);
  });

  it("toolContext.currentThreadTs 는 대조만 — 다르면 warn 하고 세션 키대로 보낸다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await act({ message: "x" }, { toolContext: { currentThreadTs: OTHER_CH } });
    expect(sent[0]?.threadId).toBe(ROOT);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dodok:tool-send-thread-mismatch"));
  });

  it("toolContext.currentThreadTs 가 같으면(대소문자 무시) warn 하지 않는다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await act({ message: "x" }, { toolContext: { currentThreadTs: ROOT.toUpperCase() } });
    expect(warn).not.toHaveBeenCalled();
  });

  it("채널 세션 전송에는 threadId 가 없다", async () => {
    await act({ message: "x" }, { sessionKey: CHANNEL_KEY });
    expect(sent[0]).not.toHaveProperty("threadId");
  });
});

describe("sendText — 코어 일반 전송", () => {
  it("ctx.threadId 를 OutboundMessage.threadId 로 — 스레드 런의 오류 알림이 채널 최상위로 가지 않는다", async () => {
    await plugin.outbound.sendText({
      cfg: {},
      to: `channel:${CH}`,
      text: "오류",
      accountId: "default",
      threadId: ROOT,
    });
    expect(sent[0]).toMatchObject({
      conversationId: CH,
      threadId: ROOT,
      sessionKey: `agent:unknown:dodok:channel:${CH}:thread:${ROOT}`,
    });
  });

  it("threadId 가 없으면 채널로", async () => {
    await plugin.outbound.sendText({ cfg: {}, to: `channel:${CH}`, text: "x", accountId: "default" });
    expect(sent[0]).not.toHaveProperty("threadId");
    expect(sent[0]?.sessionKey).toBe(`agent:unknown:dodok:channel:${CH}`);
  });

  it("threadId 가 우리 id 가 아니면 보내지 않는다", async () => {
    await expect(
      plugin.outbound.sendText({
        cfg: {},
        to: `channel:${CH}`,
        text: "x",
        accountId: "default",
        threadId: 17,
      }),
    ).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});

describe("hello capabilities", () => {
  it("스레드와 제어 도구를 안다고 알린다 — control 이 없으면 서버가 control.call 을 거절한다", () => {
    expect(DODOK_BRIDGE_CAPABILITIES).toEqual([
      "run_id_in_outbound",
      "config.set",
      "threads",
      "control",
      "commands",
      "remoteUpdate",
      "threadUpdates",
      "outOfScope",
    ]);
  });

  it("hello capabilities include commands", () => {
    expect(DODOK_BRIDGE_CAPABILITIES).toContain("commands");
  });
});

describe("명령 갈래(에이전트 명령 스펙 5.4·C12)", () => {
  const delivery = (over: Partial<InboundDeliver> = {}): InboundDeliver =>
    ({
      deliveryId: "0192f000-0000-7000-8000-00000000d001",
      kind: "message",
      channelId: "0192f000-0000-7000-8000-00000000c001",
      conversationId: "0192f000-0000-7000-8000-00000000c001",
      conversationTitle: "대화",
      agentId: "dev",
      sessionKey: "agent:dev:dodok:channel:0192f000-0000-7000-8000-00000000c001",
      runId: "0192f000-0000-7000-8000-00000000a001",
      message: {
        id: "0192f000-0000-7000-8000-00000000b001",
        author: { type: "user", handle: "mia", displayName: "Mia" },
        text: "@dev /status",
        attachments: [],
        ts: "2026-11-21T00:00:00.000Z",
      },
      context: { recentMessages: [], participants: [], relayRules: "" },
      options: {},
      ...over,
    }) as InboundDeliver;
  const opts = {
    body: "[머리말]\n@dev /status",
    rawBody: "@dev /status",
    systemPrompt: "채널",
    promptContext: ["대화"],
  };

  it("command delivery enables command interpretation with raw body", () => {
    const parts = inboundTurnParts(delivery({ command: { name: "think", args: "high" } }), opts);
    expect(parts.message).toEqual({
      body: "/think high",
      bodyForAgent: "/think high",
      rawBody: "/think high",
      commandBody: "/think high",
    });
    // 해석을 켠다 — 머리말·대화 동봉 없음
    expect(parts.extra).toEqual({ GroupSystemPrompt: "채널" });
    expect(parts.extra).not.toHaveProperty("CommandInterpretationSuppressed");
    expect(parts.ingressCommand).toEqual(DODOK_COMMAND_INGRESS);
  });

  it("plain delivery keeps CommandInterpretationSuppressed", () => {
    const parts = inboundTurnParts(delivery(), opts);
    expect(parts.extra).toEqual({
      CommandInterpretationSuppressed: true,
      GroupSystemPrompt: "채널",
      ChannelPromptContext: ["대화"],
    });
    expect(parts.message).toEqual({
      body: opts.body,
      bodyForAgent: opts.body,
      rawBody: opts.rawBody,
      commandBody: opts.rawBody,
    });
    expect(parts.ingressCommand).toBeUndefined();
  });

  it('plain text "/model x" stays suppressed', () => {
    const plain = { body: "/model x", rawBody: "/model x" };
    const parts = inboundTurnParts(delivery({ message: { ...delivery().message, text: "/model x" } }), plain);
    expect(parts.extra.CommandInterpretationSuppressed).toBe(true);
    expect(parts.ingressCommand).toBeUndefined();
  });

  it("blocked openclaw command rejected", () => {
    expect(() => inboundTurnParts(delivery({ command: { name: "restart", args: "" } }), opts)).toThrow(
      /blocked command/,
    );
    expect(() => inboundTurnParts(delivery({ command: { name: "model", args: "opus -g" } }), opts)).toThrow();
    expect(() => inboundTurnParts(delivery({ command: { name: "new", args: "" } }), opts)).toThrow();
  });

  it("인자에 다른 `/` 지시어를 끼운 명령은 막는다 — Gateway 가 본문 어디서든 지시어를 뽑는다", () => {
    for (const command of [
      { name: "think", args: "high /elevated full" },
      { name: "verbose", args: "on /model x -g" },
      { name: "skill", args: "x\n/exec host=gateway" },
    ]) {
      expect(() => inboundTurnParts(delivery({ command }), opts)).toThrow(/다른 `\/` 명령/);
    }
    expect(
      inboundTurnParts(delivery({ command: { name: "skill", args: "review src/a.ts" } }), opts).message.body,
    ).toBe("/skill review src/a.ts");
  });

  it("핀 SDK 의 ingress — 명령 게이트를 주면 허가, 안 주면 게이트가 없다", async () => {
    const base = {
      channelId: "dodok",
      accountId: "default",
      cfg: {},
      identity: { key: "sender", entryIdPrefix: "dodok-entry" },
      subject: { stableId: "user:mia" },
      conversation: { kind: "channel" as const, id: "c1" },
      dmPolicy: "open" as const,
      groupPolicy: "open" as const,
    };
    const withCommand = await resolveStableChannelMessageIngress({
      ...base,
      command: { ...DODOK_COMMAND_INGRESS },
    });
    expect(withCommand.commandAccess).toMatchObject({ requested: true, authorized: true });
    const plain = await resolveStableChannelMessageIngress(base);
    expect(plain.commandAccess.authorized).toBe(false);
  });
});

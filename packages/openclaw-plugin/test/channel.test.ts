// channel.ts 는 SDK 를 import 한다 — 여기서는 핀 SDK(openclaw 2026.9.4)의 실제 route 빌더를 그대로 부른다
import type { OutboundMessage } from "@dodok/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../src/bridge-client";
import { registerBridge, releaseBridge } from "../src/bridge-registry";
import { DODOK_BRIDGE_CAPABILITIES, dodokChannelPlugin } from "../src/channel";
import { THREAD_ONLY_REASON } from "../src/outbound";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const OTHER_CH = "01a09fc9-d204-7551-89d6-38544d07a1cc";
const ROOT = "01a09fc9-d204-7551-89d6-38544d07a1aa";
const CHANNEL_KEY = `agent:main:dodok:channel:${CH}`;
const THREAD_KEY = `${CHANNEL_KEY}:thread:${ROOT}`;

type Plugin = {
  messaging: {
    resolveOutboundSessionRoute: (params: Record<string, unknown>) => { sessionKey: string } | null;
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
      channelId: CH,
      threadId: ROOT,
      sessionKey: THREAD_KEY,
      text: "스레드 답",
    });
  });

  it.each([
    ["다른 채널", { to: `channel:${OTHER_CH}`, message: "x" }],
    ["최상위를 뜻하는 threadId", { to: `channel:${CH}`, message: "x", threadId: "top" }],
  ])("%s — 고정 사유 ToolInputError, 전송 없음", async (_label, params) => {
    await expect(act(params)).rejects.toMatchObject({ name: "ToolInputError", message: THREAD_ONLY_REASON });
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
      channelId: CH,
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
    expect(DODOK_BRIDGE_CAPABILITIES).toEqual(["run_id_in_outbound", "config.set", "threads", "control"]);
  });
});

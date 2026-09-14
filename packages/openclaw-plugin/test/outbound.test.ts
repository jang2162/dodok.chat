import { OutboundMessage } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import {
  buildOutboundMessage,
  channelIdFromSessionKey,
  formatDodokTarget,
  messageToolSendToOutbound,
  parseDodokTarget,
  toolInputError,
} from "../src/outbound";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const RUN = "01a09fc9-d204-7551-89d6-38544d07a103";
const MSG = "01a09fc9-d204-7551-89d6-38544d07a104";
const NOW = new Date("2026-09-15T01:02:03.000Z");
const SESSION = `agent:main:dodok:channel:${CH}`;

describe("target 문법", () => {
  it("channel:<id>, dodok:channel:<id>, 맨 id 를 받는다", () => {
    expect(parseDodokTarget(`channel:${CH}`)).toBe(CH);
    expect(parseDodokTarget(`dodok:channel:${CH}`)).toBe(CH);
    expect(parseDodokTarget(` ${CH} `)).toBe(CH);
    expect(parseDodokTarget("channel:general")).toBeNull();
    expect(formatDodokTarget(CH)).toBe(`channel:${CH}`);
  });

  it("세션 키에서 채널 id 를 뽑는다", () => {
    expect(channelIdFromSessionKey(SESSION)).toBe(CH);
    expect(channelIdFromSessionKey(`agent:main:dodok:channel:${CH}:thread:x`)).toBe(CH);
    expect(channelIdFromSessionKey("agent:main:main")).toBeNull();
  });
});

describe("buildOutboundMessage", () => {
  it("평문 응답을 OutboundMessage 로 만든다", () => {
    const res = buildOutboundMessage({
      outboundId: "dodok-out-1",
      channelId: CH,
      agentId: "main",
      sessionKey: SESSION,
      text: "PONG",
      correlation: { runId: RUN, replyToInboundId: MSG, providerRunId: "oc-run-1" },
      now: NOW,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(OutboundMessage.parse(res.message)).toEqual(res.message);
    expect(res.message).toEqual({
      outboundId: "dodok-out-1",
      channelId: CH,
      agentId: "main",
      sessionKey: SESSION,
      runId: RUN,
      providerRunId: "oc-run-1",
      replyToInboundId: MSG,
      text: "PONG",
      attachments: [],
      ts: "2026-09-15T01:02:03.000Z",
    });
  });

  it("components 는 shared 스키마로 검증하고 기본값을 채운다", () => {
    const res = buildOutboundMessage({
      outboundId: "o2",
      channelId: CH,
      agentId: "main",
      sessionKey: SESSION,
      text: "골라 주세요",
      components: { blocks: [{ type: "actions", items: [{ type: "button", id: "ok", label: "OK" }] }] },
      now: NOW,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const button = res.message.components?.blocks[0];
    expect(button).toMatchObject({ type: "actions", items: [{ id: "ok", label: "OK", style: "secondary" }] });
  });

  it("components 가 JSON 문자열로 와도 받는다 (모델이 문자열로 직렬화하는 경우)", () => {
    const res = buildOutboundMessage({
      outboundId: "o3",
      channelId: CH,
      agentId: "main",
      sessionKey: SESSION,
      text: "x",
      components: JSON.stringify({ blocks: [{ type: "separator" }] }),
      now: NOW,
    });
    expect(res.ok && res.message.components?.blocks).toEqual([{ type: "separator" }]);
  });

  it("v1 제약 위반(버튼 6개)은 이슈 경로와 함께 거부한다", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ type: "button", id: `b${i}`, label: `B${i}` }));
    const res = buildOutboundMessage({
      outboundId: "o4",
      channelId: CH,
      agentId: "main",
      sessionKey: SESSION,
      text: "x",
      components: { blocks: [{ type: "actions", items }] },
      now: NOW,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("components");
    expect(res.error).toContain("blocks.0");
  });

  it("깨진 JSON 문자열은 거부한다", () => {
    const res = buildOutboundMessage({
      outboundId: "o5",
      channelId: CH,
      agentId: "main",
      sessionKey: SESSION,
      text: "x",
      components: "{not json",
      now: NOW,
    });
    expect(res).toEqual({ ok: false, error: "components: JSON 문자열을 파싱할 수 없다" });
  });
});

describe("messageToolSendToOutbound", () => {
  it("message 툴 send 인자(to·message·components)를 변환한다", () => {
    const res = messageToolSendToOutbound({
      params: {
        channel: "dodok",
        action: "send",
        to: `channel:${CH}`,
        message: "버튼입니다",
        components: { blocks: [{ type: "actions", items: [{ type: "button", id: "ok", label: "OK" }] }] },
      },
      agentId: "main",
      sessionKey: SESSION,
      correlation: { runId: RUN },
      outboundId: "o6",
      now: NOW,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.message.channelId).toBe(CH);
    expect(res.message.text).toBe("버튼입니다");
    expect(res.message.runId).toBe(RUN);
    expect(res.message.components?.blocks).toHaveLength(1);
  });

  it("to 가 없으면 세션 키의 현재 채널로 보낸다, agentId 가 없으면 세션 키에서 뽑는다", () => {
    const res = messageToolSendToOutbound({
      params: { action: "send", message: "hi" },
      agentId: null,
      sessionKey: SESSION,
      outboundId: "o7",
      now: NOW,
    });
    expect(res.ok && [res.message.channelId, res.message.agentId]).toEqual([CH, "main"]);
  });

  it("text/content 별칭도 받는다", () => {
    const res = messageToolSendToOutbound({
      params: { to: CH, content: "c" },
      agentId: "main",
      sessionKey: SESSION,
      outboundId: "o8",
      now: NOW,
    });
    expect(res.ok && res.message.text).toBe("c");
  });

  it("해석할 수 없는 target 은 거부한다", () => {
    const res = messageToolSendToOutbound({
      params: { to: "channel:general", message: "x" },
      agentId: "main",
      sessionKey: "agent:main:main",
      outboundId: "o9",
      now: NOW,
    });
    expect(res).toEqual({ ok: false, error: "to: dodok 채널 id(channel:<uuid>)를 해석할 수 없다" });
  });

  it("본문도 components 도 없으면 거부한다", () => {
    const res = messageToolSendToOutbound({
      params: { to: CH },
      agentId: "main",
      sessionKey: SESSION,
      outboundId: "o10",
      now: NOW,
    });
    expect(res).toEqual({ ok: false, error: "message: 본문이나 components 중 하나는 있어야 한다" });
  });
});

describe("toolInputError", () => {
  it("코어 tools.invoke 가 400 + 원문으로 돌려주도록 이름을 ToolInputError 로 붙인다", () => {
    const res = messageToolSendToOutbound({
      params: { to: CH, message: "x", components: "{" },
      agentId: "main",
      sessionKey: SESSION,
      outboundId: "o11",
      now: NOW,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const error = toolInputError(res.error);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ToolInputError");
    expect(error.message).toBe("components: JSON 문자열을 파싱할 수 없다");
  });
});

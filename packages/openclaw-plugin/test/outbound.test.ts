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
      attachmentIds: [],
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

describe("buildOutboundMessage — artifact:// 이름의 공백류", () => {
  const base = { outboundId: "oa", channelId: CH, agentId: "main", sessionKey: SESSION, text: "x", now: NOW };
  const components = () => ({
    blocks: [
      { type: "media", items: [{ url: "artifact://월간 보고서.png", alt: "월간 보고서" }] },
      { type: "file", url: "artifact://탭\t이름.pdf", name: "탭\t이름.pdf" },
      {
        type: "actions",
        items: [{ type: "button", id: "open", label: "열기", url: "artifact://줄\n바꿈 이름.txt" }],
      },
    ],
  });

  it("media·file·링크 버튼의 artifact:// 값 안 공백류를 퍼센트 인코딩해 통과시킨다", () => {
    const res = buildOutboundMessage({ ...base, components: components() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(OutboundMessage.parse(res.message)).toEqual(res.message);
    const [media, file, actions] = res.message.components?.blocks ?? [];
    expect(media).toEqual({
      type: "media",
      items: [{ url: "artifact://월간%20보고서.png", alt: "월간 보고서" }],
    });
    expect(file).toMatchObject({ url: "artifact://탭%09이름.pdf", name: "탭\t이름.pdf" });
    expect(actions).toMatchObject({ items: [{ url: "artifact://줄%0A바꿈%20이름.txt" }] });
  });

  it("원본 입력 객체는 바꾸지 않는다", () => {
    const input = components();
    const snapshot = structuredClone(input);
    const res = buildOutboundMessage({ ...base, components: input });
    expect(res.ok).toBe(true);
    expect(input).toEqual(snapshot);
  });

  it("JSON 문자열로 온 components 도 같은 규칙", () => {
    const res = buildOutboundMessage({ ...base, components: JSON.stringify(components()) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.message.components?.blocks[0]).toMatchObject({
      items: [{ url: "artifact://월간%20보고서.png" }],
    });
    expect(res.message.components?.blocks[1]).toMatchObject({ url: "artifact://탭%09이름.pdf" });
  });

  it("https:// 값의 공백은 건드리지 않고 여전히 계약 위반", () => {
    const res = buildOutboundMessage({
      ...base,
      components: { blocks: [{ type: "file", url: "https://example.com/월간 보고서.pdf", name: "a.pdf" }] },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("blocks.0.url");
  });

  it("url 이 아닌 필드의 artifact:// 문자열은 건드리지 않는다", () => {
    const res = buildOutboundMessage({
      ...base,
      components: { blocks: [{ type: "section", text: "artifact://월간 보고서.pdf 를 보세요" }] },
    });
    expect(res.ok && res.message.components?.blocks[0]).toEqual({
      type: "section",
      text: "artifact://월간 보고서.pdf 를 보세요",
    });
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

  it("components 는 이 carrier 로만 온다 — 툴 인자의 components 가 검증·기본값을 거쳐 OutboundMessage.components 로 나오고, 스키마 위반은 거절한다", () => {
    // 실물에서 components 는 message 툴 send 로만 온다(deliver 는 싣지 않는다). 통합 하네스는 이 함수를 지나지 않는다
    const send = (components: unknown) =>
      messageToolSendToOutbound({
        params: { action: "send", to: `channel:${CH}`, message: "골라 주세요", components },
        agentId: "main",
        sessionKey: SESSION,
        correlation: { runId: RUN },
        outboundId: "o12",
        now: NOW,
      });

    const res = send({
      text: "점심",
      blocks: [
        { type: "actions", items: [{ type: "select", id: "lunch", options: [{ value: "a", label: "A" }] }] },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(OutboundMessage.parse(res.message)).toEqual(res.message);
    expect(res.message.components).toEqual({
      reusable: false,
      ttlMs: 1_800_000,
      text: "점심",
      blocks: [
        {
          type: "actions",
          items: [{ type: "select", id: "lunch", options: [{ value: "a", label: "A" }], multi: false }],
        },
      ],
    });

    const items = Array.from({ length: 6 }, (_, i) => ({ type: "button", id: `b${i}`, label: `B${i}` }));
    expect(send({ blocks: [{ type: "actions", items }] })).toEqual({
      ok: false,
      error: expect.stringMatching(/^components: v1 스키마 위반 — blocks\.0\.items /),
    });
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
    expect(res).toEqual({ ok: false, error: "message: 본문·components·media 중 하나는 있어야 한다" });
  });

  it("본문이 비어도 media 가 있으면(hasMedia) 보낸다 — 채움 글을 넣지 않는다", () => {
    const res = messageToolSendToOutbound({
      params: { to: CH, media: "/w/a.png" },
      agentId: "main",
      sessionKey: SESSION,
      outboundId: "o11",
      now: NOW,
      hasMedia: true,
    });
    expect(res.ok && res.message.text).toBe("");
    expect(res.ok && res.message.attachmentIds).toEqual([]);
  });
});

describe("buildOutboundMessage attachmentIds", () => {
  it("attachmentIds 를 그대로 싣고, 텍스트 없이 첨부만 있는 메시지도 계약을 지킨다", () => {
    const ids = ["01a09fc9-d204-7551-89d6-38544d07a105", "01a09fc9-d204-7551-89d6-38544d07a106"];
    const res = buildOutboundMessage({
      outboundId: "o12",
      channelId: CH,
      agentId: "main",
      sessionKey: SESSION,
      text: "",
      attachmentIds: ids,
      now: NOW,
    });
    expect(res.ok && res.message.attachmentIds).toEqual(ids);
    expect(res.ok && OutboundMessage.parse(res.message).attachmentIds).toEqual(ids);
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

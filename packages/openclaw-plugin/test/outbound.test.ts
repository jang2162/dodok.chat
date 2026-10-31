import { CONVERSATION_ONLY_REASON, OutboundMessage } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import {
  buildOutboundMessage,
  conversationIdFromSessionKey,
  formatDodokTarget,
  messageToolSendToOutbound,
  parseDodokTarget,
  THREAD_ONLY_REASON,
  toolInputError,
} from "../src/outbound";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const RUN = "01a09fc9-d204-7551-89d6-38544d07a103";
const MSG = "01a09fc9-d204-7551-89d6-38544d07a104";
const NOW = new Date("2026-09-15T01:02:03.000Z");
const SESSION = `agent:main:dodok:channel:${CH}`;
const ROOT = "01a09fc9-d204-7551-89d6-38544d07a1aa";
const OTHER_CH = "01a09fc9-d204-7551-89d6-38544d07a1cc";
const THREAD_SESSION = `${SESSION}:thread:${ROOT}`;

describe("target 문법", () => {
  it("channel:<id>, dodok:channel:<id>, 맨 id 를 받는다", () => {
    expect(parseDodokTarget(`channel:${CH}`)).toBe(CH);
    expect(parseDodokTarget(`dodok:channel:${CH}`)).toBe(CH);
    expect(parseDodokTarget(` ${CH} `)).toBe(CH);
    expect(parseDodokTarget("channel:general")).toBeNull();
    expect(formatDodokTarget(CH)).toBe(`channel:${CH}`);
  });

  it("세션 키에서 대화 id 를 뽑는다", () => {
    expect(conversationIdFromSessionKey(SESSION)).toBe(CH);
    expect(conversationIdFromSessionKey(THREAD_SESSION)).toBe(CH);
    expect(conversationIdFromSessionKey(`agent:main:dodok:channel:${CH}:g2`)).toBeNull();
    expect(conversationIdFromSessionKey("agent:main:main")).toBeNull();
  });
});

describe("buildOutboundMessage", () => {
  it("평문 응답을 OutboundMessage 로 만든다", () => {
    const res = buildOutboundMessage({
      outboundId: "dodok-out-1",
      conversationId: CH,
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
      conversationId: CH,
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
      conversationId: CH,
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
      conversationId: CH,
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
      conversationId: CH,
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
      conversationId: CH,
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
  const base = {
    outboundId: "oa",
    conversationId: CH,
    agentId: "main",
    sessionKey: SESSION,
    text: "x",
    now: NOW,
  };
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
    expect(res.message.conversationId).toBe(CH);
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
    expect(res.ok && [res.message.conversationId, res.message.agentId]).toEqual([CH, "main"]);
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

describe("[Review Focus 4] message 툴 — 세션 키의 대화에만", () => {
  const send = (params: Record<string, unknown>, sessionKey: string | null = SESSION) =>
    messageToolSendToOutbound({ params, agentId: "main", sessionKey, outboundId: "c1", now: NOW });

  it("to 가 같은 채널의 다른 세션(대화) id 면 고정 사유로 거절한다", () => {
    for (const to of [`channel:${OTHER_CH}`, OTHER_CH, `dodok:channel:${OTHER_CH}`]) {
      expect(send({ to, message: "x" })).toEqual({ ok: false, error: CONVERSATION_ONLY_REASON });
    }
  });

  it("to 가 없으면 세션 키의 대화, 세션의 대화와 같으면(대소문자 무시) 통과", () => {
    for (const params of [
      { message: "x" },
      { to: `channel:${CH}`, message: "x" },
      { to: CH.toUpperCase(), message: "x" },
    ]) {
      const res = send(params);
      expect(res.ok && [res.message.conversationId, res.message.sessionKey]).toEqual([CH, SESSION]);
    }
  });

  it("dodok 모양이 아닌 세션에서 dodok 대화로 보내면 거절한다 — 서버도 저장하지 않는다", () => {
    expect(send({ to: `channel:${CH}`, message: "x" }, "agent:main:main")).toEqual({
      ok: false,
      error: CONVERSATION_ONLY_REASON,
    });
  });

  it("세션 키가 없으면(에이전트 세션 문맥 없음) to 의 대화로 키를 만든다", () => {
    const res = send({ to: `channel:${OTHER_CH}`, message: "x" }, null);
    expect(res.ok && [res.message.conversationId, res.message.sessionKey]).toEqual([
      OTHER_CH,
      `agent:main:dodok:channel:${OTHER_CH}`,
    ]);
  });
});

describe("스레드 아웃바운드", () => {
  const base = { outboundId: "t1", conversationId: CH, agentId: "main", text: "x", now: NOW };

  it("buildOutboundMessage 는 threadId 를 싣고 계약을 지킨다", () => {
    const res = buildOutboundMessage({ ...base, sessionKey: THREAD_SESSION, threadId: ROOT });
    expect(res.ok && res.message.threadId).toBe(ROOT);
    expect(res.ok && OutboundMessage.parse(res.message).threadId).toBe(ROOT);
  });

  it("buildOutboundMessage 는 세션 키와 threadId 가 어긋나면 거절한다", () => {
    expect(buildOutboundMessage({ ...base, sessionKey: THREAD_SESSION }).ok).toBe(false);
    expect(buildOutboundMessage({ ...base, sessionKey: SESSION, threadId: ROOT }).ok).toBe(false);
    expect(buildOutboundMessage({ ...base, sessionKey: "agent:main:main", threadId: ROOT }).ok).toBe(false);
  });

  it("채널 메시지에는 threadId 키가 없다", () => {
    const res = buildOutboundMessage({ ...base, sessionKey: SESSION });
    expect(res.ok && res.message).not.toHaveProperty("threadId");
  });

  const toolSend = (params: Record<string, unknown>, sessionKey: string | null = THREAD_SESSION) =>
    messageToolSendToOutbound({ params, agentId: "main", sessionKey, outboundId: "t2", now: NOW });

  it("스레드 세션의 message 툴 — to 가 없거나 같은 채널이면 그 스레드로", () => {
    for (const params of [
      { message: "hi" },
      { to: `channel:${CH}`, message: "hi" },
      { to: CH, message: "hi" },
    ]) {
      const res = toolSend(params);
      expect(res.ok && [res.message.conversationId, res.message.threadId, res.message.sessionKey]).toEqual([
        CH,
        ROOT,
        THREAD_SESSION,
      ]);
    }
  });

  it("스레드 세션의 message 툴 — threadId 인자가 같은 스레드면(대소문자 무시) 받는다", () => {
    const res = toolSend({ to: `channel:${CH}`, message: "hi", threadId: ROOT.toUpperCase() });
    expect(res.ok && res.message.threadId).toBe(ROOT);
  });

  it("스레드 세션의 message 툴이 다른 대화를 가리키면 대화 사유로 거절한다 — 스레드 사유는 다른 스레드에만", () => {
    expect(toolSend({ to: `channel:${OTHER_CH}`, message: "hi" })).toEqual({
      ok: false,
      error: CONVERSATION_ONLY_REASON,
    });
  });

  it.each([
    ["다른 스레드", { to: `channel:${CH}`, message: "hi", threadId: "01a09fc9-d204-7551-89d6-38544d07a1bb" }],
    ["스레드가 아닌 값(최상위를 뜻하려는 것)", { to: `channel:${CH}`, message: "hi", threadId: "top" }],
    ["코어의 명시적 최상위 표지 topLevel: true", { to: `channel:${CH}`, message: "hi", topLevel: true }],
    ["코어의 명시적 최상위 표지 threadId: null", { to: `channel:${CH}`, message: "hi", threadId: null }],
  ])("스레드 세션의 message 툴이 가리키는 곳이 %s — 고정 사유로 거절한다", (_label, params) => {
    expect(toolSend(params)).toEqual({ ok: false, error: THREAD_ONLY_REASON });
  });

  it("고정 사유 문구", () => {
    expect(THREAD_ONLY_REASON).toBe("dodok: 이 대화는 스레드라 이 스레드에만 보낼 수 있습니다");
    expect(CONVERSATION_ONLY_REASON).toBe("이 대화에만 보낼 수 있습니다");
  });

  it("채널 세션의 message 툴은 스레드로 보내지 않는다 — threadId 인자는 쓰지 않는다", () => {
    const res = toolSend({ to: `channel:${CH}`, message: "hi", threadId: ROOT }, SESSION);
    expect(res.ok).toBe(true);
    expect(res.ok && res.message).not.toHaveProperty("threadId");
  });
});

describe("buildOutboundMessage attachmentIds", () => {
  it("attachmentIds 를 그대로 싣고, 텍스트 없이 첨부만 있는 메시지도 계약을 지킨다", () => {
    const ids = ["01a09fc9-d204-7551-89d6-38544d07a105", "01a09fc9-d204-7551-89d6-38544d07a106"];
    const res = buildOutboundMessage({
      outboundId: "o12",
      conversationId: CH,
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

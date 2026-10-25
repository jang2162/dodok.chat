import { describe, expect, it } from "vitest";
import {
  AdapterStatus,
  ApprovalResolve,
  ChannelSubscribe,
  ComponentInteract,
  MessageSend,
  RunEventsReplay,
} from "../src/wire";

const ID = "01a09fc9-d204-7551-89d6-38544d07a101";

describe("wire schemas", () => {
  it("ChannelSubscribe: lastSeq는 선택, 음수 거부", () => {
    expect(ChannelSubscribe.parse({ channelId: ID })).toEqual({ channelId: ID });
    expect(ChannelSubscribe.safeParse({ channelId: ID, lastSeq: -1 }).success).toBe(false);
  });
  it("MessageSend: 빈 본문·긴 clientMsgId 거부", () => {
    expect(MessageSend.safeParse({ channelId: ID, clientMsgId: "c1", bodyMd: "" }).success).toBe(false);
    expect(MessageSend.safeParse({ channelId: ID, clientMsgId: "x".repeat(65), bodyMd: "hi" }).success).toBe(
      false,
    );
    expect(
      MessageSend.safeParse({ channelId: ID, clientMsgId: "c1", bodyMd: "hi", attachments: [ID] }).success,
    ).toBe(true);
  });
  it("MessageSend: conversationId·newConversation 은 함께 못 쓴다 — 둘 다 없음은 받는다(채널 세션 계획 판정 PS4)", () => {
    const base = { channelId: ID, clientMsgId: "c1", bodyMd: "hi" };
    expect(MessageSend.safeParse(base).success).toBe(true);
    expect(MessageSend.safeParse({ ...base, conversationId: ID }).success).toBe(true);
    expect(MessageSend.safeParse({ ...base, newConversation: {} }).success).toBe(true);
    expect(MessageSend.safeParse({ ...base, newConversation: { title: "배포" } }).success).toBe(true);
    expect(MessageSend.safeParse({ ...base, newConversation: { title: "가".repeat(81) } }).success).toBe(
      false,
    );
    expect(MessageSend.safeParse({ ...base, conversationId: ID, newConversation: {} }).success).toBe(false);
  });
  it("RunEventsReplay: afterSeq 기본값 0", () => {
    expect(RunEventsReplay.parse({ runId: ID })).toEqual({ runId: ID, afterSeq: 0 });
  });
  it("ComponentInteract: values는 객체", () => {
    expect(
      ComponentInteract.safeParse({ messageId: ID, componentId: "cmp_1", itemId: "go", values: {} }).success,
    ).toBe(true);
    expect(
      ComponentInteract.safeParse({ messageId: ID, componentId: "cmp_1", itemId: "go", values: "x" }).success,
    ).toBe(false);
  });
  it("ApprovalResolve: Gateway 결정 값 셋만 받고 note 는 싣지 않는다", () => {
    // Gateway 는 note 를 받지 않는다 — 넘어와도 버린다
    expect(ApprovalResolve.parse({ approvalId: ID, decision: "allow-once", note: "무시" })).toEqual({
      approvalId: ID,
      decision: "allow-once",
    });
    expect(ApprovalResolve.safeParse({ approvalId: ID, decision: "allow-always" }).success).toBe(true);
    expect(ApprovalResolve.safeParse({ approvalId: ID, decision: "deny" }).success).toBe(true);
    expect(ApprovalResolve.safeParse({ approvalId: ID, decision: "approve" }).success).toBe(false);
    expect(ApprovalResolve.safeParse({ approvalId: ID, decision: "maybe" }).success).toBe(false);
  });
});

describe("AdapterStatus — provider 판별 유니온(러너 계획 판정 P7)", () => {
  it("openclaw 는 Gateway 마다 한 줄(없으면 빈 목록, 꺼진 Gateway 는 disabled), claude 는 러너 수", () => {
    const line = { id: ID, name: "집", enabled: true, gateway: "reconnecting", bridge: "down" };
    const openclaw = {
      provider: "openclaw",
      gateways: [line, { ...line, enabled: false, gateway: "disabled" }],
    };
    const claude = { provider: "claude", runners: { connected: 1, tokens: 2 } };
    expect(AdapterStatus.parse(openclaw)).toEqual(openclaw);
    expect(AdapterStatus.parse({ provider: "openclaw", gateways: [] })).toEqual({
      provider: "openclaw",
      gateways: [],
    });
    expect(AdapterStatus.parse(claude)).toEqual(claude);
    // 옛 단수 모양·모르는 상태는 거절
    expect(
      AdapterStatus.safeParse({ provider: "openclaw", gateway: "connected", bridge: "connected" }).success,
    ).toBe(false);
    expect(
      AdapterStatus.safeParse({ provider: "openclaw", gateways: [{ ...line, gateway: "paused" }] }).success,
    ).toBe(false);
  });
  it("변형마다 제 필드가 있어야 하고, 어댑터 없는 provider 는 거절", () => {
    expect(
      AdapterStatus.safeParse({ provider: "openclaw", runners: { connected: 0, tokens: 0 } }).success,
    ).toBe(false);
    expect(
      AdapterStatus.safeParse({ provider: "claude", gateway: "connected", bridge: "connected" }).success,
    ).toBe(false);
    expect(
      AdapterStatus.safeParse({ provider: "codex", gateway: "connected", bridge: "connected" }).success,
    ).toBe(false);
    expect(
      AdapterStatus.safeParse({ provider: "claude", runners: { connected: -1, tokens: 0 } }).success,
    ).toBe(false);
  });
});

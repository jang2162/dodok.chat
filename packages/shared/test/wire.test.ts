import { describe, expect, it } from "vitest";
import {
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
  it("ApprovalResolve: approve|deny만", () => {
    expect(ApprovalResolve.safeParse({ approvalId: ID, decision: "approve" }).success).toBe(true);
    expect(ApprovalResolve.safeParse({ approvalId: ID, decision: "maybe" }).success).toBe(false);
  });
});

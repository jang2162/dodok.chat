import { describe, expect, it } from "vitest";
import { BridgeHello, InboundDeliver, InboundDeliverResult, OutboundMessage } from "../src/bridge";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;
const NOW = "2026-09-14T00:00:00Z";

describe("bridge schemas", () => {
  it("BridgeHello: pluginId는 dodok 고정, capability는 닫힌 목록", () => {
    expect(
      BridgeHello.safeParse({
        pluginId: "dodok",
        version: "0.1.0",
        sdkVersion: "2026.9.4",
        capabilities: ["config.set"],
      }).success,
    ).toBe(true);
    expect(
      BridgeHello.safeParse({ pluginId: "other", version: "0.1.0", sdkVersion: "2026.9.4", capabilities: [] })
        .success,
    ).toBe(false);
    expect(
      BridgeHello.safeParse({
        pluginId: "dodok",
        version: "0.1.0",
        sdkVersion: "2026.9.4",
        capabilities: ["nope"],
      }).success,
    ).toBe(false);
  });

  it("InboundDeliver: 컨텍스트 최근 메시지 최대 20개, options 기본값 {}", () => {
    const msg = (i: number) => ({
      author: { type: "user", handle: "jang", displayName: "장" },
      text: `m${i}`,
      ts: NOW,
    });
    const deliver = (n: number) => ({
      deliveryId: ID(1),
      kind: "message",
      channelId: ID(2),
      agentId: "researcher",
      sessionKey: `agent:researcher:dodok:channel:${ID(2)}`,
      runId: ID(3),
      message: {
        id: ID(4),
        author: { type: "user", handle: "jang", displayName: "장" },
        text: "@researcher 조사",
        attachments: [],
        ts: NOW,
      },
      context: {
        recentMessages: Array.from({ length: n }, (_, i) => msg(i)),
        participants: [],
        relayRules: "최대 4턴",
      },
    });
    const ok = InboundDeliver.parse(deliver(20));
    expect(ok.options).toEqual({});
    expect(InboundDeliver.safeParse(deliver(21)).success).toBe(false);
  });

  it("InboundDeliverResult: dispatch 는 providerRunId, drop 은 reason 을 싣는다", () => {
    expect(InboundDeliverResult.parse({ admission: "dispatch", providerRunId: ID(3) })).toEqual({
      admission: "dispatch",
      providerRunId: ID(3),
    });
    expect(InboundDeliverResult.parse({ admission: "drop", reason: "bot-loop-protection" })).toEqual({
      admission: "drop",
      reason: "bot-loop-protection",
    });
  });

  it("InboundDeliverResult: admission 이 없거나 닫힌 목록 밖이면 거부", () => {
    expect(InboundDeliverResult.safeParse({}).success).toBe(false);
    expect(InboundDeliverResult.safeParse({ providerRunId: ID(3) }).success).toBe(false);
    expect(InboundDeliverResult.safeParse({ admission: "observeOnly" }).success).toBe(false);
  });

  it("OutboundMessage: attachmentIds 기본값 [], components는 스키마 검증", () => {
    const base = {
      outboundId: "ob-1",
      channelId: ID(2),
      agentId: "researcher",
      sessionKey: "k",
      text: "@jang 결과입니다",
      ts: NOW,
    };
    expect(OutboundMessage.parse(base).attachmentIds).toEqual([]);
    expect(
      OutboundMessage.safeParse({ ...base, components: { blocks: [{ type: "actions", items: [] }] } })
        .success,
    ).toBe(false);
  });
});

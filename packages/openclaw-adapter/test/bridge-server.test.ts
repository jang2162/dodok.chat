import { describe, expect, it } from "vitest";
import {
  BridgeSessionState,
  OutboundDedupe,
  parseBridgeClientEvent,
  verifyBridgeToken,
} from "../src/bridge/session";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";

const hello = {
  pluginId: "dodok",
  version: "0.0.0",
  sdkVersion: "2026.9.4",
  gatewayVersion: "2026.9.4",
  capabilities: ["run_id_in_outbound"],
};

const outbound = {
  outboundId: "dodok-reply-1",
  channelId: CH,
  agentId: "main",
  sessionKey: `agent:main:dodok:channel:${CH}`,
  text: "PONG",
  ts: "2026-09-15T01:02:03.000Z",
};

describe("verifyBridgeToken", () => {
  it("같은 토큰만 통과한다", () => {
    expect(verifyBridgeToken("s3cret", "s3cret")).toBe(true);
    expect(verifyBridgeToken("s3cret", "s3cres")).toBe(false);
    expect(verifyBridgeToken("s3cret", "s3cret-longer")).toBe(false);
  });

  it("문자열이 아니거나 비어 있으면 거부한다 (서버 토큰이 비어 있어도)", () => {
    expect(verifyBridgeToken("s3cret", undefined)).toBe(false);
    expect(verifyBridgeToken("s3cret", 42)).toBe(false);
    expect(verifyBridgeToken("", "")).toBe(false);
  });
});

describe("parseBridgeClientEvent", () => {
  it("hello 를 BridgeHello 로 파싱한다", () => {
    expect(parseBridgeClientEvent("hello", hello)).toEqual({ ok: true, data: hello });
  });

  it("outbound.message 는 기본값(attachments)을 채운다", () => {
    const res = parseBridgeClientEvent("outbound.message", outbound);
    expect(res).toEqual({ ok: true, data: { ...outbound, attachments: [] } });
  });

  it("검증 실패는 VALIDATION 과 이슈 경로", () => {
    const res = parseBridgeClientEvent("outbound.message", { ...outbound, channelId: "c1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("VALIDATION");
    expect(res.error.message).toContain("channelId");
  });

  it("status·outbound.typing", () => {
    expect(parseBridgeClientEvent("status", { gateway: "connected", queueDepth: 0 }).ok).toBe(true);
    expect(parseBridgeClientEvent("outbound.typing", { channelId: CH, agentId: "main" }).ok).toBe(true);
    expect(parseBridgeClientEvent("status", { gateway: "sideways", queueDepth: 0 }).ok).toBe(false);
  });
});

describe("BridgeSessionState", () => {
  it("hello 전에는 outbound 를 거부하고, hello 뒤 ready", () => {
    const state = new BridgeSessionState("sock-1");
    expect(state.phase).toBe("awaiting_hello");
    expect(state.acceptOutbound("o1")).toEqual({ kind: "reject", code: "PROTOCOL_MISMATCH" });
    state.onHello(hello as never);
    expect(state.phase).toBe("ready");
    expect(state.hello?.capabilities).toEqual(["run_id_in_outbound"]);
  });

  it("hello 는 한 번만 받는다", () => {
    const state = new BridgeSessionState("sock-1");
    state.onHello(hello as never);
    expect(() => state.onHello(hello as never)).toThrow("hello already received");
  });

  it("같은 outboundId 는 처음 발급한 messageId 로 중복 처리한다", () => {
    const state = new BridgeSessionState("sock-1");
    state.onHello(hello as never);
    expect(state.acceptOutbound("o1")).toEqual({ kind: "new" });
    state.recordOutbound("o1", "m1");
    expect(state.acceptOutbound("o1")).toEqual({ kind: "duplicate", messageId: "m1" });
  });

  it("연결이 바뀌어도 같은 OutboundDedupe 를 나눠 쓰면 이전 연결이 기록한 outboundId 를 중복으로 본다", () => {
    const dedupe = new OutboundDedupe();
    const before = new BridgeSessionState("sock-1", { dedupe });
    before.onHello(hello as never);
    before.recordOutbound("o1", "m1");
    before.close("disconnect");

    const after = new BridgeSessionState("sock-2", { dedupe });
    after.onHello(hello as never);
    expect(after.acceptOutbound("o1")).toEqual({ kind: "duplicate", messageId: "m1" });
  });

  it("끊기거나 교체되면 closed, 이후 outbound 거부", () => {
    const state = new BridgeSessionState("sock-1");
    state.onHello(hello as never);
    state.close("replaced");
    expect(state.phase).toBe("closed");
    expect(state.closeReason).toBe("replaced");
    expect(state.acceptOutbound("o9")).toEqual({ kind: "reject", code: "PROTOCOL_MISMATCH" });
  });
});

describe("OutboundDedupe", () => {
  it("상한을 넘으면 가장 오래 안 쓴 outboundId 부터 잊는다 (LRU)", () => {
    const dedupe = new OutboundDedupe({ max: 2 });
    dedupe.record("o1", "m1");
    dedupe.record("o2", "m2");
    // o1 을 조회해 최근으로 올린다 — 다음 기록 때 밀려나는 것은 o2
    expect(dedupe.lookup("o1")).toBe("m1");
    dedupe.record("o3", "m3");
    expect(dedupe.lookup("o2")).toBeUndefined();
    expect(dedupe.lookup("o1")).toBe("m1");
    expect(dedupe.lookup("o3")).toBe("m3");
    expect(dedupe.size).toBe(2);
  });
});

import type { InboundDeliver } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import {
  type AdapterEvent,
  AdapterError,
  FAKE_GATEWAY_ID,
  FakeAdapter,
  type ProviderApproval,
  type RunEventBody,
} from "../src";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const RUN = "01a09fc9-d204-7551-89d6-38544d07a103";
const MSG = "01a09fc9-d204-7551-89d6-38544d07a104";
const DELIVERY = "01a09fc9-d204-7551-89d6-38544d07a105";

function deliver(overrides: Partial<InboundDeliver> = {}): InboundDeliver {
  return {
    deliveryId: DELIVERY,
    kind: "message",
    channelId: CH,
    conversationId: CH,
    conversationTitle: "배포 점검",
    agentId: "dev",
    sessionKey: `agent:dev:dodok:channel:${CH}`,
    runId: RUN,
    message: {
      id: MSG,
      author: { type: "user", handle: "jang", displayName: "장" },
      text: "@dev 안녕",
      attachments: [],
      ts: "2026-09-15T00:00:00.000Z",
    },
    context: { recentMessages: [], participants: [], relayRules: "" },
    options: {},
    ...overrides,
  };
}

describe("FakeAdapter", () => {
  it("setupDetail 은 주입한 상세를 돌려주고, revokeTokenSessions 는 붙은 플러그인 토큰이면 끊고(1) 아니면 0", () => {
    const adapter = new FakeAdapter();
    const events: AdapterEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    expect(adapter.setupDetail().provider).toBe("openclaw");
    expect(adapter.setupDetail().bridge.plugin?.tokenId).toBeNull();

    const plugin = {
      version: "0.0.0",
      sdkVersion: "2026.9.4",
      gatewayVersion: "2026.9.5",
      bundleSha256: "c".repeat(64),
      tokenId: "t1",
      connectedAt: "2026-09-24T00:00:00.000Z",
    };
    const detail = {
      provider: "openclaw" as const,
      gateway: { state: "connected" as const, host: "gw.example:443", version: "2026.9.5", pairing: null },
      bridge: { state: "connected" as const, plugin },
    };
    adapter.setSetupDetail(detail);
    expect(adapter.setupDetail()).toEqual(detail);

    expect(adapter.revokeTokenSessions("t2")).toBe(0);
    expect(events).toEqual([]);
    expect(adapter.revokeTokenSessions("t1")).toBe(1);
    expect(adapter.setupDetail().bridge).toEqual({ state: "down", plugin: null });
    expect(adapter.calls.revokeTokenSessions).toEqual(["t2", "t1"]);
    expect(events).toEqual([{ kind: "setup" }]);
  });

  it("send 는 기본으로 dispatch 를 돌려주고 calls.send 에 입력을 기록한다", async () => {
    const adapter = new FakeAdapter();
    const input = deliver();

    await expect(adapter.send(input, { connectionId: FAKE_GATEWAY_ID })).resolves.toEqual({
      connectionId: FAKE_GATEWAY_ID,
      admission: "dispatch",
      providerRunId: RUN,
    });
    expect(adapter.calls.send).toEqual([input]);
  });

  it("script 로 send 응답을 바꾸고, script 가 던진 AdapterError 는 그대로 전파한다", async () => {
    const adapter = new FakeAdapter();
    adapter.script(async () => ({ admission: "drop", reason: "bot-loop-protection" }));
    await expect(adapter.send(deliver(), { connectionId: FAKE_GATEWAY_ID })).resolves.toEqual({
      connectionId: FAKE_GATEWAY_ID,
      admission: "drop",
      reason: "bot-loop-protection",
    });

    const failure = new AdapterError("ADAPTER_UNAVAILABLE", "plugin not connected");
    adapter.script(() => {
      throw failure;
    });
    const rejected = adapter.send(deliver(), { connectionId: FAKE_GATEWAY_ID });
    await expect(rejected).rejects.toBe(failure);
    await expect(rejected).rejects.toMatchObject({ code: "ADAPTER_UNAVAILABLE", name: "AdapterError" });
    expect(adapter.calls.send).toHaveLength(2);
  });

  it("emit 은 onEvent 핸들러에 닿고, 해제 함수를 부르면 더 이상 닿지 않는다", () => {
    const adapter = new FakeAdapter();
    const seen: AdapterEvent[] = [];
    const off = adapter.onEvent((e) => seen.push(e));
    const signal = { kind: "run_signal", runId: RUN, signal: { kind: "gateway_started" } } as const;
    const body = {
      type: "TEXT_MESSAGE_CONTENT",
      runId: RUN,
      messageId: "m1",
      delta: "안",
    } satisfies RunEventBody;

    adapter.emit(signal);
    adapter.emit({ kind: "run_event", runId: RUN, event: body });
    off();
    adapter.emit(signal);

    // 연결 id 없이 낸 이벤트에는 지금 고른 연결(OpenClaw 흉내의 기본은 env)이 실린다
    expect(seen).toEqual([
      { ...signal, connectionId: FAKE_GATEWAY_ID },
      { kind: "run_event", runId: RUN, connectionId: FAKE_GATEWAY_ID, event: body },
    ]);
  });

  it("useConnection·연결 id 를 실은 emit·send 의 연결 — 한 어댑터로 연결 여럿을 흉내 낸다", async () => {
    const adapter = new FakeAdapter();
    const seen: AdapterEvent[] = [];
    adapter.onEvent((e) => seen.push(e));
    expect(adapter.connectionId).toBe(FAKE_GATEWAY_ID);
    adapter.useConnection("g2");
    adapter.emit({ kind: "run_signal", runId: RUN, signal: { kind: "gateway_started" } });
    adapter.emit({ kind: "run_signal", runId: RUN, connectionId: "g1", signal: { kind: "gateway_started" } });
    expect(seen.map((e) => (e.kind === "status" || e.kind === "setup" ? undefined : e.connectionId))).toEqual(
      ["g2", "g1"],
    );
    // 받은 연결을 결과에 싣는다. null 은 OpenClaw 흉내가 거절한다(아래 「연결이 없는 에이전트」)
    await expect(adapter.send(deliver(), { connectionId: "g1" })).resolves.toMatchObject({
      connectionId: "g1",
    });
    expect(adapter.calls.connections.send).toEqual(["g1"]);
    expect(new FakeAdapter({ provider: "runner" }).connectionId).toBe("fake-runner");
  });

  it("RunEventBody 는 판별 유니온에 분배된다 — 변형별 필드를 받고 누락은 잡는다", () => {
    // @ts-expect-error — TEXT_MESSAGE_CONTENT 는 messageId·delta 가 필요하다
    const missing: RunEventBody = { type: "TEXT_MESSAGE_CONTENT", runId: RUN, delta: "x" };
    const ok: RunEventBody = { type: "TOOL_CALL_START", runId: RUN, toolCallId: "t1", toolCallName: "exec" };

    expect(missing.type).toBe("TEXT_MESSAGE_CONTENT");
    expect(ok).not.toHaveProperty("seq");
  });

  it("setGatewayState·setCapabilities 가 status()·capabilities() 에 반영되고 기본값은 전부 연결·true 다", () => {
    const adapter = new FakeAdapter();
    expect(adapter.status()).toEqual({ provider: "openclaw", gateways: [] });
    adapter.upsertGateway({ id: FAKE_GATEWAY_ID, name: "gw", url: "ws://a", token: "t", enabled: true });
    const line = (gateway: string, bridge: string) => ({
      provider: "openclaw",
      gateways: [{ id: FAKE_GATEWAY_ID, name: "gw", enabled: true, gateway, bridge }],
    });
    expect(adapter.status()).toEqual(line("connected", "connected"));
    expect(adapter.capabilities()).toEqual({
      agentsList: true,
      configSet: true,
      promptEveryRun: false,
      serverSessionIds: false,
    });

    adapter.setGatewayState({ gateway: "down", bridge: "down" });
    adapter.setCapabilities({
      agentsList: false,
      configSet: true,
      promptEveryRun: false,
      serverSessionIds: false,
    });

    expect(adapter.status()).toEqual(line("down", "down"));
    expect(adapter.capabilities()).toEqual({
      agentsList: false,
      configSet: true,
      promptEveryRun: false,
      serverSessionIds: false,
    });
  });

  it("sessionKeyFor 는 원형 키이고 나머지 메서드는 기본값을 돌려주며 호출을 기록한다", async () => {
    const adapter = new FakeAdapter();
    const key = adapter.sessionKeyFor("dev", CH);
    expect(key).toBe(`agent:dev:dodok:channel:${CH}`);
    expect(adapter.sessionKeyFor("dev", CH, MSG)).toBe(`agent:dev:dodok:channel:${CH}:thread:${MSG}`);

    await expect(adapter.listAgents(FAKE_GATEWAY_ID)).resolves.toEqual([
      { providerAgentId: "dev", name: "dev" },
      { providerAgentId: "fin" },
    ]);

    await expect(adapter.syncChannelConfig(CH, { requireMention: true }, FAKE_GATEWAY_ID)).resolves.toEqual({
      applied: "live",
    });
    await adapter.abort(RUN, key, FAKE_GATEWAY_ID);
    adapter.forgetRun(RUN);

    expect(adapter.calls.forget).toEqual([RUN]);
    expect(adapter.calls.syncChannelConfig).toEqual([{ channelId: CH, config: { requireMention: true } }]);
    expect(adapter.calls.abort).toEqual([{ runId: RUN, sessionKey: key }]);
  });
});

describe("FakeAdapter — 승인(서버 테스트용 대본)", () => {
  const approval = (overrides: Partial<ProviderApproval> = {}): ProviderApproval => ({
    providerApprovalId: "plugin:533fe246-fa79-4f86-bcd0-3c08b549cb20",
    kind: "plugin",
    sessionKey: `agent:dev:dodok:channel:${CH}`,
    providerAgentId: "dev",
    conversationId: CH,
    toolCallId: "toolu_018ohZoiNMZwidAe7fWsWSam",
    toolName: "Write",
    title: "claude-cli native tool: Write",
    severity: "warning",
    allowedDecisions: ["allow-once", "deny"],
    status: "pending",
    createdAt: "2026-09-20T09:49:47.988Z",
    expiresAt: "2026-09-20T09:51:47.988Z",
    ...overrides,
  });

  it("emitApproval 은 approval 이벤트를 낸다", () => {
    const adapter = new FakeAdapter();
    const seen: AdapterEvent[] = [];
    adapter.onEvent((e) => seen.push(e));
    const a = approval();

    adapter.emitApproval(a);

    expect(seen).toEqual([{ kind: "approval", connectionId: FAKE_GATEWAY_ID, approval: a }]);
  });

  it("resolveApproval 은 호출을 기록하고 emitApproval 한 승인의 terminal 스냅샷을 돌려준다", async () => {
    const adapter = new FakeAdapter();
    const a = approval();
    adapter.emitApproval(a);

    await expect(
      adapter.resolveApproval(a.providerApprovalId, "plugin", "deny", FAKE_GATEWAY_ID),
    ).resolves.toMatchObject({
      providerApprovalId: a.providerApprovalId,
      status: "denied",
      decision: "deny",
      reason: "user",
      toolCallId: a.toolCallId,
    });
    expect(adapter.calls.resolveApproval).toEqual([
      { providerApprovalId: a.providerApprovalId, kind: "plugin", decision: "deny" },
    ]);
  });

  it("Gateway 가 connected 가 아니면 ADAPTER_UNAVAILABLE 로 던지고 호출을 기록하지 않는다(판정 P6)", async () => {
    const adapter = new FakeAdapter();
    const a = approval();
    adapter.emitApproval(a);
    adapter.scriptResolveApproval(() => a);
    for (const gateway of ["reconnecting", "down"] as const) {
      adapter.setGatewayState({ gateway });
      await expect(
        adapter.resolveApproval(a.providerApprovalId, "plugin", "deny", FAKE_GATEWAY_ID),
      ).rejects.toMatchObject({
        name: "AdapterError",
        code: "ADAPTER_UNAVAILABLE",
      });
    }
    expect(adapter.calls.resolveApproval).toEqual([]);
  });

  it("모르는 승인은 NOT_FOUND, scriptResolveApproval 로 응답을 바꿀 수 있다", async () => {
    const adapter = new FakeAdapter();

    await expect(
      adapter.resolveApproval("plugin:nope", "plugin", "allow-once", FAKE_GATEWAY_ID),
    ).rejects.toMatchObject({
      name: "AdapterError",
      code: "NOT_FOUND",
    });

    adapter.scriptResolveApproval(() => approval({ status: "expired", decision: "deny", reason: "timeout" }));
    await expect(
      adapter.resolveApproval("plugin:nope", "plugin", "allow-once", FAKE_GATEWAY_ID),
    ).resolves.toMatchObject({
      status: "expired",
      reason: "timeout",
    });
    expect(adapter.calls.resolveApproval).toHaveLength(2);
  });
});

describe("FakeAdapter.supports", () => {
  it("기본은 스레드를 아는 플러그인이 붙어 있다", () => {
    expect(new FakeAdapter().supports("dev", FAKE_GATEWAY_ID, "threads")).toBe(true);
  });

  it("setPluginCapabilities 로 옛 플러그인을 흉내 낸다", () => {
    const adapter = new FakeAdapter();
    adapter.setPluginCapabilities([]);
    expect(adapter.supports("dev", FAKE_GATEWAY_ID, "threads")).toBe(false);
    adapter.setPluginCapabilities(["threads"]);
    expect(adapter.supports("dev", FAKE_GATEWAY_ID, "threads")).toBe(true);
  });

  it("에이전트를 가리지 않는다 — 붙은 플러그인 하나를 본다", () => {
    const adapter = new FakeAdapter();
    expect(adapter.supports("fin", FAKE_GATEWAY_ID, "threads")).toBe(true);
    adapter.setPluginCapabilities([]);
    expect(adapter.supports("fin", FAKE_GATEWAY_ID, "threads")).toBe(false);
  });

  it("붙은 플러그인이 없으면 false", () => {
    const adapter = new FakeAdapter();
    adapter.setSetupDetail({
      ...adapter.setupDetail(),
      bridge: { state: "down", plugin: null },
    });
    expect(adapter.supports("dev", FAKE_GATEWAY_ID, "threads")).toBe(false);
  });
});

describe("FakeAdapter — 연결이 없는 에이전트(OpenClaw 흉내)", () => {
  it("연결이 null 이면 send·abort·listAgents 가 ADAPTER_UNAVAILABLE, supports 는 false", async () => {
    const adapter = new FakeAdapter();
    for (const call of [
      () => adapter.send(deliver(), { connectionId: null }),
      () => adapter.abort(RUN, "agent:dev:dodok:channel:x", null),
      () => adapter.listAgents(null),
    ]) {
      await expect(call()).rejects.toMatchObject({ name: "AdapterError", code: "ADAPTER_UNAVAILABLE" });
    }
    expect(adapter.supports("dev", null, "threads")).toBe(false);
    expect(adapter.supports("dev", FAKE_GATEWAY_ID, "threads")).toBe(true);
  });
  it("러너 흉내는 null 연결을 받는다(묶임 없는 러너 에이전트)", async () => {
    const adapter = new FakeAdapter({ provider: "runner" });
    await expect(adapter.send(deliver(), { connectionId: null })).resolves.toMatchObject({
      connectionId: "fake-runner",
    });
  });
});

describe("FakeAdapter — Gateway 목록", () => {
  it("upsertGateway·removeGateway 가 목록을 바꾸고, 켜진 Gateway 는 주입한 상세·상태를 비춘다", async () => {
    const adapter = new FakeAdapter();
    expect(adapter.gatewaySetupDetails()).toEqual([]);
    adapter.upsertGateway({ id: "g1", name: "사무실", url: "ws://a", token: "t1", enabled: true });
    adapter.upsertGateway({ id: "g2", name: "집", url: "ws://b", token: "t2", enabled: false });
    const [g1, g2] = adapter.gatewaySetupDetails();
    expect(g1).toMatchObject({ id: "g1", name: "사무실", url: "ws://a", enabled: true });
    expect(g1?.gateway.state).toBe("connected");
    expect(g1?.bridge.plugin).not.toBeNull();
    expect(g2).toMatchObject({ id: "g2", enabled: false, bridge: { state: "down", plugin: null } });
    expect(g2?.gateway.state).toBe("disabled");
    expect(JSON.stringify(adapter.gatewaySetupDetails())).not.toContain("t1");
    expect(adapter.gatewayStatuses().map((g) => [g.id, g.gateway])).toEqual([
      ["g1", "connected"],
      ["g2", "disabled"],
    ]);
    // Gateway 하나만 상태·상세를 바꾼다 — 다른 Gateway 는 기본값 그대로
    adapter.upsertGateway({ id: "g3", name: "별장", url: "ws://c", token: "t3", enabled: true });
    adapter.setGatewayState({ gateway: "reconnecting" }, "g3");
    const detail = adapter.setupDetail();
    if (detail.provider !== "openclaw") throw new Error("openclaw detail");
    adapter.setSetupDetail({ ...detail, gateway: { ...detail.gateway, version: "2026.9.9" } }, "g3");
    expect(adapter.gatewayStatuses().map((g) => [g.id, g.gateway])).toEqual([
      ["g1", "connected"],
      ["g2", "disabled"],
      ["g3", "reconnecting"],
    ]);
    expect(adapter.gatewaySetupDetails().map((g) => g.gateway.version)).toEqual([null, null, "2026.9.9"]);
    await adapter.removeGateway("g1");
    expect(adapter.gatewaySetupDetails().map((g) => g.id)).toEqual(["g2", "g3"]);
    expect(adapter.calls.removeGateway).toEqual(["g1"]);
  });
});

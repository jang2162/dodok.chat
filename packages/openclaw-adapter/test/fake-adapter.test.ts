import type { InboundDeliver } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { type AdapterEvent, AdapterError, FakeAdapter, type RunEventBody } from "../src";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const RUN = "01a09fc9-d204-7551-89d6-38544d07a103";
const MSG = "01a09fc9-d204-7551-89d6-38544d07a104";
const DELIVERY = "01a09fc9-d204-7551-89d6-38544d07a105";

function deliver(overrides: Partial<InboundDeliver> = {}): InboundDeliver {
  return {
    deliveryId: DELIVERY,
    kind: "message",
    channelId: CH,
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
  it("send 는 기본으로 dispatch 를 돌려주고 calls.send 에 입력을 기록한다", async () => {
    const adapter = new FakeAdapter();
    const input = deliver();

    await expect(adapter.send(input)).resolves.toEqual({ admission: "dispatch", providerRunId: RUN });
    expect(adapter.calls.send).toEqual([input]);
  });

  it("script 로 send 응답을 바꾸고, script 가 던진 AdapterError 는 그대로 전파한다", async () => {
    const adapter = new FakeAdapter();
    adapter.script(async () => ({ admission: "drop", reason: "bot-loop-protection" }));
    await expect(adapter.send(deliver())).resolves.toEqual({
      admission: "drop",
      reason: "bot-loop-protection",
    });

    const failure = new AdapterError("ADAPTER_UNAVAILABLE", "plugin not connected");
    adapter.script(() => {
      throw failure;
    });
    const rejected = adapter.send(deliver());
    await expect(rejected).rejects.toBe(failure);
    await expect(rejected).rejects.toMatchObject({ code: "ADAPTER_UNAVAILABLE", name: "AdapterError" });
    expect(adapter.calls.send).toHaveLength(2);
  });

  it("emit 은 onEvent 핸들러에 닿고, 해제 함수를 부르면 더 이상 닿지 않는다", () => {
    const adapter = new FakeAdapter();
    const seen: AdapterEvent[] = [];
    const off = adapter.onEvent((e) => seen.push(e));
    const signal: AdapterEvent = { kind: "run_signal", runId: RUN, signal: { kind: "gateway_started" } };
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

    expect(seen).toEqual([signal, { kind: "run_event", runId: RUN, event: body }]);
  });

  it("RunEventBody 는 판별 유니온에 분배된다 — 변형별 필드를 받고 누락은 잡는다", () => {
    // @ts-expect-error — TEXT_MESSAGE_CONTENT 는 messageId·delta 가 필요하다
    const missing: RunEventBody = { type: "TEXT_MESSAGE_CONTENT", runId: RUN, delta: "x" };
    const ok: RunEventBody = { type: "TOOL_CALL_START", runId: RUN, toolCallId: "t1", toolCallName: "exec" };

    expect(missing.type).toBe("TEXT_MESSAGE_CONTENT");
    expect(ok).not.toHaveProperty("seq");
  });

  it("setStatus·setCapabilities 가 status()·capabilities() 에 반영되고 기본값은 전부 연결·true 다", () => {
    const adapter = new FakeAdapter();
    expect(adapter.status()).toEqual({ provider: "openclaw", gateway: "connected", bridge: "connected" });
    expect(adapter.capabilities()).toEqual({ sessionReset: true, agentsList: true, configSet: true });

    adapter.setStatus({ provider: "openclaw", gateway: "down", bridge: "down" });
    adapter.setCapabilities({ sessionReset: false, agentsList: true, configSet: true });

    expect(adapter.status()).toEqual({ provider: "openclaw", gateway: "down", bridge: "down" });
    expect(adapter.capabilities()).toEqual({ sessionReset: false, agentsList: true, configSet: true });
  });

  it("sessionKeyFor 는 원형 키이고 나머지 메서드는 기본값을 돌려주며 호출을 기록한다", async () => {
    const adapter = new FakeAdapter();
    const key = adapter.sessionKeyFor("dev", CH);
    expect(key).toBe(`agent:dev:dodok:channel:${CH}`);

    await expect(adapter.listAgents()).resolves.toEqual([
      { providerAgentId: "dev", name: "dev" },
      { providerAgentId: "fin" },
    ]);

    const reset = await adapter.resetSession(key);
    expect(typeof reset.sessionStartedAt).toBe("string");
    expect(reset.lifecycleRevision).toBe("fake-1");

    await expect(adapter.syncChannelConfig(CH, { requireMention: true })).resolves.toEqual({
      applied: "live",
    });
    await adapter.abort(RUN, key);

    expect(adapter.calls.reset).toEqual([key]);
    expect(adapter.calls.syncChannelConfig).toEqual([{ channelId: CH, config: { requireMention: true } }]);
    expect(adapter.calls.abort).toEqual([{ runId: RUN, sessionKey: key }]);
  });
});

import type { EventFrame } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterError } from "../src/adapter-types";
import { GatewayPairingRequiredError, type GatewayConnectOptions } from "../src/gateway/client";
import {
  createConnectionManager,
  type ConnectionManagerOptions,
  type GatewayDetail,
  gatewayHost,
  type GatewayLink,
  type GatewayState,
} from "../src/gateway/connection-manager";
import * as f from "./fixtures/gateway-events";

const GW = {
  url: "wss://gateway.example.test",
  token: "gw-shared-token",
  deviceIdentityPath: "/data/openclaw-device.json",
  deviceTokenStorePath: "/data/openclaw-device-tokens.json",
};
const KEY_A = "agent:dev:dodok:channel:01a09fc9-d204-7551-89d6-38544d07a202";
const KEY_B = "agent:fin:dodok:channel:01a09fc9-d204-7551-89d6-38544d07a203";

type Responder = (params: Record<string, unknown>) => unknown;

function fakeLink(responses: Record<string, Responder> = {}) {
  const calls: Array<{ method: string; params: unknown; timeoutMs: number | null | undefined }> = [];
  const link = {
    calls,
    request: vi.fn(async (method: string, params?: unknown, options?: { timeoutMs?: number | null }) => {
      calls.push({ method, params, timeoutMs: options?.timeoutMs });
      const respond = responses[method];
      return (respond ? await respond(params as Record<string, unknown>) : {}) as never;
    }),
    stop: vi.fn(async () => undefined),
  };
  return link;
}

/** 스크립트 순서대로 연결 결과를 낸다(Error 면 reject). 바닥나면 계속 실패. */
function scriptedConnector(script: Array<GatewayLink | Error>) {
  const attempts: Array<{ at: number; options: GatewayConnectOptions }> = [];
  const connector = vi.fn(async (options: GatewayConnectOptions) => {
    attempts.push({ at: Date.now(), options });
    const next = script.shift() ?? new Error("gateway unreachable");
    if (next instanceof Error) throw next;
    return next;
  });
  return { connector, attempts };
}

function setup(overrides: Partial<ConnectionManagerOptions> & Pick<ConnectionManagerOptions, "connector">) {
  const states: GatewayState[] = [];
  const details: GatewayDetail[] = [];
  const events: EventFrame[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const manager = createConnectionManager({
    gateway: GW,
    logger,
    onEvent: (frame) => events.push(frame),
    onState: (state) => states.push(state),
    onDetail: (detail) => details.push(detail),
    random: () => 0.5,
    ...overrides,
  });
  return { manager, states, details, events, logger };
}

const PAIRING_REQUEST_ID = "e3fbfe98-1666-4506-b6e7-5d7f04783c47";
// null 은 requestId 를 싣지 않은 오류
const pairingError = (requestId: string | null = PAIRING_REQUEST_ID) =>
  new GatewayPairingRequiredError({
    cause: new Error("NOT_PAIRED"),
    details: { code: "PAIRING_REQUIRED" },
    message: "device pairing required",
    requestId: requestId ?? undefined,
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createConnectionManager — 접속 루프", () => {
  it("connector 가 2번 실패하면 1s·2s 백오프 뒤 3번째에 붙고 connected 가 된다", async () => {
    const link = fakeLink();
    const { connector, attempts } = scriptedConnector([
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
      link,
    ]);
    const { manager, states } = setup({ connector });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts.map((a) => a.at)).toEqual([0]);
    expect(manager.state()).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts.map((a) => a.at)).toEqual([0, 1000]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(attempts.map((a) => a.at)).toEqual([0, 1000, 3000]);
    expect(manager.state()).toBe("connected");
    expect(states).toEqual(["reconnecting", "connected"]);

    // 붙으면 실패 카운터가 리셋된다 — 끊긴 뒤 첫 재접속은 다시 1s
    attempts[2]?.options.onClose?.({ code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts.map((a) => a.at)).toEqual([0, 1000, 3000, 4000]);
  });

  it("백오프는 ±20% 지터를 얹고 maxMs 를 넘지 않는다", async () => {
    const low = scriptedConnector([new Error("x"), fakeLink()]);
    const lowSetup = setup({ connector: low.connector, random: () => 0 });
    lowSetup.manager.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(low.attempts.map((a) => a.at)).toEqual([0, 800]);
    await lowSetup.manager.stop();

    vi.setSystemTime(0);
    const high = scriptedConnector([new Error("x"), fakeLink()]);
    const highSetup = setup({ connector: high.connector, random: () => 0.999_999 });
    highSetup.manager.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(high.attempts.map((a) => a.at)).toEqual([0, 1200]);
    await highSetup.manager.stop();

    vi.setSystemTime(0);
    const capped = scriptedConnector([]);
    const cappedSetup = setup({ connector: capped.connector, backoff: { initialMs: 1_000, maxMs: 4_000 } });
    cappedSetup.manager.start();
    await vi.advanceTimersByTimeAsync(20_000);
    const gaps = capped.attempts.slice(1).map((a, i) => a.at - (capped.attempts[i]?.at ?? 0));
    expect(gaps.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 4_000, 4_000]);
    await cappedSetup.manager.stop();
  });

  it("페어링 요구(GatewayPairingRequiredError)는 백오프와 무관하게 pairingRetryMs(기본 5s) 뒤 다시 붙는다", async () => {
    const { connector, attempts } = scriptedConnector([pairingError(), pairingError(), fakeLink()]);
    const { manager, logger } = setup({ connector });

    manager.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(attempts.map((a) => a.at)).toEqual([0, 5_000, 10_000]);
    expect(manager.state()).toBe("connected");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "e3fbfe98-1666-4506-b6e7-5d7f04783c47" }),
      expect.any(String),
    );
  });

  it("connector 에 URL·토큰·아이덴티티 경로와 4개 스코프·3개 caps·표시 이름을 넘기고, onEvent 를 이어 준다", async () => {
    const { connector, attempts } = scriptedConnector([fakeLink()]);
    const { manager, events } = setup({ connector });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    const options = attempts[0]?.options;
    expect(options).toMatchObject({
      url: GW.url,
      token: GW.token,
      deviceIdentityPath: GW.deviceIdentityPath,
      deviceTokenStorePath: GW.deviceTokenStorePath,
      scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
      caps: ["tool-events", "approvals", "session-scoped-events"],
      clientDisplayName: "dodok-server",
    });
    const frame: EventFrame = { type: "event", event: "health", payload: { ok: true } };
    options?.onEvent?.(frame);
    expect(events).toEqual([frame]);
  });

  it("gateway connected 로그에 hello-ok 의 server.version·buildId 를 gatewayVersion·gatewayBuildId 로 싣는다(없으면 null)", async () => {
    const withBuild = Object.assign(fakeLink(), {
      hello: { server: { version: "2026.9.5", buildId: "f396007" } },
    });
    // buildId 는 스키마의 선택 필드다
    const versionOnly = Object.assign(fakeLink(), { hello: { server: { version: "2026.9.4" } } });
    const { connector, attempts } = scriptedConnector([withBuild, versionOnly, fakeLink()]);
    const { manager, logger } = setup({ connector });
    const connectedLines = () =>
      logger.info.mock.calls.filter((call) => call[1] === "gateway connected").map((call) => call[0]);

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(connectedLines()).toEqual([
      {
        scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
        gatewayVersion: "2026.9.5",
        gatewayBuildId: "f396007",
      },
    ]);

    attempts[0]?.options.onClose?.({ code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connectedLines().at(-1)).toMatchObject({ gatewayVersion: "2026.9.4", gatewayBuildId: null });

    attempts[1]?.options.onClose?.({ code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connectedLines()).toHaveLength(3);
    expect(connectedLines().at(-1)).toMatchObject({ gatewayVersion: null, gatewayBuildId: null });
  });

  it("onClose → reconnecting, 이전 연결을 stop 하고 1s 뒤 다시 붙어 connected", async () => {
    const first = fakeLink();
    const second = fakeLink();
    const { connector, attempts } = scriptedConnector([first, second]);
    const { manager, states } = setup({ connector });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.state()).toBe("connected");

    attempts[0]?.options.onClose?.({ code: 1012, reason: "service restart" });
    expect(manager.state()).toBe("reconnecting");
    expect(first.stop).toHaveBeenCalled();
    await expect(manager.request("agents.list", {})).rejects.toMatchObject({ code: "ADAPTER_UNAVAILABLE" });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toHaveLength(2);
    expect(manager.state()).toBe("connected");
    expect(states).toEqual(["connected", "reconnecting", "connected"]);

    // 이미 버린 연결의 늦은 종료 알림은 무시한다
    attempts[0]?.options.onClose?.({ code: 1006, reason: "" });
    expect(manager.state()).toBe("connected");
  });

  it("stop() 은 대기 중인 재시도를 취소하고 연결을 닫아 down 이 된다", async () => {
    const { connector, attempts } = scriptedConnector([new Error("x")]);
    const { manager, states } = setup({ connector });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    await manager.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(attempts).toHaveLength(1);
    expect(states).toEqual(["reconnecting", "down"]);

    vi.setSystemTime(0);
    const link = fakeLink();
    const connected = setup({ connector: scriptedConnector([link]).connector });
    connected.manager.start();
    await vi.advanceTimersByTimeAsync(0);
    await connected.manager.stop();
    expect(link.stop).toHaveBeenCalled();
    expect(connected.manager.state()).toBe("down");
  });
});

describe("createConnectionManager — 상세(페어링·버전)", () => {
  it("페어링 요구는 pairing { requestId, since } 로 남고, 같은 requestId 가 다시 와도 since 는 처음 시각이다", async () => {
    const link = Object.assign(fakeLink(), { hello: { server: { version: "2026.9.5" } } });
    const { connector } = scriptedConnector([pairingError(), pairingError(), link]);
    const { manager, details } = setup({ connector });

    expect(manager.detail()).toEqual({ version: null, pairing: null });
    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    const pending = {
      version: null,
      pairing: { requestId: PAIRING_REQUEST_ID, since: new Date(0).toISOString() },
    };
    expect(manager.detail()).toEqual(pending);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.detail()).toEqual(pending);
    // 같은 상세가 반복되면 알리지 않는다
    expect(details).toEqual([pending]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.state()).toBe("connected");
    expect(manager.detail()).toEqual({ version: "2026.9.5", pairing: null });
    expect(details).toEqual([pending, { version: "2026.9.5", pairing: null }]);
  });

  it("requestId 가 바뀌면 since 를 새로 잡고, requestId 가 없으면 빈 문자열로 남긴다", async () => {
    const { connector } = scriptedConnector([pairingError("r-1"), pairingError("r-2"), pairingError(null)]);
    const { manager, details } = setup({ connector });

    manager.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(details.map((d) => d.pairing)).toEqual([
      { requestId: "r-1", since: new Date(0).toISOString() },
      { requestId: "r-2", since: new Date(5_000).toISOString() },
      { requestId: "", since: new Date(10_000).toISOString() },
    ]);
    await manager.stop();
  });

  it("페어링 대기 중 다른 접속 오류가 와도 pairing 은 남는다 — 지우는 것은 성공한 접속뿐", async () => {
    const { connector } = scriptedConnector([pairingError(), new Error("ECONNRESET")]);
    const { manager } = setup({ connector });

    manager.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.detail().pairing?.requestId).toBe(PAIRING_REQUEST_ID);
    await manager.stop();
  });
});

describe("gatewayHost", () => {
  it.each([
    ["wss://u:p@gw.example:443/path?x=1#frag", "gw.example:443"],
    ["wss://gw.example/gateway", "gw.example:443"],
    ["ws://127.0.0.1:18789", "127.0.0.1:18789"],
    ["ws://localhost", "localhost:80"],
    ["wss://[::1]:9000/", "[::1]:9000"],
  ])("%s → %s (자격 증명·경로·쿼리 없음)", (url, host) => {
    expect(gatewayHost(url)).toBe(host);
  });

  it.each([["not a url"], [""], ["wss://user:secret@"]])(
    "파싱이 안 되면 고정값 — 원문을 싣지 않는다 (%s)",
    (url) => {
      expect(gatewayHost(url)).toBe("(알 수 없음)");
    },
  );
});

describe("createConnectionManager — 재접속 복구", () => {
  it("연결마다 sessions.subscribe({}) → 세션별 sessions.messages.subscribe → chat.history(limit 50) 순서로 부른다", async () => {
    const link = fakeLink({
      "chat.history": () => ({ sessionKey: "k", messages: [{}, {}], completeSnapshot: true }),
    });
    const { manager, logger } = setup({
      connector: scriptedConnector([link]).connector,
      sessionKeysToRecover: () => [
        { sessionKey: KEY_A, agentId: "dev" },
        { sessionKey: KEY_B, agentId: "fin" },
      ],
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(link.calls.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "sessions.subscribe", params: {} },
      {
        method: "sessions.messages.subscribe",
        params: { key: KEY_A, agentId: "dev", includeApprovals: true },
      },
      { method: "chat.history", params: { sessionKey: KEY_A, agentId: "dev", limit: 50 } },
      {
        method: "sessions.messages.subscribe",
        params: { key: KEY_B, agentId: "fin", includeApprovals: true },
      },
      { method: "chat.history", params: { sessionKey: KEY_B, agentId: "fin", limit: 50 } },
    ]);
    expect(manager.historyCursors.size).toBe(0);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: KEY_A, messages: 2 }),
      expect.any(String),
    );
  });

  it("재접속 복구는 스레드 세션 키도 채널 키와 같이 다시 구독한다", async () => {
    const threadKey = `${KEY_A}:thread:01a09fc9-d204-7551-89d6-38544d07a2ab`;
    const link = fakeLink();
    const { manager } = setup({
      connector: scriptedConnector([link]).connector,
      sessionKeysToRecover: () => [
        { sessionKey: KEY_A, agentId: "dev" },
        { sessionKey: threadKey, agentId: "dev" },
      ],
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(link.calls.filter((c) => c.method === "sessions.messages.subscribe").map((c) => c.params)).toEqual(
      [
        { key: KEY_A, agentId: "dev", includeApprovals: true },
        { key: threadKey, agentId: "dev", includeApprovals: true },
      ],
    );
    // 복구 구독을 기억한다 — 전송 전 구독이 같은 키를 다시 보내지 않는다
    await manager.subscribeSession(threadKey, "dev");
    expect(link.calls.filter((c) => c.method === "sessions.messages.subscribe")).toHaveLength(2);
  });

  it('커서로 부른 chat.history 가 { kind: "reset" } 이면 커서 없이 한 번 더 부르고, 응답의 deltaCursor 를 저장한다', async () => {
    const link = fakeLink({
      "chat.history": (params) =>
        params.cursor ? { kind: "reset" } : { messages: [{ role: "system" }], deltaCursor: "c-new" },
    });
    const { manager } = setup({
      connector: scriptedConnector([link]).connector,
      sessionKeysToRecover: () => [{ sessionKey: KEY_A, agentId: "dev", cursor: "c-old" }],
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(link.calls.filter((c) => c.method === "chat.history").map((c) => c.params)).toEqual([
      { sessionKey: KEY_A, agentId: "dev", limit: 50, cursor: "c-old" },
      { sessionKey: KEY_A, agentId: "dev", limit: 50 },
    ]);
    expect(manager.historyCursors.get(KEY_A)).toBe("c-new");
  });

  it("저장한 커서는 다음 재접속에서 먼저 쓰고, reset 뒤 새 커서가 없으면 지운다", async () => {
    const first = fakeLink({ "chat.history": () => ({ kind: "delta", messages: [], deltaCursor: "c1" }) });
    const second = fakeLink({
      "chat.history": (params) => (params.cursor ? { kind: "reset" } : { messages: [] }),
    });
    const { connector, attempts } = scriptedConnector([first, second]);
    const { manager } = setup({
      connector,
      sessionKeysToRecover: () => [{ sessionKey: KEY_A, agentId: "dev" }],
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.historyCursors.get(KEY_A)).toBe("c1");

    attempts[0]?.options.onClose?.({ code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(second.calls.filter((c) => c.method === "chat.history").map((c) => c.params)).toEqual([
      { sessionKey: KEY_A, agentId: "dev", limit: 50, cursor: "c1" },
      { sessionKey: KEY_A, agentId: "dev", limit: 50 },
    ]);
    expect(manager.historyCursors.has(KEY_A)).toBe(false);
  });

  it("한 세션의 복구 오류는 warn 하고 다음 세션을 계속한다(sessions.subscribe 실패도 계속)", async () => {
    const link = fakeLink({
      "sessions.subscribe": () => {
        throw Object.assign(new Error("missing scope"), { code: "FORBIDDEN" });
      },
      "sessions.messages.subscribe": (params) => {
        if (params.key === KEY_A) throw new Error("boom");
        return { subscribed: true };
      },
    });
    const { manager, logger } = setup({
      connector: scriptedConnector([link]).connector,
      sessionKeysToRecover: () => [
        { sessionKey: KEY_A, agentId: "dev" },
        { sessionKey: KEY_B, agentId: "fin" },
      ],
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(link.calls.map((c) => c.method)).toEqual([
      "sessions.subscribe",
      "sessions.messages.subscribe",
      "sessions.messages.subscribe",
      "chat.history",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: KEY_A }),
      expect.any(String),
    );
    expect(manager.state()).toBe("connected");
  });
});

describe("createConnectionManager — 복구 끝 알림(onRecovered)", () => {
  it("세션 복구가 실패해도 복구를 다 돈 뒤 한 번 부르고, 다시 붙으면 또 부른다", async () => {
    const order: string[] = [];
    const link = fakeLink({
      "chat.history": () => {
        order.push("chat.history");
        throw new Error("history down");
      },
    });
    const second = fakeLink();
    const { connector, attempts } = scriptedConnector([link, second]);
    const onRecovered = vi.fn(() => order.push("recovered"));
    const { manager } = setup({
      connector,
      onRecovered,
      sessionKeysToRecover: () => [{ sessionKey: KEY_A, agentId: "dev" }],
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["chat.history", "recovered"]);

    attempts[0]?.options.onClose?.({ code: 1006, reason: "" });
    expect(onRecovered).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onRecovered).toHaveBeenCalledTimes(2);
  });

  it("복구 도중 끊기면 그 연결의 복구 끝은 알리지 않는다", async () => {
    let close: (() => void) | undefined;
    const link = fakeLink({
      "chat.history": () => {
        close?.();
        return {};
      },
    });
    const { connector, attempts } = scriptedConnector([link]);
    close = () => attempts[0]?.options.onClose?.({ code: 1006, reason: "" });
    const onRecovered = vi.fn();
    const { manager } = setup({
      connector,
      onRecovered,
      sessionKeysToRecover: () => [{ sessionKey: KEY_A, agentId: "dev" }],
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.state()).toBe("reconnecting");
    expect(onRecovered).not.toHaveBeenCalled();
  });
});

describe("createConnectionManager — 승인 되감기", () => {
  it("구독 응답의 approvalReplay 를 onApprovalReplay 로 흘린다(스파이크 5.3)", async () => {
    const link = fakeLink({
      "sessions.messages.subscribe": (params) =>
        params.key === KEY_A ? f.approvalSubscribeResult({ sessionKey: KEY_A }) : { subscribed: true },
    });
    const replayed: string[][] = [];
    const { manager } = setup({
      connector: scriptedConnector([link]).connector,
      onApprovalReplay: (approvals) => replayed.push(approvals.map((a) => a.providerApprovalId)),
      sessionKeysToRecover: () => [
        { sessionKey: KEY_A, agentId: "dev" },
        { sessionKey: KEY_B, agentId: "fin" },
      ],
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(replayed).toEqual([[f.APPROVAL_ID]]); // 되감을 것이 없는 세션은 부르지 않는다
  });

  it("subscribeSession(전송 전 구독)도 되감기를 흘린다", async () => {
    const link = fakeLink({
      "sessions.messages.subscribe": () => f.approvalSubscribeResult({ sessionKey: KEY_A }),
    });
    const replayed: string[][] = [];
    const { manager } = setup({
      connector: scriptedConnector([link]).connector,
      onApprovalReplay: (approvals) => replayed.push(approvals.map((a) => a.providerApprovalId)),
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    await manager.subscribeSession(KEY_A, "dev");

    expect(link.calls.at(-1)).toMatchObject({
      method: "sessions.messages.subscribe",
      params: { key: KEY_A, agentId: "dev", includeApprovals: true },
    });
    expect(replayed).toEqual([[f.APPROVAL_ID]]);
  });
});

describe("createConnectionManager — 복구 대상 조회 실패", () => {
  it("sessionKeysToRecover 가 던져도 warn 하고 연결은 connected 로 남는다", async () => {
    const link = fakeLink();
    const { manager, logger } = setup({
      connector: scriptedConnector([link]).connector,
      sessionKeysToRecover: () => {
        throw new Error("db closed");
      },
    });

    manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.state()).toBe("connected");
    expect(link.calls.map((c) => c.method)).toEqual(["sessions.subscribe"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.any(String),
    );
  });
});

describe("createConnectionManager — request", () => {
  async function connected(responses: Record<string, Responder>) {
    const link = fakeLink(responses);
    const { manager } = setup({ connector: scriptedConnector([link]).connector });
    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    return { manager, link };
  }

  it("연결이 없으면 ADAPTER_UNAVAILABLE", async () => {
    const { manager } = setup({ connector: scriptedConnector([]).connector });
    await expect(manager.request("agents.list", {})).rejects.toMatchObject({
      name: "AdapterError",
      code: "ADAPTER_UNAVAILABLE",
    });
  });

  it("응답을 그대로 돌려주고 timeoutMs 를 요청 옵션으로 넘긴다", async () => {
    const { manager, link } = await connected({ "chat.abort": () => ({ ok: true, aborted: true }) });

    await expect(manager.request("chat.abort", { sessionKey: KEY_A }, 7_000)).resolves.toEqual({
      ok: true,
      aborted: true,
    });
    expect(link.calls.at(-1)).toMatchObject({ method: "chat.abort", timeoutMs: 7_000 });
  });

  it("Gateway 오류를 AdapterError 로 바꾼다: MISSING_SCOPE·FORBIDDEN → FORBIDDEN, CLIENT_TIMEOUT → TIMEOUT, 그 밖 → INTERNAL(cause)", async () => {
    const missingScope = Object.assign(new Error("missing scope: operator.admin"), {
      code: "INVALID_REQUEST",
      details: { code: "MISSING_SCOPE", missingScope: "operator.admin" },
    });
    const forbidden = Object.assign(new Error("forbidden"), { code: "FORBIDDEN" });
    const timeout = Object.assign(new Error("timed out"), { code: "CLIENT_TIMEOUT" });
    const other = Object.assign(new Error("unavailable"), { code: "UNAVAILABLE" });
    const { manager } = await connected({
      "m.scope": () => {
        throw missingScope;
      },
      "m.forbidden": () => {
        throw forbidden;
      },
      "m.timeout": () => {
        throw timeout;
      },
      "m.other": () => {
        throw other;
      },
    });

    await expect(manager.request("m.scope", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(manager.request("m.forbidden", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(manager.request("m.timeout", {})).rejects.toMatchObject({ code: "TIMEOUT" });
    const error = await manager.request("m.other", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ code: "INTERNAL", cause: other });
    expect((error as Error).message).toContain("m.other");
  });
});

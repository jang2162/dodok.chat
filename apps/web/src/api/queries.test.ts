import { describe, expect, it } from "vitest";
import { openclawAdapterStatus, summarizeGateways } from "./queries";

const CAPS = { sessionReset: true, agentsList: true, configSet: true };
const G1 = {
  id: "01a00000-0000-7000-8000-0000000000a1",
  name: "사무실",
  enabled: true,
  gateway: "connected",
  bridge: "connected",
} as const;
const G2 = { ...G1, id: "01a00000-0000-7000-8000-0000000000a2", name: "집" } as const;

describe("summarizeGateways — 지금 화면(점·배너·운영 카드)이 읽는 한 값", () => {
  it("켜진 Gateway 가운데 가장 나쁜 gateway, 플러그인은 켜진 Gateway 모두에 붙어야 connected", () => {
    expect(summarizeGateways([G1, G2])).toEqual({ gateway: "connected", bridge: "connected" });
    expect(summarizeGateways([G1, { ...G2, gateway: "reconnecting" }])).toEqual({
      gateway: "reconnecting",
      bridge: "connected",
    });
    expect(
      summarizeGateways([
        { ...G1, gateway: "down" },
        { ...G2, gateway: "reconnecting" },
      ]).gateway,
    ).toBe("down");
    expect(summarizeGateways([G1, { ...G2, bridge: "down" }]).bridge).toBe("down");
  });

  it("꺼진 Gateway 는 세지 않고, 켜진 Gateway 가 없으면 down/down", () => {
    const off = { ...G2, enabled: false, gateway: "disabled", bridge: "down" } as const;
    expect(summarizeGateways([G1, off])).toEqual({ gateway: "connected", bridge: "connected" });
    expect(summarizeGateways([off])).toEqual({ gateway: "down", bridge: "down" });
    expect(summarizeGateways([])).toEqual({ gateway: "down", bridge: "down" });
  });
});

describe("openclawAdapterStatus", () => {
  it("어댑터 목록에서 OpenClaw 상태와 그 capabilities 를 한 캐시 값으로 고른다 — 다른 제공자는 무시한다", () => {
    expect(
      openclawAdapterStatus({
        statuses: [
          { provider: "claude", runners: { connected: 1, tokens: 1 } },
          { provider: "openclaw", gateways: [G1, { ...G2, gateway: "reconnecting", bridge: "down" }] },
        ],
        capabilities: { claude: { ...CAPS, sessionReset: false }, openclaw: CAPS },
      }),
    ).toEqual({
      provider: "openclaw",
      gateways: [G1, { ...G2, gateway: "reconnecting", bridge: "down" }],
      gateway: "reconnecting",
      bridge: "down",
      capabilities: CAPS,
    });
  });

  it("OpenClaw 어댑터가 없으면 null", () => {
    expect(
      openclawAdapterStatus({
        statuses: [{ provider: "claude", runners: { connected: 0, tokens: 0 } }],
        capabilities: { claude: CAPS },
      }),
    ).toBeNull();
  });
});

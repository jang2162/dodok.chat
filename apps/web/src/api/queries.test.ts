import { describe, expect, it } from "vitest";
import { openclawAdapterStatus } from "./queries";

const CAPS = { agentsList: true, configSet: true };
const G1 = {
  id: "01a00000-0000-7000-8000-0000000000a1",
  name: "사무실",
  enabled: true,
  gateway: "connected",
  bridge: "connected",
} as const;
const G2 = { ...G1, id: "01a00000-0000-7000-8000-0000000000a2", name: "집" } as const;

describe("openclawAdapterStatus", () => {
  it("어댑터 목록에서 OpenClaw 상태와 그 capabilities 를 한 캐시 값으로 고른다 — 다른 제공자는 무시한다", () => {
    expect(
      openclawAdapterStatus({
        statuses: [
          { provider: "claude", runners: { connected: 1, tokens: 1 } },
          { provider: "openclaw", gateways: [G1, { ...G2, gateway: "reconnecting", bridge: "down" }] },
        ],
        capabilities: { claude: { ...CAPS, configSet: false }, openclaw: CAPS },
      }),
    ).toEqual({
      provider: "openclaw",
      gateways: [G1, { ...G2, gateway: "reconnecting", bridge: "down" }],
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

import { describe, expect, it } from "vitest";
import { openclawAdapterStatus } from "./queries";

const CAPS = { sessionReset: true, agentsList: true, configSet: true };

describe("openclawAdapterStatus", () => {
  it("어댑터 목록에서 OpenClaw 상태와 그 capabilities 를 한 캐시 값으로 고른다 — 다른 제공자는 무시한다", () => {
    expect(
      openclawAdapterStatus({
        statuses: [
          { provider: "claude", runners: { connected: 1, tokens: 1 } },
          { provider: "openclaw", gateway: "reconnecting", bridge: "down" },
        ],
        capabilities: { claude: { ...CAPS, sessionReset: false }, openclaw: CAPS },
      }),
    ).toEqual({ provider: "openclaw", gateway: "reconnecting", bridge: "down", capabilities: CAPS });
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

import { describe, expect, it } from "vitest";
import { openclawAdapterStatus, qk } from "./queries";

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
          { provider: "runner", runners: { connected: 1, tokens: 1 } },
          { provider: "openclaw", gateways: [G1, { ...G2, gateway: "reconnecting", bridge: "down" }] },
        ],
        capabilities: { runner: { ...CAPS, configSet: false }, openclaw: CAPS },
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
        statuses: [{ provider: "runner", runners: { connected: 0, tokens: 0 } }],
        capabilities: { runner: CAPS },
      }),
    ).toBeNull();
  });
});

describe("qk 무효화용 앞머리", () => {
  // 앞머리로 무효화하는 자리(재연결 — realtime/handlers)가 리터럴 대신 이 키를 쓴다. 앞머리가 어긋나면 무효화가 아무것도 고르지 않는다
  const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) =>
    prefix.every((part, i) => key[i] === part);
  it("세션 하나·세션 목록 칸 앞머리는 그 키들의 앞머리다", () => {
    expect(startsWith(qk.conversation("c1"), qk.conversationAll)).toBe(true);
    expect(startsWith(qk.conversationList("ch", "open", ""), qk.conversationListAll)).toBe(true);
    expect(startsWith(qk.channelConversationLists("ch"), qk.conversationListAll)).toBe(true);
    // 세션 목록 첫 쪽(`conversations`)은 다른 앞머리다 — 세션 하나 무효화에 끌려가지 않는다
    expect(startsWith(qk.conversations("ch", "open"), qk.conversationAll)).toBe(false);
  });
});

import { OPENCLAW_PINNED_VERSION } from "@dodok/openclaw-adapter";
import { describe, expect, it } from "vitest";
import { gatewayPin } from "../src/modules/ops/health";

describe("gatewayPin — 버전 드리프트는 핀과 정확히 같을 때만 false", () => {
  it("핀을 접두로 가진 다른 버전(끝자리가 더 붙음·프리릴리스)도 drift", () => {
    expect(gatewayPin(`${OPENCLAW_PINNED_VERSION}0`)).toEqual({
      pinned: OPENCLAW_PINNED_VERSION,
      drift: true,
    });
    expect(gatewayPin(`${OPENCLAW_PINNED_VERSION}-beta`)).toEqual({
      pinned: OPENCLAW_PINNED_VERSION,
      drift: true,
    });
    expect(gatewayPin(OPENCLAW_PINNED_VERSION)).toEqual({ pinned: OPENCLAW_PINNED_VERSION, drift: false });
    expect(gatewayPin(null)).toEqual({ pinned: OPENCLAW_PINNED_VERSION, drift: false });
  });
});

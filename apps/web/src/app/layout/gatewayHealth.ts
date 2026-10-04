import type { OpenClawGatewayStatus } from "@dodok/shared";

type GatewayLink = Pick<OpenClawGatewayStatus, "enabled" | "gateway" | "bridge">;

/**
 * 배너가 이름을 부를 Gateway — 켜져 있는데 Gateway 에 붙지 않았거나 그 플러그인이 끊겼다.
 * 꺼진 Gateway 는 끊김이 아니다(끈 것은 고장이 아니다, 멀티 Gateway 스펙 「웹」 절)
 */
export const gatewayDown = (g: GatewayLink): boolean =>
  g.enabled && (g.gateway !== "connected" || g.bridge === "down");

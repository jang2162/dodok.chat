// 서버 코어 스펙 6.1 — 어댑터 계약의 정본은 @dodok/shared(러너 스펙 2장). 서버 모듈은 여기서 가져간다.
import type { OpenClawAdapter } from "@dodok/openclaw-adapter";
import type { AgentAdapter } from "@dodok/shared";

export type {
  AdapterCapabilities,
  AdapterEvent,
  AdapterProvider,
  AdapterSetupDetail,
  AgentAdapter,
  OpenClawAdapterStatus,
  OpenClawSetupDetail,
  RunEventBody,
} from "@dodok/shared";
export { AdapterError } from "@dodok/shared";
export type { GatewayConnectionConfig, GatewaySetupEntry } from "@dodok/openclaw-adapter";

/**
 * OpenClaw 어댑터가 서버에 내는 Gateway 조작(멀티 Gateway 스펙 5.1) — 계약(`AgentAdapter`) 밖이라 따로 묶는다. 실물
 * (`createOpenClawAdapter`)과 테스트의 `FakeAdapter` 가 갖는다
 */
export type OpenClawGateways = Pick<
  OpenClawAdapter,
  "upsertGateway" | "removeGateway" | "gatewaySetupDetails" | "revokeTokenSessions"
>;

/** 레지스트리의 OpenClaw 어댑터가 Gateway 를 다룰 줄 아는가 */
export function hasGateways(adapter: AgentAdapter): adapter is AgentAdapter & OpenClawGateways {
  const a = adapter as Partial<OpenClawGateways>;
  return (
    typeof a.upsertGateway === "function" &&
    typeof a.removeGateway === "function" &&
    typeof a.gatewaySetupDetails === "function"
  );
}

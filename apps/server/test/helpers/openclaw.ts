import type {
  AgentAdapter,
  OpenClawAdapterStatus,
  OpenClawGatewayStatus,
  OpenClawSetupDetail,
} from "@dodok/shared";

/** 앱 레지스트리의 OpenClaw 어댑터 — 앱은 늘 하나 가진다(createApp) */
export function openclawOf(app: {
  registry: { forProvider(p: "openclaw"): AgentAdapter | undefined };
}): AgentAdapter {
  const adapter = app.registry.forProvider("openclaw");
  if (!adapter) throw new Error("app has no OpenClaw adapter");
  return adapter;
}

// 앱의 어댑터는 AgentAdapter 로 쥐어 있다 — OpenClaw 경로를 재는 테스트가 gateway·bridge 를 좁혀 읽는다. 다른 어댑터면 테스트가 틀렸다

export function openclawStatus(adapter: Pick<AgentAdapter, "status">): OpenClawAdapterStatus {
  const status = adapter.status();
  if (status.provider !== "openclaw") throw new Error(`not an OpenClaw adapter: ${status.provider}`);
  return status;
}

/** Gateway 하나뿐인 앱의 그 Gateway 상태 줄 — 하나가 아니면 테스트가 틀렸다 */
export function soleGateway(adapter: Pick<AgentAdapter, "status">): OpenClawGatewayStatus {
  const { gateways } = openclawStatus(adapter);
  const [only] = gateways;
  if (!only || gateways.length !== 1) throw new Error(`expected one gateway, got ${gateways.length}`);
  return only;
}

export function openclawDetail(adapter: Pick<AgentAdapter, "setupDetail">): OpenClawSetupDetail {
  const detail = adapter.setupDetail();
  if (detail.provider !== "openclaw") throw new Error(`not an OpenClaw adapter: ${detail.provider}`);
  return detail;
}

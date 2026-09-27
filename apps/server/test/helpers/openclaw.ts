import type { AgentAdapter, OpenClawAdapterStatus, OpenClawSetupDetail } from "@dodok/shared";

// 앱의 어댑터는 AgentAdapter 로 쥐어 있다 — OpenClaw 경로를 재는 테스트가 gateway·bridge 를 좁혀 읽는다. 다른 어댑터면 테스트가 틀렸다

export function openclawStatus(adapter: Pick<AgentAdapter, "status">): OpenClawAdapterStatus {
  const status = adapter.status();
  if (status.provider !== "openclaw") throw new Error(`not an OpenClaw adapter: ${status.provider}`);
  return status;
}

export function openclawDetail(adapter: Pick<AgentAdapter, "setupDetail">): OpenClawSetupDetail {
  const detail = adapter.setupDetail();
  if (detail.provider !== "openclaw") throw new Error(`not an OpenClaw adapter: ${detail.provider}`);
  return detail;
}

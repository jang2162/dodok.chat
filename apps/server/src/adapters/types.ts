// 서버 코어 스펙 6.1 — 어댑터 계약의 정본은 @dodok/shared(러너 스펙 2장). 서버 모듈은 여기서 가져간다.
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

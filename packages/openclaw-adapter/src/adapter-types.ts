// 어댑터 계약의 정본은 @dodok/shared(러너 스펙 2장 — 러너 어댑터와 함께 쓴다). 이 파일은 기존 import 경로를 지키는 re-export
export {
  AdapterError,
  type AdapterCapabilities,
  type AdapterEvent,
  type AdapterLogger,
  type AdapterProvider,
  type AdapterSendResult,
  type AdapterSetupDetail,
  type AdapterStatus,
  type AgentAdapter,
  type ClaudeAdapterStatus,
  type ClaudeSetupDetail,
  type OpenClawAdapterStatus,
  type OpenClawSetupDetail,
  type ProviderApproval,
  type RunEventBody,
} from "@dodok/shared";

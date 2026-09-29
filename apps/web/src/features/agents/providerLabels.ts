import type { AdapterProvider } from "@dodok/shared";

/** 제공자마다 에이전트 id 의 이름 — 등록 폼과 목록 줄이 함께 쓴다 */
export const PROVIDER_ID_LABEL: Record<AdapterProvider, string> = {
  openclaw: "OpenClaw id",
  claude: "Claude 러너 에이전트 id",
};

/** 목록 줄용 — 등록 대상이 아닌 제공자(Agent.provider 에는 있다)는 일반 문구 */
export const providerIdLabel = (provider: string): string =>
  provider in PROVIDER_ID_LABEL ? PROVIDER_ID_LABEL[provider as AdapterProvider] : "에이전트 id";

import { type AdapterProvider, RUNNER_PROGRAM_NAME, type RunnerProgram } from "@dodok/shared";

/** 제공자마다 에이전트 id 의 이름 — 등록 폼과 목록 줄이 함께 쓴다 */
export const PROVIDER_ID_LABEL: Record<AdapterProvider, string> = {
  openclaw: "OpenClaw id",
  runner: "Claude 러너 에이전트 id",
};

/** 목록 줄용 — 등록 대상이 아닌 제공자(Agent.provider 에는 있다)는 일반 문구 */
export const providerIdLabel = (provider: string): string =>
  provider in PROVIDER_ID_LABEL ? PROVIDER_ID_LABEL[provider as AdapterProvider] : "에이전트 id";

/** 제공자 이름 — 등록 대화상자의 제공자 고르기와 DM 머리가 함께 쓴다 */
export const PROVIDER_NAME: Record<AdapterProvider, string> = { openclaw: "OpenClaw", runner: "러너" };

/** 등록 대상이 아닌 제공자(Agent.provider 에는 있다)는 값 그대로 */
export const providerName = (provider: string): string =>
  provider in PROVIDER_NAME ? PROVIDER_NAME[provider as AdapterProvider] : provider;

/** 러너 에이전트의 프로그램 이름(Agent.program) — 정본은 shared RUNNER_PROGRAM_NAME */
export const PROGRAM_NAME: Record<RunnerProgram, string> = RUNNER_PROGRAM_NAME;

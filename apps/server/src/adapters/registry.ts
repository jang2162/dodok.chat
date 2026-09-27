import type { AdapterProvider } from "@dodok/shared";
import { type AdapterEvent, AdapterError, type AgentAdapter } from "./types";

/**
 * 서버에 붙은 어댑터들(러너 스펙 2장). 런·세션·승인·리셋은 에이전트 행의 provider 로(forAgent), OpenClaw 전용 감시(Gateway 버전·재연결·
 * 페어링)는 forProvider("openclaw") 로, 상태·이벤트 구독은 all() 로 고른다
 */
export interface AdapterRegistry {
  all(): readonly AgentAdapter[];
  forProvider(p: AdapterProvider): AgentAdapter | undefined;
  /** 에이전트 행의 provider 로 — 없으면 AdapterError("ADAPTER_UNAVAILABLE") */
  forAgent(agent: { provider: string }): AgentAdapter;
  /** all() 의 이벤트를 한 핸들러로 — 이벤트에 어느 어댑터에서 왔는지 붙인다 */
  onEvent(handler: (e: AdapterEvent, from: AgentAdapter) => void): () => void;
}

/** 같은 provider 가 둘이면 던진다 — 에이전트를 어느 쪽으로 보낼지 정할 수 없다 */
export function createAdapterRegistry(adapters: AgentAdapter[]): AdapterRegistry {
  const list: readonly AgentAdapter[] = [...adapters];
  const byProvider = new Map<string, AgentAdapter>();
  for (const adapter of list) {
    if (byProvider.has(adapter.provider)) throw new Error(`duplicate adapter provider: ${adapter.provider}`);
    byProvider.set(adapter.provider, adapter);
  }
  return {
    all: () => list,
    forProvider: (p) => byProvider.get(p),
    forAgent(agent) {
      const adapter = byProvider.get(agent.provider);
      if (!adapter)
        throw new AdapterError("ADAPTER_UNAVAILABLE", `no adapter for provider ${agent.provider}`);
      return adapter;
    },
    onEvent(handler) {
      const offs = list.map((adapter) => adapter.onEvent((e) => handler(e, adapter)));
      return () => {
        for (const off of offs) off();
      };
    },
  };
}

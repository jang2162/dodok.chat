import type { Agent } from "@dodok/shared";

/** OpenClaw 에이전트의 「 · Gateway 이름」 — 두 Gateway 의 같은 id 를 가른다(에이전트 화면 줄·멘션 후보와 같은 꼴). 연결이 비었으면 없다 */
export const gatewaySuffix = (agent: Agent) =>
  agent.provider === "openclaw" && agent.gateway ? ` · ${agent.gateway.name}` : "";

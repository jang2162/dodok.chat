import { roleAtLeast } from "@dodok/shared";
import { useQueries } from "@tanstack/react-query";
import { useAdapterStatus, useAgents, useRole } from "@/api/queries";
import { runnerProjectsQuery, useRunners } from "@/features/runners/queries";
import { gatewayStateLabel } from "@/features/setup/GatewayCard";
import { useSetupStatus } from "@/features/setup/queries";
import {
  type ConnectionTree,
  type RunnerStateLabel,
  buildConnectionTree,
  wireGatewayStateLabel,
} from "./tree";

/** 러너 요약의 배지 — 폐기가 끊김보다 앞선다 */
export const runnerStateLabel = (r: { connected: boolean; revoked: boolean }): RunnerStateLabel =>
  r.revoked ? "폐기됨" : r.connected ? "연결됨" : "끊김";

/**
 * 「연결」 트리(연결 탭 통합 스펙 3.2 「역할별로 보이는 트리」) — 역할마다 부를 수 있는 API 만 부른다. 역할에 없는 API(owner 의
 * `GET /setup/status`, admin 의 `GET /runners`)를 부르면 전역 토스트 「권한이 없습니다」가 뜨므로 `enabled` 로 막는다.
 * member: 에이전트 + wire Gateway 목록(러너는 에이전트에서 짓는다). admin: + 러너·프로젝트. owner: Gateway 상태를 setup 에서(페어링 대기까지)
 */
export function useConnectionTree() {
  const role = useRole();
  const admin = roleAtLeast(role, "admin");
  const owner = role === "owner";
  const agents = useAgents();
  const adapter = useAdapterStatus();
  const setup = useSetupStatus({ enabled: owner });
  const runners = useRunners({ enabled: admin });
  const projects = useQueries({
    queries: (admin ? (runners.data ?? []) : []).map((r) => runnerProjectsQuery(r.id)),
  });
  const projectList = admin ? projects.flatMap((q) => q.data ?? []) : null;

  // 렌더마다 새로 짓는다 — 에이전트·연결은 수십 개라 값싸고, 쿼리 여럿의 바뀜을 따로 지켜볼 필요가 없다
  const tree = ((): ConnectionTree | undefined => {
    if (!agents.data) return undefined;
    const gateways = owner
      ? (setup.data?.gateways.map((g) => ({ id: g.id, name: g.name, state: gatewayStateLabel(g) })) ??
        adapter.data?.gateways.map((g) => ({ id: g.id, name: g.name, state: wireGatewayStateLabel(g) })) ??
        [])
      : (adapter.data?.gateways.map((g) => ({ id: g.id, name: g.name, state: wireGatewayStateLabel(g) })) ??
        []);
    return buildConnectionTree({
      agents: agents.data,
      gateways,
      // 러너 목록을 아직 못 받았으면(또는 실패) 에이전트에서 짓는다 — 러너 에이전트가 「연결 없음」으로 깜빡이지 않게
      runners:
        admin && runners.data
          ? runners.data.map((r) => ({ id: r.id, label: r.label, state: runnerStateLabel(r) }))
          : null,
      projects: projectList,
      meId: null,
    });
  })();

  return {
    tree,
    pending: agents.isPending,
    error: !agents.data && agents.isError,
    refetching: agents.isFetching,
    refetch: () => void agents.refetch(),
    setup: owner ? setup.data : undefined,
    runners: admin ? runners.data : undefined,
    projects: projectList,
  };
}

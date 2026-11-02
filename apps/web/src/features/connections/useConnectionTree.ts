import { type Agent, type ConnectionsResponse, roleAtLeast } from "@dodok/shared";
import { useQueries } from "@tanstack/react-query";
import { useAdapterStatus, useAgents, useCachedMe, useRole } from "@/api/queries";
import { runnerProjectsQuery, useRunners } from "@/features/runners/queries";
import { gatewayStateLabel } from "@/features/setup/GatewayCard";
import { useSetupStatus } from "@/features/setup/queries";
import { useConnectionList } from "./queries";
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
 * 「연결」 트리(연결 탭 통합 스펙 3.2·5.3). 누구나 연결 목록(`GET /connections` — 주인·승인 대기·러너·프로젝트 이름)을 받고, Gateway 상태는
 * 설정 상태(그 사람이 볼 수 있는 Gateway — 페어링 대기까지)가 있으면 그것으로, 없으면 wire Gateway 목록으로 단다. 설정 상태는 admin 이상과
 * 연결을 가진 사람만 부른다(가진 것이 없으면 걸러져 비어 온다). admin 이상은 러너 REST(목록·러너마다 프로젝트)도 받는다 — 프로젝트 상세가
 * 루트·경로를 그린다. 연결 목록을 못 받으면(옛 서버) 1단계 길(러너는 에이전트에서)로 짓는다
 */
export function useConnectionTree() {
  const role = useRole();
  const meId = useCachedMe()?.user.id ?? null;
  const admin = roleAtLeast(role, "admin");
  const agents = useAgents();
  const adapter = useAdapterStatus();
  const list = useConnectionList();
  const owners = connectionOwnerMaps(list.data);
  const holdsAny = meId !== null && [...owners.gateways.values(), ...owners.runners.values()].includes(meId);
  const setup = useSetupStatus({ enabled: admin || holdsAny });
  const runners = useRunners({ enabled: admin });
  const projects = useQueries({
    queries: (admin ? (runners.data ?? []) : []).map((r) => runnerProjectsQuery(r.id)),
  });
  const projectList = admin ? projects.flatMap((q) => q.data ?? []) : null;

  // 렌더마다 새로 짓는다 — 에이전트·연결은 수십 개라 값싸고, 쿼리 여럿의 바뀜을 따로 지켜볼 필요가 없다
  const tree = ((): ConnectionTree | undefined => {
    if (!agents.data) return undefined;
    const listed = new Map((list.data?.gateways ?? []).map((g) => [g.id, g]));
    const setupGateways = new Map((setup.data?.gateways ?? []).map((g) => [g.id, g]));
    // 어느 Gateway 가 있는가의 정본 — admin 이상은 설정 상태(모든 Gateway, 지운 것이 곧바로 빠진다), 그 밖은 연결 목록(누구나 전부),
    // 둘 다 없으면 wire 목록. 차례는 셋 다 더한 차례다
    const ids =
      admin && setup.data
        ? [...setupGateways.keys()]
        : list.data
          ? [...listed.keys()]
          : (adapter.data?.gateways ?? []).map((g) => g.id);
    const wire = new Map((adapter.data?.gateways ?? []).map((g) => [g.id, g]));
    const gateways = ids.map((id) => {
      const fromList = listed.get(id);
      const fromSetup = setupGateways.get(id);
      const fromWire = wire.get(id);
      const approved = fromList?.approved ?? fromSetup?.approved ?? true;
      const state = !approved
        ? ("승인 대기" as const)
        : fromSetup
          ? gatewayStateLabel(fromSetup)
          : fromWire
            ? wireGatewayStateLabel(fromWire)
            : null;
      return {
        id,
        name: fromList?.name ?? fromSetup?.name ?? fromWire?.name ?? "",
        state,
        ownerUserId: fromList?.owner?.id ?? null,
        approved,
      };
    });
    const runnerNodes =
      admin && runners.data
        ? runners.data.map((r) => ({
            id: r.id,
            label: r.label,
            state: runnerStateLabel(r),
            ownerUserId: owners.runners.get(r.id) ?? null,
          }))
        : list.data
          ? list.data.runners.map((r) => ({
              id: r.id,
              label: r.label,
              state: runnerStateLabel(r),
              ownerUserId: r.owner?.id ?? null,
            }))
          : null;
    const projectNodes = projectList
      ? projectList.map((p) => ({
          id: p.id,
          runnerId: p.runnerId,
          label: p.label,
          archived: p.archivedAt !== null,
        }))
      : (list.data?.projects ?? null);
    return buildConnectionTree({
      agents: agents.data,
      gateways,
      // 러너 목록을 아직 못 받았으면(또는 실패) 에이전트에서 짓는다 — 러너 에이전트가 「연결 없음」으로 깜빡이지 않게
      runners: runnerNodes,
      projects: projectNodes,
      meId: list.data ? meId : null,
    });
  })();

  return {
    tree,
    pending: agents.isPending,
    error: !agents.data && agents.isError,
    refetching: agents.isFetching,
    refetch: () => void agents.refetch(),
    setup: setup.data,
    runners: admin ? runners.data : undefined,
    projects: projectList,
    /** 연결 목록(주인 이름·승인 대기) — 못 받았으면 undefined */
    connections: list.data,
    /** 러너 목록과 러너마다의 프로젝트를 다 받았는가(실패 포함) — 프로젝트 상세가 「찾을 수 없습니다」를 가를 때 */
    projectsSettled: admin && runners.data !== undefined && projects.every((q) => !q.isPending),
  };
}

/** 연결 목록의 주인 표 — 연결 id → 주인 사용자 id(없으면 null) */
export function connectionOwnerMaps(list: ConnectionsResponse | undefined): {
  gateways: ReadonlyMap<string, string | null>;
  runners: ReadonlyMap<string, string | null>;
} {
  return {
    gateways: new Map((list?.gateways ?? []).map((g) => [g.id, g.owner?.id ?? null])),
    runners: new Map((list?.runners ?? []).map((r) => [r.id, r.owner?.id ?? null])),
  };
}

/** 에이전트 연결의 주인 — OpenClaw 는 그 Gateway, 러너 에이전트는 그 러너. 연결 목록을 모르거나 연결이 없으면 null */
export function agentOwnerOf(agent: Agent, list: ConnectionsResponse | undefined): string | null {
  const owners = connectionOwnerMaps(list);
  if (agent.provider === "runner")
    return agent.runner ? (owners.runners.get(agent.runner.tokenId) ?? null) : null;
  return agent.gateway ? (owners.gateways.get(agent.gateway.id) ?? null) : null;
}

/** 연결 주인의 이름 — 메타 줄 「주인 <이름>」 */
export function ownerNameOf(
  list: ConnectionsResponse | undefined,
  kind: "gateway" | "runner",
  id: string,
): string | null {
  const found =
    kind === "gateway" ? list?.gateways.find((g) => g.id === id) : list?.runners.find((r) => r.id === id);
  return found?.owner?.name ?? null;
}

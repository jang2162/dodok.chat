import type { Agent, OpenClawGatewayStatus } from "@dodok/shared";
import type { gatewayStateLabel } from "@/features/setup/GatewayCard";

/**
 * 「연결」 탭의 트리(연결 탭 통합 스펙 3.2) — 연결(Gateway·러너) 아래 프로젝트, 그 아래 에이전트. 역할마다 서버가 주는 값이 달라
 * (member 는 러너 목록·프로젝트를 모른다) 모르는 칸은 null 로 받고 있는 것만으로 짓는다. 순수 함수 — 쿼리는 `useConnectionTree`
 */

/** Gateway 배지 — Gateway 상세의 판정(`gatewayStateLabel`) 그대로, 승인 전이면 「승인 대기」(연결 탭 통합 스펙 5.4) */
export type GatewayStateLabel = ReturnType<typeof gatewayStateLabel> | "승인 대기";
export type RunnerStateLabel = "연결됨" | "끊김" | "폐기됨";

export type TreeAgent = { kind: "agent"; agent: Agent };
export type TreeProject = {
  kind: "project";
  id: string;
  label: string;
  runnerId: string;
  agents: TreeAgent[];
  /** 이 프로젝트(git 저장소) 아래의 워크트리 하위 프로젝트(워크트리 스펙 W2) — 워크트리 자신은 늘 빈 목록 */
  worktrees: TreeProject[];
};
export type TreeGateway = {
  kind: "gateway";
  id: string;
  name: string;
  /** null — 이 역할이 상태를 모른다(에이전트에서만 본 Gateway) */
  state: GatewayStateLabel | null;
  ownerUserId: string | null;
  approved: boolean;
  agents: TreeAgent[];
};
export type TreeRunner = {
  kind: "runner";
  id: string;
  label: string;
  /** null — 이 역할은 러너 상태를 모른다(member — 에이전트의 러너 요약에서 지었다) */
  state: RunnerStateLabel | null;
  ownerUserId: string | null;
  projects: TreeProject[];
  /** 그 러너의 봇(러너 봇 스펙 B11) — 프로젝트 없이 봇 폴더에서 돈다. 트리에서는 러너 아래 「봇」 묶음 */
  bots: TreeAgent[];
  /** 프로젝트를 모르거나 프로젝트에 묶이지 않은 그 러너의 에이전트(봇 빼고) */
  agents: TreeAgent[];
};
export type TreeConnection = TreeGateway | TreeRunner;
export type ConnectionTree = {
  mine: TreeConnection[];
  others: TreeConnection[];
  /** 연결이 없는 에이전트 — Gateway 가 지워졌거나, 러너가 없거나 폐기됐다 */
  orphaned: TreeAgent[];
  /** 보관(삭제)한 에이전트 — 어느 연결에도 달지 않는다 */
  archived: Agent[];
};
export type TreeProjectInput = {
  id: string;
  runnerId: string;
  label: string;
  archived: boolean;
  /** 워크트리면 부모 프로젝트 id — 연결 목록(member)은 싣지 않아 그때는 부모 아래로 묶지 않는다 */
  parentProjectId?: string | null;
};
export type TreeInput = {
  agents: Agent[];
  gateways: {
    id: string;
    name: string;
    state: GatewayStateLabel | null;
    ownerUserId?: string | null;
    approved?: boolean;
  }[];
  /** null — 이 역할은 러너 목록을 모른다 */
  runners:
    | { id: string; label: string; state: RunnerStateLabel | null; ownerUserId?: string | null }[]
    | null;
  /** null — 이 역할은 프로젝트를 모른다. 러너 REST 의 프로젝트(`archivedAt`)·연결 목록의 프로젝트(`archived`) 둘 다 받는다 */
  projects: TreeProjectInput[] | null;
  /** null — 나를 모른다(주인 가름 없음). 모든 연결을 `others` 에 넣는다 */
  meId: string | null;
};

/** 상태 색(연결 재설계 스펙 「정한 것」) — 연결됨 = success, 꺼짐·폐기 = muted, 그 밖(끊김·승인 대기·재연결 등) = warning */
export type StateTone = "success" | "warning" | "muted";
export function stateTone(label: GatewayStateLabel | RunnerStateLabel | string): StateTone {
  if (label === "연결됨") return "success";
  if (label === "꺼짐" || label === "폐기됨") return "muted";
  return "warning";
}

/** wire `adapter.status` 의 Gateway 줄 하나의 배지 — 페어링 대기는 이 줄로 알 수 없다(owner 의 setup.status 만 안다) */
export function wireGatewayStateLabel(g: OpenClawGatewayStatus): GatewayStateLabel {
  if (!g.enabled || g.gateway === "disabled") return "꺼짐";
  if (g.gateway === "connected") return "연결됨";
  if (g.gateway === "reconnecting") return "재연결 중";
  return "연결 안 됨";
}

export function buildConnectionTree(input: TreeInput): ConnectionTree {
  const gateways = new Map<string, TreeGateway>();
  for (const g of input.gateways)
    gateways.set(g.id, {
      kind: "gateway",
      id: g.id,
      name: g.name,
      state: g.state,
      ownerUserId: g.ownerUserId ?? null,
      approved: g.approved ?? true,
      agents: [],
    });
  const runners = new Map<string, TreeRunner>();
  const runnerNode = (id: string, label: string, state: RunnerStateLabel | null, owner: string | null) => {
    const node: TreeRunner = {
      kind: "runner",
      id,
      label,
      state,
      ownerUserId: owner,
      projects: [],
      bots: [],
      agents: [],
    };
    runners.set(id, node);
    return node;
  };
  for (const r of input.runners ?? []) runnerNode(r.id, r.label, r.state, r.ownerUserId ?? null);
  const projects = new Map<string, TreeProject>();
  const children: { node: TreeProject; parentId: string; runner: TreeRunner }[] = [];
  for (const p of input.projects ?? []) {
    if (p.archived) continue;
    const runner = runners.get(p.runnerId);
    if (!runner) continue;
    const node: TreeProject = {
      kind: "project",
      id: p.id,
      label: p.label,
      runnerId: p.runnerId,
      agents: [],
      worktrees: [],
    };
    projects.set(p.id, node);
    if (p.parentProjectId) children.push({ node, parentId: p.parentProjectId, runner });
    else runner.projects.push(node);
  }
  // 워크트리는 부모 아래로 — 부모가 목록에 없으면(보관·다른 러너) 러너 바로 아래에 둔다
  for (const { node, parentId, runner } of children) {
    const parent = projects.get(parentId);
    if (parent && parent.runnerId === node.runnerId) parent.worktrees.push(node);
    else runner.projects.push(node);
  }

  const orphaned: TreeAgent[] = [];
  const archived: Agent[] = [];
  for (const agent of input.agents) {
    if (agent.archivedAt !== null) {
      archived.push(agent);
      continue;
    }
    const leaf: TreeAgent = { kind: "agent", agent };
    if (agent.provider === "runner") {
      const bound = agent.runner;
      // 러너 목록을 모르는 역할은 에이전트의 러너 요약으로 러너를 짓는다 — 폐기된 러너도 노드는 남는다
      const runner =
        bound &&
        (runners.get(bound.tokenId) ??
          (input.runners === null
            ? runnerNode(bound.tokenId, bound.label, bound.revoked ? "폐기됨" : null, null)
            : undefined));
      if (!bound || bound.revoked || !runner) {
        orphaned.push(leaf);
        continue;
      }
      if (bound.bot) {
        runner.bots.push(leaf);
        continue;
      }
      const projectId = agent.runnerAgent?.projectId;
      const project = projectId ? projects.get(projectId) : undefined;
      (project ?? runner).agents.push(leaf);
      continue;
    }
    const gateway = agent.gateway;
    if (!gateway) {
      orphaned.push(leaf);
      continue;
    }
    // 목록에 없는 Gateway(어댑터 상태를 아직 못 받았다) — 에이전트가 알려 준 이름으로 노드를 짓는다
    const node =
      gateways.get(gateway.id) ??
      (() => {
        const made: TreeGateway = {
          kind: "gateway",
          id: gateway.id,
          name: gateway.name,
          state: null,
          ownerUserId: null,
          approved: true,
          agents: [],
        };
        gateways.set(gateway.id, made);
        return made;
      })();
    node.agents.push(leaf);
  }

  const all: TreeConnection[] = [...gateways.values(), ...runners.values()];
  const mine = input.meId === null ? [] : all.filter((n) => n.ownerUserId === input.meId);
  const others = input.meId === null ? all : all.filter((n) => n.ownerUserId !== input.meId);
  return { mine, others, orphaned, archived };
}

/**
 * 트리 검색칸(연결 재설계 스펙 목표 1) — 이름·핸들로 거른다(대소문자·앞뒤 공백 무시). 연결·프로젝트 이름이 맞으면 그 밑을 통째로,
 * 에이전트가 맞으면 그 에이전트와 부모만 남긴다. 빈 검색은 받은 트리 그대로(같은 객체)
 */
export function filterConnectionTree(tree: ConnectionTree, query: string): ConnectionTree {
  const q = query.trim().toLocaleLowerCase();
  if (q === "") return tree;
  const hit = (text: string) => text.toLocaleLowerCase().includes(q);
  const agentHit = (agent: Agent) => hit(agent.name) || hit(agent.handle);
  const leaves = (list: TreeAgent[]) => list.filter((l) => agentHit(l.agent));
  const project = (p: TreeProject): TreeProject | null => {
    if (hit(p.label)) return p;
    const worktrees = p.worktrees.map(project).filter((w): w is TreeProject => w !== null);
    const agents = leaves(p.agents);
    return worktrees.length > 0 || agents.length > 0 ? { ...p, worktrees, agents } : null;
  };
  const connection = (c: TreeConnection): TreeConnection | null => {
    if (hit(c.kind === "gateway" ? c.name : c.label)) return c;
    if (c.kind === "gateway") {
      const agents = leaves(c.agents);
      return agents.length > 0 ? { ...c, agents } : null;
    }
    const projects = c.projects.map(project).filter((p): p is TreeProject => p !== null);
    const bots = leaves(c.bots);
    const agents = leaves(c.agents);
    return projects.length > 0 || bots.length > 0 || agents.length > 0
      ? { ...c, projects, bots, agents }
      : null;
  };
  const connections = (list: TreeConnection[]) =>
    list.map(connection).filter((c): c is TreeConnection => c !== null);
  return {
    mine: connections(tree.mine),
    others: connections(tree.others),
    orphaned: leaves(tree.orphaned),
    archived: tree.archived.filter(agentHit),
  };
}

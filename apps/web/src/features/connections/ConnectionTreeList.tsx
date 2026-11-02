import type { Agent } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, FolderIcon } from "lucide-react";
import { type Ref, useState } from "react";
import { cn } from "@/lib/utils";
import { agentColorVar } from "@/theme/agentColor";
import { Badge } from "@/ui/badge";
import { useConnections } from "./context";
import type { ConnectionTree, TreeAgent, TreeConnection, TreeProject } from "./tree";

const ROW =
  "flex min-h-9 items-center gap-2 rounded-md px-2 py-1 text-sm outline-none hover:not-aria-[current=page]:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:font-medium";

/**
 * 「연결」 트리(연결 탭 통합 스펙 3.2) — 줄 하나가 한 항목이고 누르면 그 상세가 열린다. 줄에는 이름·핸들·상태만 보인다. 1단계는 주인이
 * 없어 묶음 제목 없이 한 묶음(`mine` 이 비면)이다. 「연결 없음」은 있을 때만, 「삭제된 에이전트 N」은 접힌 채 있을 때만 그린다
 */
export function ConnectionTreeList({
  tree,
  onNavigate,
  archivedToggleRef,
}: {
  tree: ConnectionTree;
  onNavigate: () => void;
  archivedToggleRef?: Ref<HTMLButtonElement>;
}) {
  const grouped = tree.mine.length > 0;
  const empty = tree.mine.length === 0 && tree.others.length === 0 && tree.orphaned.length === 0;
  return (
    <nav aria-label="연결 목록" className="flex flex-col gap-4">
      {empty && <p className="px-2 text-sm text-muted-foreground">아직 연결이 없습니다.</p>}
      {grouped && <Group title="내 연결" connections={tree.mine} onNavigate={onNavigate} />}
      {(tree.others.length > 0 || !grouped) && (
        <Group
          title={grouped ? "다른 사람의 연결" : undefined}
          connections={tree.others}
          onNavigate={onNavigate}
        />
      )}
      {tree.orphaned.length > 0 && (
        <section aria-label="연결 없음" className="flex flex-col gap-1">
          <h2 className="px-2 text-xs font-medium text-muted-foreground">연결 없음</h2>
          <ul className="flex flex-col">
            {tree.orphaned.map((leaf) => (
              <li key={leaf.agent.id}>
                <AgentLink leaf={leaf} onNavigate={onNavigate} reason={orphanReason(leaf.agent)} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {tree.archived.length > 0 && (
        <ArchivedGroup agents={tree.archived} onNavigate={onNavigate} toggleRef={archivedToggleRef} />
      )}
    </nav>
  );
}

/** 「연결 없음」 줄의 까닭 */
function orphanReason(agent: Agent): string {
  if (agent.provider !== "runner") return "Gateway 가 삭제됨";
  if (agent.runner?.revoked) return "러너 토큰이 폐기됨";
  return "러너 없음";
}

function Group({
  title,
  connections,
  onNavigate,
}: {
  title?: string;
  connections: TreeConnection[];
  onNavigate: () => void;
}) {
  if (connections.length === 0) return null;
  const list = (
    <ul className="flex flex-col gap-1">
      {connections.map((c) => (
        <li key={`${c.kind}:${c.id}`}>
          <ConnectionNode node={c} onNavigate={onNavigate} />
        </li>
      ))}
    </ul>
  );
  if (!title) return list;
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h2 className="px-2 text-xs font-medium text-muted-foreground">{title}</h2>
      {list}
    </section>
  );
}

function StateBadge({ state }: { state: string | null }) {
  if (state === null) return null;
  return (
    <Badge variant={state === "연결됨" ? "default" : "outline"} className="ml-auto">
      {state}
    </Badge>
  );
}

function ConnectionNode({ node, onNavigate }: { node: TreeConnection; onNavigate: () => void }) {
  const link =
    node.kind === "gateway" ? (
      <Link
        to="/settings/connection/gateway/$gatewayId"
        params={{ gatewayId: node.id }}
        onClick={onNavigate}
        className={ROW}
      >
        <span className="min-w-0 truncate font-medium">{node.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">Gateway</span>
        <StateBadge state={node.state} />
      </Link>
    ) : (
      <Link
        to="/settings/connection/runner/$runnerId"
        params={{ runnerId: node.id }}
        onClick={onNavigate}
        className={ROW}
      >
        <span className="min-w-0 truncate font-medium">{node.label}</span>
        <span className="shrink-0 text-xs text-muted-foreground">러너</span>
        <StateBadge state={node.state} />
      </Link>
    );
  const projects = node.kind === "runner" ? node.projects : [];
  return (
    <>
      {link}
      {(projects.length > 0 || node.agents.length > 0) && (
        <ul className="ml-3 flex flex-col border-l pl-1">
          {projects.map((p) => (
            <li key={p.id}>
              <ProjectNode project={p} onNavigate={onNavigate} />
            </li>
          ))}
          {node.agents.map((leaf) => (
            <li key={leaf.agent.id}>
              <AgentLink leaf={leaf} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ProjectNode({ project, onNavigate }: { project: TreeProject; onNavigate: () => void }) {
  return (
    <>
      <Link
        to="/settings/connection/project/$projectId"
        params={{ projectId: project.id }}
        onClick={onNavigate}
        className={ROW}
      >
        <FolderIcon aria-hidden className="size-4 shrink-0 opacity-70" />
        <span className="min-w-0 truncate">{project.label}</span>
      </Link>
      {project.agents.length > 0 && (
        <ul className="ml-3 flex flex-col border-l pl-1">
          {project.agents.map((leaf) => (
            <li key={leaf.agent.id}>
              <AgentLink leaf={leaf} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function AgentLink({
  leaf,
  onNavigate,
  reason,
}: {
  leaf: TreeAgent;
  onNavigate: () => void;
  reason?: string;
}) {
  const { agent } = leaf;
  return (
    <Link
      to="/settings/connection/agent/$agentId"
      params={{ agentId: agent.id }}
      onClick={onNavigate}
      className={cn(ROW, !agent.enabled && "text-muted-foreground")}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ background: agentColorVar(agent.handle) }}
      />
      <span className="min-w-0 truncate">{agent.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">@{agent.handle}</span>
      {!agent.enabled && <span className="shrink-0 text-xs">(꺼짐)</span>}
      {reason && <span className="min-w-0 truncate text-xs text-destructive">— {reason}</span>}
    </Link>
  );
}

/** 「삭제된 에이전트 N」 — 접힌 채 시작한다. 펼치면 줄마다 그 에이전트 상세(되살리기가 거기 있다) */
function ArchivedGroup({
  agents,
  onNavigate,
  toggleRef,
}: {
  agents: Agent[];
  onNavigate: () => void;
  toggleRef?: Ref<HTMLButtonElement>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="삭제된 에이전트" className="flex flex-col gap-1">
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        삭제된 에이전트 {agents.length}
      </button>
      {open && (
        <ul className="flex flex-col">
          {agents.map((agent) => (
            <li key={agent.id}>
              <AgentLink leaf={{ kind: "agent", agent }} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 상세 화면의 「에이전트 N」 줄 — 트리 줄과 같은 꼴. 누르면 그 에이전트 상세의 제목으로 초점이 간다 */
export function AgentLinks({ agents }: { agents: readonly Agent[] }) {
  const { focusDetail } = useConnections();
  const onNavigate = () => {
    focusDetail.current = true;
  };
  return (
    <ul className="flex flex-col">
      {agents.map((agent) => (
        <li key={agent.id}>
          <AgentLink leaf={{ kind: "agent", agent }} onNavigate={onNavigate} />
        </li>
      ))}
    </ul>
  );
}

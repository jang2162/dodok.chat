import type { Agent } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { BotIcon, ChevronRightIcon, FolderIcon, LaptopIcon, ServerIcon } from "lucide-react";
import { type Ref, useId, useMemo, useState } from "react";
import { ProgramBadge } from "@/features/runners/ProgramBadge";
import { cn } from "@/lib/utils";
import { IdentityAvatar } from "@/ui/identity-avatar";
import { useConnections } from "./context";
import {
  type ConnectionTree,
  type StateTone,
  type TreeAgent,
  type TreeConnection,
  type TreeProject,
  filterConnectionTree,
  stateTone,
} from "./tree";

const ROW =
  "flex min-h-9 min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm outline-none hover:not-aria-[current=page]:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:font-medium";

const DOT: Record<StateTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  muted: "bg-muted-foreground",
};

/** 상태 점 + 글 — 상태를 색만으로 전하지 않는다(연결 재설계 스펙 반목표). 강조색은 쓰지 않는다 */
export function StatusDot({
  tone,
  label,
  className,
}: {
  tone: StateTone;
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground", className)}
    >
      <span aria-hidden data-state={tone} className={cn("size-2 rounded-full", DOT[tone])} />
      {label}
    </span>
  );
}

/**
 * 「연결」 트리(연결 탭 통합 스펙 3.2, 연결 재설계 스펙 목표 1) — 줄 하나가 한 항목이고 누르면 그 상세가 열린다. 연결은 종류별 묶음
 * (「GATEWAY N」·「러너 N」)으로 가르고, 주인이 있으면 그 위에 「내 연결」·「다른 사람의 연결」. 연결 줄은 접고 펼 수 있고, 접힌 줄 끝에
 * 「에이전트 N」·「프로젝트 N」 요약. 검색 중에는 접힘을 무시하고 맞는 것을 모두 펼친다 — 검색을 비우면 접힘 상태가 그대로 돌아온다
 */
export function ConnectionTreeList({
  tree: full,
  query = "",
  onNavigate,
  archivedToggleRef,
}: {
  tree: ConnectionTree;
  query?: string;
  onNavigate: () => void;
  archivedToggleRef?: Ref<HTMLButtonElement>;
}) {
  const tree = useMemo(() => filterConnectionTree(full, query), [full, query]);
  const searching = tree !== full;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const open = (key: string) => searching || !collapsed.has(key);
  const nodeProps = { onNavigate, open, toggle };

  const grouped = full.mine.length > 0;
  const empty = tree.mine.length === 0 && tree.others.length === 0 && tree.orphaned.length === 0;
  return (
    <nav aria-label="연결 목록" className="flex flex-col gap-4">
      {empty &&
        (searching ? (
          tree.archived.length === 0 && (
            <p className="px-2 text-sm text-muted-foreground">찾는 연결·에이전트가 없습니다</p>
          )
        ) : (
          <p className="px-2 text-sm text-muted-foreground">아직 연결이 없습니다.</p>
        ))}
      {grouped && <Group title="내 연결" connections={tree.mine} {...nodeProps} />}
      {(tree.others.length > 0 || !grouped) && (
        <Group title={grouped ? "다른 사람의 연결" : undefined} connections={tree.others} {...nodeProps} />
      )}
      {tree.orphaned.length > 0 && (
        <section aria-label="연결 없음" className="flex flex-col gap-1">
          <GroupHeading>연결 없음</GroupHeading>
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
        <ArchivedGroup
          agents={tree.archived}
          onNavigate={onNavigate}
          toggleRef={archivedToggleRef}
          forceOpen={searching}
        />
      )}
    </nav>
  );
}

type NodeProps = {
  onNavigate: () => void;
  open: (key: string) => boolean;
  toggle: (key: string) => void;
};

function GroupHeading({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="px-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
      {children}
    </h2>
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
  ...props
}: { title?: string; connections: TreeConnection[] } & NodeProps) {
  if (connections.length === 0) return null;
  const gateways = connections.filter((c) => c.kind === "gateway");
  const runners = connections.filter((c) => c.kind === "runner");
  const kinds = (
    <div className="flex flex-col gap-3">
      <KindGroup title="GATEWAY" connections={gateways} {...props} />
      <KindGroup title="러너" connections={runners} {...props} />
    </div>
  );
  if (!title) return kinds;
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="px-2 text-xs font-medium text-foreground">{title}</h2>
      {kinds}
    </section>
  );
}

/** 종류 묶음 — 「GATEWAY 2」·「러너 2」 머리 */
function KindGroup({
  title,
  connections,
  ...props
}: { title: string; connections: TreeConnection[] } & NodeProps) {
  const headingId = useId();
  if (connections.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <GroupHeading id={headingId}>
        {title} {connections.length}
      </GroupHeading>
      <ul className="flex flex-col gap-0.5">
        {connections.map((c) => (
          <li key={`${c.kind}:${c.id}`}>
            <ConnectionNode node={c} {...props} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 접힌 연결 줄 끝의 요약 — 「에이전트 N」·「프로젝트 N」(봇도 에이전트로 센다) */
function summaryOf(node: TreeConnection): string {
  if (node.kind === "gateway") return `에이전트 ${node.agents.length}`;
  const count = (p: TreeProject): number => p.agents.length + p.worktrees.reduce((n, w) => n + count(w), 0);
  const agents = node.agents.length + node.bots.length + node.projects.reduce((n, p) => n + count(p), 0);
  const parts = [`에이전트 ${agents}`];
  if (node.projects.length > 0) parts.unshift(`프로젝트 ${node.projects.length}`);
  return parts.join(" · ");
}

function ConnectionNode({ node, onNavigate, open, toggle }: { node: TreeConnection } & NodeProps) {
  const key = `${node.kind}:${node.id}`;
  const name = node.kind === "gateway" ? node.name : node.label;
  const projects = node.kind === "runner" ? node.projects : [];
  const bots = node.kind === "runner" ? node.bots : [];
  const hasChildren = projects.length > 0 || bots.length > 0 || node.agents.length > 0;
  const expanded = hasChildren && open(key);
  const Icon = node.kind === "gateway" ? ServerIcon : LaptopIcon;
  const inner = (
    <>
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{name}</span>
      <span className="sr-only">{node.kind === "gateway" ? "Gateway" : "러너"}</span>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {hasChildren && !expanded && <span className="text-xs text-muted-foreground">{summaryOf(node)}</span>}
        {node.state !== null && <StatusDot tone={stateTone(node.state)} label={node.state} />}
      </span>
    </>
  );
  const link =
    node.kind === "gateway" ? (
      <Link
        to="/settings/connection/gateway/$gatewayId"
        params={{ gatewayId: node.id }}
        onClick={onNavigate}
        className={cn(ROW, "flex-1")}
      >
        {inner}
      </Link>
    ) : (
      <Link
        to="/settings/connection/runner/$runnerId"
        params={{ runnerId: node.id }}
        onClick={onNavigate}
        className={cn(ROW, "flex-1")}
      >
        {inner}
      </Link>
    );
  return (
    <>
      <div className="flex items-center">
        {hasChildren ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${name} ${expanded ? "접기" : "펼치기"}`}
            onClick={() => toggle(key)}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span aria-hidden className="size-6 shrink-0" />
        )}
        {link}
      </div>
      {expanded && (
        <ul className="ml-6 flex flex-col border-l pl-1">
          {projects.map((p) => (
            <li key={p.id}>
              <ProjectNode project={p} onNavigate={onNavigate} />
            </li>
          ))}
          {bots.length > 0 && (
            <li>
              <BotsNode bots={bots} onNavigate={onNavigate} />
            </li>
          )}
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

/** 러너 아래 「봇」 묶음(러너 봇 스펙 B11) — 상세가 없는 묶음 제목 한 줄과 그 아래 봇들 */
function BotsNode({ bots, onNavigate }: { bots: TreeAgent[]; onNavigate: () => void }) {
  return (
    <section aria-label="봇">
      <p className="flex min-h-9 items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
        <BotIcon aria-hidden className="size-4 shrink-0 opacity-70" />
        <span>봇</span>
      </p>
      <ul className="ml-3 flex flex-col border-l pl-1">
        {bots.map((leaf) => (
          <li key={leaf.agent.id}>
            <AgentLink leaf={leaf} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
    </section>
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
        <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{project.label}</span>
      </Link>
      {(project.agents.length > 0 || project.worktrees.length > 0) && (
        <ul className="ml-3 flex flex-col border-l pl-1">
          {/* 워크트리 하위 프로젝트는 부모 아래로(워크트리 스펙 5.5) — 그 에이전트는 워크트리 아래 */}
          {project.worktrees.map((wt) => (
            <li key={wt.id}>
              <ProjectNode project={wt} onNavigate={onNavigate} />
            </li>
          ))}
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

/** 에이전트 줄 — 에이전트 색 테두리의 이니셜 아바타(상태 점이 아니다) · 이름 · 핸들 · 러너 에이전트면 끝에 프로그램 배지 */
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
      <IdentityAvatar
        kind="agent"
        id={agent.id}
        name={agent.name}
        handle={agent.handle}
        avatarUrl={agent.avatarUrl}
        size={24}
        className={cn("size-5", !agent.enabled && "opacity-60")}
      />
      <span className="min-w-0 truncate">{agent.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">@{agent.handle}</span>
      {!agent.enabled && <span className="shrink-0 text-xs">(꺼짐)</span>}
      {reason && <span className="min-w-0 truncate text-xs text-destructive">— {reason}</span>}
      {agent.provider === "runner" && agent.program && (
        <ProgramBadge program={agent.program} className="ml-auto" />
      )}
    </Link>
  );
}

/** 「삭제된 에이전트 N」 — 접힌 채 시작한다. 펼치면 줄마다 그 에이전트 상세(되살리기가 거기 있다). 검색 중에는 펼친다 */
function ArchivedGroup({
  agents,
  onNavigate,
  toggleRef,
  forceOpen,
}: {
  agents: Agent[];
  onNavigate: () => void;
  toggleRef?: Ref<HTMLButtonElement>;
  forceOpen: boolean;
}) {
  const [openState, setOpen] = useState(false);
  const open = forceOpen || openState;
  return (
    <section aria-label="삭제된 에이전트" className="flex flex-col gap-1 border-t pt-3">
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

/** 상세 화면의 에이전트 줄 — 트리 줄과 같은 꼴. 누르면 그 에이전트 상세의 제목으로 초점이 간다 */
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

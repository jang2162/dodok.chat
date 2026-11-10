import { type Agent, roleAtLeast } from "@dodok/shared";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useAgents } from "@/api/queries";
import { RunnerAgentForm } from "@/features/agents/RunnerAgentForm";
import { useRunnerProjects, useRunners } from "@/features/runners/queries";
import { projectPlace } from "@/features/runners/copy";
import { ProjectRow } from "@/features/runners/ProjectList";
import { Section } from "@/features/setup/sections";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/ui/dialog";
import { AgentLinks } from "./ConnectionTreeList";
import { DetailHeader } from "./DetailHeader";
import { DetailPending, NotFoundDetail } from "./NotFoundDetail";
import { canManageConnection, useViewer } from "./permissions";
import { useConnectionList } from "./queries";
import { useConnectionTree } from "./useConnectionTree";

/**
 * 프로젝트 상세(연결 탭 통합 스펙 3.3·5.2 — 그 러너의 주인과 admin 이상, 아니면 「권한이 없습니다」 한 줄. 서버가 남의 프로젝트의 자리를
 * 주지 않는다). 머리(이름·「<러너> · <루트 라벨>/<상대 경로>」), 러너 상세의 줄과 같은 「확인」·이름 바꾸기·옮기기(옮길 곳은 그 사람이 볼 수
 * 있는 러너 — member 는 자기 러너만)·보관, 「에이전트 N」과 이 러너·프로젝트로 고정한 「에이전트 만들기」. 보관·옮기기 뒤에는 그 러너 상세로
 */
export function ProjectDetail() {
  const { projectId } = useParams({ strict: false });
  const { role, meId } = useViewer();
  const admin = roleAtLeast(role, "admin");
  const list = useConnectionList();
  if (!admin && list.isPending) return <DetailPending failed={false} retry={() => void list.refetch()} />;
  const listed = list.data?.projects.find((p) => p.id === projectId);
  const owner = listed ? (list.data?.runners.find((r) => r.id === listed.runnerId)?.owner?.id ?? null) : null;
  if (!canManageConnection(role, meId, owner))
    return (
      <p className="text-sm text-muted-foreground">
        권한이 없습니다 — 프로젝트는 그 러너의 주인과 관리자만 볼 수 있습니다.
      </p>
    );
  return <ManagedProject runnerHint={listed?.runnerId} />;
}

/** runnerHint — 연결 목록이 알려 준 그 프로젝트의 러너(member 는 러너마다의 프로젝트를 모두 받지 않는다) */
function ManagedProject({ runnerHint }: { runnerHint: string | undefined }) {
  const { projectId } = useParams({ strict: false });
  const tree = useConnectionTree();
  // 같은 쿼리(캐시 공유) — 목록이 실패하면 「불러오는 중…」에 멈추지 않고 다시 시도를 보인다
  const runnersQuery = useRunners();
  const ownProjects = useRunnerProjects(runnerHint, { enabled: tree.projects === null });
  const agents = useAgents();
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const runners = runnersQuery.data;
  // admin 은 트리가 러너마다 받은 프로젝트를, member(주인)는 그 러너 하나의 프로젝트를
  const projects = tree.projects ?? ownProjects.data;
  const settled =
    tree.projects !== null ? tree.projectsSettled : !ownProjects.isPending || runnerHint === undefined;
  // 보관한 프로젝트도 상세는 남는다 — 「보관됨」 배지, 동작 없이(열린 「에이전트 만들기」가 사유를 보이며 잠긴다)
  const project = projects?.find((p) => p.id === projectId);
  const runner = project ? runners?.find((r) => r.id === project.runnerId) : undefined;
  if (!runners || !settled)
    return <DetailPending failed={runnersQuery.isError} retry={() => void runnersQuery.refetch()} />;
  if (!project || !runner) return <NotFoundDetail message="이 프로젝트를 찾을 수 없습니다" />;
  const backToRunner = () => {
    void navigate({ to: "/settings/connection/runner/$runnerId", params: { runnerId: runner.id } });
    return null;
  };
  const archived = project.archivedAt !== null;
  const here = (agents.data ?? []).filter(
    (a: Agent) => a.provider === "runner" && a.runnerAgent?.projectId === project.id && a.archivedAt === null,
  );
  return (
    <div data-testid="project-detail" className="flex flex-col gap-6">
      <DetailHeader
        title={project.label}
        headingRef={heading}
        badge={archived ? <Badge variant="outline">보관됨</Badge> : undefined}
        meta={
          <p className="break-all">
            <Link
              to="/settings/connection/runner/$runnerId"
              params={{ runnerId: runner.id }}
              className="text-foreground underline-offset-4 hover:underline"
            >
              {runner.label}
            </Link>{" "}
            · <code className="font-mono">{projectPlace(project)}</code>
          </p>
        }
      />
      {!archived && (
        <ul className="rounded-md border">
          <ProjectRow
            project={project}
            runner={runner}
            runners={runners}
            afterRemove={backToRunner}
            linked={false}
          />
        </ul>
      )}
      <Section title={`에이전트 ${here.length}`} bare>
        <div>
          <NewRunnerAgentDialog
            runnerId={runner.id}
            projectId={project.id}
            agents={agents.data ?? []}
            disabled={archived}
          />
        </div>
        {here.length === 0 ? (
          <p className="text-sm text-muted-foreground">아직 에이전트가 없습니다.</p>
        ) : (
          <AgentLinks agents={here} />
        )}
      </Section>
    </div>
  );
}

/** 「에이전트 만들기」 — 이 러너·프로젝트로 고정한 러너 에이전트 폼(`RunnerAgentForm`). 만들면 닫는다 */
function NewRunnerAgentDialog({
  runnerId,
  projectId,
  agents,
  disabled,
}: {
  runnerId: string;
  projectId: string;
  agents: readonly Agent[];
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const takenHandles = useMemo(() => new Set(agents.map((a) => a.handle)), [agents]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={disabled}>
          <PlusIcon />
          에이전트 만들기
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="max-h-[85svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>러너 에이전트 만들기</DialogTitle>
        </DialogHeader>
        {open && (
          <RunnerAgentForm
            runnerId={runnerId}
            projectId={projectId}
            takenHandles={takenHandles}
            onCreated={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

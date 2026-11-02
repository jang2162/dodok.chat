import { type Agent, roleAtLeast } from "@dodok/shared";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useAgents, useRole } from "@/api/queries";
import { RunnerAgentForm } from "@/features/agents/RunnerAgentForm";
import { projectPlace } from "@/features/runners/copy";
import { ProjectRow } from "@/features/runners/ProjectList";
import { Section } from "@/features/setup/sections";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import { AgentLinks } from "./ConnectionTreeList";
import { DetailHeader } from "./DetailHeader";
import { DetailPending, NotFoundDetail } from "./NotFoundDetail";
import { useConnectionTree } from "./useConnectionTree";

/**
 * 프로젝트 상세(연결 탭 통합 스펙 3.3, admin 이상 — 아니면 「권한이 없습니다」 한 줄. 서버가 프로젝트를 주지 않는다). 머리(이름·
 * 「<러너> · <루트 라벨>/<상대 경로>」), 러너 상세의 줄과 같은 「확인」·이름 바꾸기·옮기기·보관, 「에이전트 N」과 이 러너·프로젝트로 고정한
 * 「에이전트 만들기」. 보관·옮기기 뒤에는 그 러너 상세로 간다
 */
export function ProjectDetail() {
  const admin = roleAtLeast(useRole(), "admin");
  if (!admin)
    return (
      <p className="text-sm text-muted-foreground">권한이 없습니다 — 프로젝트는 관리자만 볼 수 있습니다.</p>
    );
  return <ManagedProject />;
}

function ManagedProject() {
  const { projectId } = useParams({ strict: false });
  const tree = useConnectionTree();
  const agents = useAgents();
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const runners = tree.runners;
  const projects = tree.projects;
  // 보관한 프로젝트도 상세는 남는다 — 「보관됨」 배지, 동작 없이(열린 「에이전트 만들기」가 사유를 보이며 잠긴다)
  const project = projects?.find((p) => p.id === projectId);
  const runner = project ? runners?.find((r) => r.id === project.runnerId) : undefined;
  if (!runners || !tree.projectsSettled) return <DetailPending failed={false} retry={tree.refetch} />;
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
      <DialogContent className="max-h-[85svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>러너 에이전트 만들기</DialogTitle>
          <DialogDescription>이 프로젝트에서 도는 에이전트를 만듭니다.</DialogDescription>
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

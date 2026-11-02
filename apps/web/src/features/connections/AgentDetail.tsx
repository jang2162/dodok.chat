import { type Agent, RUNNER_PROGRAM_NAME, roleAtLeast } from "@dodok/shared";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useRef } from "react";
import { useAgents, useCanManage, useRole } from "@/api/queries";
import { AgentRow } from "@/features/agents/AgentRow";
import { useRestoreAgent } from "@/features/agents/mutations";
import { providerIdLabel } from "@/features/agents/providerLabels";
import { NO_PROJECT_RESTORE } from "@/features/runners/copy";
import { useRunnerProjects } from "@/features/runners/queries";
import { LOCKED_NOTICE } from "@/features/settings/Section";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { useConnections } from "./context";
import { DetailHeader } from "./DetailHeader";
import { DetailPending, NotFoundDetail } from "./NotFoundDetail";

/**
 * 에이전트 상세(연결 탭 통합 스펙 3.3) — 머리에 이름과 경로(「<러너> › <프로젝트> · <프로그램>」 또는 「<Gateway> · OpenClaw」 — 연결
 * 이름은 그 연결 상세 링크), 본문은 목록 시절의 에이전트 줄 그대로(사용·DM·지시·메모·DM 허용·Gateway 옮기기·삭제·사진). 고칠 수
 * 없는 사람(admin 미만)에게는 값만 보인다. 보관(삭제)한 에이전트면 「삭제된 에이전트」 배지와 「되살리기」.
 * 보관하면 트리로 돌아가 「삭제된 에이전트 N」 단추로, 되살리면 이 상세의 제목으로 초점이 간다
 */
export function AgentDetail() {
  const { agentId } = useParams({ strict: false });
  const agents = useAgents();
  const canManage = useCanManage();
  const navigate = useNavigate();
  const { focusTree } = useConnections();
  const heading = useRef<HTMLHeadingElement>(null);

  if (!agents.data) return <DetailPending failed={agents.isError} retry={() => void agents.refetch()} />;
  const agent = agents.data.find((a) => a.id === agentId);
  if (!agent) return <NotFoundDetail message="이 에이전트를 찾을 수 없습니다" />;
  const archived = agent.archivedAt !== null;

  return (
    <>
      <DetailHeader
        title={agent.name}
        headingRef={heading}
        badge={
          archived ? (
            <Badge variant="outline">삭제된 에이전트</Badge>
          ) : (
            !agent.enabled && <Badge variant="outline">꺼짐</Badge>
          )
        }
        meta={<AgentPath agent={agent} />}
      />
      {!canManage && <p className="-mt-3 text-xs text-muted-foreground">{LOCKED_NOTICE}</p>}
      <div data-testid="agent-detail" className="contents">
        {archived ? (
          <ArchivedBody agent={agent} readOnly={!canManage} onRestored={() => heading.current?.focus()} />
        ) : (
          <AgentRow
            as="div"
            agent={agent}
            readOnly={!canManage}
            onArchived={() => {
              focusTree("archived");
              void navigate({ to: "/settings/connection" });
            }}
          />
        )}
      </div>
    </>
  );
}

/** 「<연결> › <프로젝트> · <프로그램>」 — 연결 이름은 그 연결 상세로. 프로젝트 이름은 admin 이상만 안다(서버가 준다) */
function AgentPath({ agent }: { agent: Agent }) {
  const role = useRole();
  const admin = roleAtLeast(role, "admin");
  const runnerId = agent.runner?.tokenId;
  const projects = useRunnerProjects(runnerId, { enabled: admin && agent.provider === "runner" });
  const link = "text-foreground underline-offset-4 hover:underline";
  if (agent.provider === "runner") {
    const projectId = agent.runnerAgent?.projectId;
    const project = projects.data?.find((p) => p.id === projectId);
    const program = agent.program ? RUNNER_PROGRAM_NAME[agent.program] : "러너";
    return (
      <p className="break-all">
        {agent.runner ? (
          <Link
            to="/settings/connection/runner/$runnerId"
            params={{ runnerId: agent.runner.tokenId }}
            className={link}
          >
            {agent.runner.label}
          </Link>
        ) : (
          "러너 없음"
        )}
        {project && (
          <>
            {" › "}
            <Link
              to="/settings/connection/project/$projectId"
              params={{ projectId: project.id }}
              className={link}
            >
              {project.label}
            </Link>
          </>
        )}
        {` · ${program}`}
      </p>
    );
  }
  return (
    <p className="break-all">
      {agent.gateway ? (
        <Link
          to="/settings/connection/gateway/$gatewayId"
          params={{ gatewayId: agent.gateway.id }}
          className={link}
        >
          {agent.gateway.name}
        </Link>
      ) : (
        "Gateway 없음"
      )}
      {" · OpenClaw"}
    </p>
  );
}

/**
 * 보관한 에이전트 — 제공자 id 와 「되살리기」(admin 이상). 프로젝트가 없는 옛 러너 에이전트는 되살릴 수 없다(서버도 막는다)
 */
function ArchivedBody({
  agent,
  readOnly,
  onRestored,
}: {
  agent: Agent;
  readOnly: boolean;
  onRestored: () => void;
}) {
  const { restore, isPending } = useRestoreAgent();
  const handle = `@${agent.handle}`;
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-4 text-sm">
      <p className="text-muted-foreground">
        {handle} · {providerIdLabel(agent.provider)}{" "}
        <code className="font-mono">{agent.providerAgentId}</code>
      </p>
      {!readOnly &&
        (agent.runnerAgent?.projectId === null ? (
          <p className="text-xs text-muted-foreground">{NO_PROJECT_RESTORE}</p>
        ) : (
          <Button
            variant="outline"
            size="sm"
            aria-label={`${handle} 되살리기`}
            disabled={isPending}
            onClick={() => restore(agent.id, onRestored)}
          >
            {isPending ? "되살리는 중…" : "되살리기"}
          </Button>
        ))}
    </div>
  );
}

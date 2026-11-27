import { type Agent, roleAtLeast } from "@dodok/shared";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { LaptopIcon, ServerIcon } from "lucide-react";
import { useRef } from "react";
import { useAgents, useRole } from "@/api/queries";
import {
  AgentAvatarField,
  AgentDmLink,
  AgentEnabledSwitch,
  ArchiveAgentButton,
  BasePromptEditor,
  DmAccessField,
  OutsideWorkdirSwitch,
  RunnerSessionDefaults,
  RunnerWarning,
  RunTimeoutField,
} from "@/features/agents/AgentRow";
import { useRestoreAgent } from "@/features/agents/mutations";
import { MoveGatewayDialog } from "@/features/agents/MoveGatewayDialog";
import { providerIdLabel } from "@/features/agents/providerLabels";
import { BotDefinitionEditor } from "@/features/agents/RunnerAgentForm";
import { NO_PROJECT_RESTORE, worktreeName } from "@/features/runners/copy";
import { ProgramBadge } from "@/features/runners/ProgramBadge";
import { PROGRAM_META } from "@/features/runners/programMeta";
import { useRunnerProjects } from "@/features/runners/queries";
import { LOCKED_NOTICE } from "@/features/settings/Section";
import { Button } from "@/ui/button";
import { IdentityAvatar } from "@/ui/identity-avatar";
import { useConnections } from "./context";
import { DetailCard } from "./DetailCard";
import { DetailHeader } from "./DetailHeader";
import { DetailPending, NotFoundDetail } from "./NotFoundDetail";
import { canManageConnection, canMoveBetween, useViewer } from "./permissions";
import { useConnectionList } from "./queries";
import { agentOwnerOf, connectionOwnerMaps } from "./useConnectionTree";

/**
 * 에이전트 상세(연결 탭 통합 스펙 3.3, 연결 재설계 스펙 목표 3). 머리: 큰 아바타 · 이름 · 값 줄(핸들·제공자 id) · 칩 줄(프로그램 또는
 * OpenClaw · 러너/Gateway 링크 · 프로젝트 링크), 오른쪽에 「DM 보내기」와 이름표 있는 켜기 스위치. 카드: 「실행」(러너 에이전트만 —
 * 프로그램(읽기 전용 — 만든 뒤 바꾸는 API 가 없다)·새 세션 시작값·작업 디렉터리 밖 허용·지시, 봇이면 지시 자리에 봇 정의) · 「프로필」(사진, OpenClaw 는 메모 —
 * 에이전트에게 전달되지 않음) · 「DM 허용」(세그먼트) · 「런 상한」(분, 비우면 없음) · 「관리」(Gateway 옮기기·삭제, 붉은 테두리). 고칠 수 없는 사람(그 에이전트 연결의
 * 주인도 admin 이상도 아니다 — 연결 탭 통합 스펙 5.2)에게는 값만 보인다. 보관(삭제)한 에이전트면 「삭제된 에이전트」 칩과 「되살리기」.
 * 보관하면 트리로 돌아가 「삭제된 에이전트 N」 단추로, 되살리면 이 상세의 제목으로 초점이 간다
 */
export function AgentDetail() {
  const { agentId } = useParams({ strict: false });
  const agents = useAgents();
  const { role, meId } = useViewer();
  const list = useConnectionList();
  const navigate = useNavigate();
  const { focusTree } = useConnections();
  const heading = useRef<HTMLHeadingElement>(null);

  if (!agents.data) return <DetailPending failed={agents.isError} retry={() => void agents.refetch()} />;
  const agent = agents.data.find((a) => a.id === agentId);
  if (!agent) return <NotFoundDetail message="이 에이전트를 찾을 수 없습니다" />;
  const archived = agent.archivedAt !== null;
  const canManage = canManageConnection(role, meId, agentOwnerOf(agent, list.data));
  const readOnly = !canManage;
  const openclaw = agent.provider === "openclaw";
  const handle = `@${agent.handle}`;
  // Gateway 옮기기 — 원래 Gateway 와 옮길 Gateway 가 둘 다 자기 것이거나 admin 이상
  const owners = connectionOwnerMaps(list.data);
  const from = agent.gateway ? (owners.gateways.get(agent.gateway.id) ?? null) : null;
  const moveTargets = roleAtLeast(role, "admin")
    ? () => true
    : canMoveBetween(role, meId, from, from)
      ? (gatewayId: string) => canMoveBetween(role, meId, from, owners.gateways.get(gatewayId) ?? null)
      : undefined;
  const canMove = openclaw && moveTargets !== undefined;

  return (
    <div data-testid="agent-detail" className="flex flex-col gap-4">
      <DetailHeader
        leading={
          <IdentityAvatar
            kind="agent"
            id={agent.id}
            name={agent.name}
            handle={agent.handle}
            avatarUrl={agent.avatarUrl}
            size={64}
            className={!agent.enabled || archived ? "opacity-60" : undefined}
          />
        }
        title={agent.name}
        headingRef={heading}
        state={archived ? { tone: "muted", label: "삭제된 에이전트" } : undefined}
        facts={[
          openclaw && agent.gateway ? (
            <span key="handle">
              <span>{handle}</span> · {agent.gateway.name}
            </span>
          ) : (
            <span key="handle">{handle}</span>
          ),
          <span key="id">
            {providerIdLabel(agent.provider)} <code className="font-mono">{agent.providerAgentId}</code>
          </span>,
        ]}
        primary={
          !archived && (
            <>
              <AgentDmLink agent={agent} />
              <AgentEnabledSwitch agent={agent} readOnly={readOnly} />
            </>
          )
        }
      >
        <AgentChips agent={agent} />
        <RunnerWarning agent={agent} />
        {openclaw && agent.gateway === null && (
          <p className="text-xs font-medium text-destructive">
            {canMove
              ? "Gateway 가 삭제됨 — 다른 Gateway 로 옮기세요"
              : "Gateway 가 삭제됨 — admin 이 다른 Gateway 로 옮길 때까지 답하지 못합니다"}
          </p>
        )}
        {readOnly && <p className="text-xs text-muted-foreground">{LOCKED_NOTICE}</p>}
      </DetailHeader>
      {archived ? (
        <ArchivedBody agent={agent} readOnly={readOnly} onRestored={() => heading.current?.focus()} />
      ) : (
        <>
          {agent.provider === "runner" && (
            <DetailCard title="실행">
              <dl className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <dt className="text-muted-foreground">프로그램</dt>
                <dd className="inline-flex items-center gap-1.5">
                  {agent.program ? (
                    <>
                      <ProgramBadge program={agent.program} />
                      {PROGRAM_META[agent.program].name}
                    </>
                  ) : (
                    "모름"
                  )}
                  <span className="text-xs text-muted-foreground">(만든 뒤에는 바꿀 수 없습니다)</span>
                </dd>
              </dl>
              {!readOnly && agent.sessionDefaults && (
                <RunnerSessionDefaults
                  agent={agent}
                  defaults={agent.sessionDefaults}
                  projectId={agent.runnerAgent?.projectId ?? null}
                />
              )}
              {(readOnly || agent.runnerAgent) && <OutsideWorkdirSwitch agent={agent} readOnly={readOnly} />}
              {/* 봇은 기본 지시 대신 봇 정의(러너 봇 스펙 B3) — 정의는 주인·admin 이상만 받는다 */}
              {agent.runner?.bot ? (
                <BotDefinitionEditor agent={agent} readOnly={readOnly} />
              ) : (
                <BasePromptEditor agent={agent} readOnly={readOnly} />
              )}
            </DetailCard>
          )}
          {(openclaw || !readOnly) && (
            <DetailCard title="프로필">
              {!readOnly && <AgentAvatarField agent={agent} />}
              {/* 같은 basePrompt 칸 — OpenClaw 에서는 인바운드에 실리지 않아 일부러 「메모」라 부른다(promptCopy) */}
              {openclaw && <BasePromptEditor agent={agent} readOnly={readOnly} />}
            </DetailCard>
          )}
          <DetailCard title="DM 허용">
            <DmAccessField agent={agent} readOnly={readOnly} />
          </DetailCard>
          <DetailCard title="런 상한">
            <RunTimeoutField agent={agent} readOnly={readOnly} />
          </DetailCard>
          {(!readOnly || canMove) && (
            <DetailCard title="관리" tone="danger">
              <div className="flex flex-wrap items-center gap-2">
                {canMove && <MoveGatewayDialog agent={agent} allowed={moveTargets} />}
                {!readOnly && (
                  <ArchiveAgentButton
                    agent={agent}
                    onArchived={() => {
                      focusTree("archived");
                      void navigate({ to: "/settings/connection" });
                    }}
                  />
                )}
              </div>
            </DetailCard>
          )}
        </>
      )}
    </div>
  );
}

const CHIP = "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs";
const CHIP_LINK = `${CHIP} text-foreground underline-offset-4 outline-none hover:bg-accent hover:underline focus-visible:ring-2 focus-visible:ring-ring`;

/**
 * 칩 줄 — 프로그램(또는 OpenClaw) · 러너/Gateway(그 상세로) · 프로젝트(그 상세로, admin 이상만 안다 — 서버가 준다) 또는 「봇」
 */
function AgentChips({ agent }: { agent: Agent }) {
  const role = useRole();
  const admin = roleAtLeast(role, "admin");
  const runnerId = agent.runner?.tokenId;
  const projects = useRunnerProjects(runnerId, { enabled: admin && agent.provider === "runner" });
  if (agent.provider === "runner") {
    const projectId = agent.runnerAgent?.projectId;
    const project = projects.data?.find((p) => p.id === projectId);
    return (
      <p className="flex flex-wrap items-center gap-1.5">
        {agent.program ? (
          <span className={CHIP}>
            <ProgramBadge program={agent.program} />
            {PROGRAM_META[agent.program].name}
          </span>
        ) : (
          <span className={CHIP}>러너</span>
        )}
        {agent.runner && (
          <Link
            to="/settings/connection/runner/$runnerId"
            params={{ runnerId: agent.runner.tokenId }}
            className={CHIP_LINK}
          >
            <LaptopIcon aria-hidden className="size-3.5 text-muted-foreground" />
            러너 {agent.runner.label}
          </Link>
        )}
        {agent.runner?.bot && <span className={CHIP}>봇</span>}
        {project && (
          <Link
            to="/settings/connection/project/$projectId"
            params={{ projectId: project.id }}
            className={CHIP_LINK}
          >
            프로젝트 {worktreeName(project, projects.data ?? [])}
          </Link>
        )}
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-1.5">
      <span className={CHIP}>OpenClaw</span>
      {agent.gateway ? (
        <Link
          to="/settings/connection/gateway/$gatewayId"
          params={{ gatewayId: agent.gateway.id }}
          className={CHIP_LINK}
        >
          <ServerIcon aria-hidden className="size-3.5 text-muted-foreground" />
          Gateway {agent.gateway.name}
        </Link>
      ) : (
        <span className={CHIP}>Gateway 없음</span>
      )}
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
        (agent.runnerAgent?.projectId === null && !agent.runner?.bot ? (
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

import { type Agent, type DmAccess, RUNNER_PROGRAM_NAME } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { useAgents, useCachedMe, useCanManage, usePeople } from "@/api/queries";
import { AgentAvatarField } from "@/features/agents/AgentRow";
import { isArchived } from "@/features/agents/archived";
import { canOpenDm } from "@/features/dms/queries";
import { DeactivatedTag } from "@/features/members/DeactivatedTag";
import { isDeactivated } from "@/features/members/deactivated";
import { PRESENCE_LABEL, WithPresence } from "@/features/presence/PresenceDot";
import { usePresence } from "@/features/presence/store";
import { PERMISSION_MODE_LABEL } from "@/features/runners/copy";
import { agentColorVar } from "@/theme/agentColor";
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { requestMention } from "./openProfile";
import { Field, NotFound } from "./ProfileParts";

const DM_ACCESS_LABEL: Record<DmAccess, string> = { off: "끔", admins: "admin 이상", everyone: "모두" };

/** 연결 — OpenClaw 는 Gateway 이름, 러너는 러너 라벨 + 프로그램. 묶이지 않음·폐기·Gateway 없음이면 그 사정 */
function connectionOf(agent: Agent): string {
  if (agent.provider === "runner") {
    if (!agent.runner) return "묶이지 않음";
    const program = agent.program ? RUNNER_PROGRAM_NAME[agent.program] : undefined;
    const line = [agent.runner.label, program].filter(Boolean).join(" · ");
    return agent.runner.revoked ? `${line} (폐기됨)` : line;
  }
  return agent.gateway?.name ?? "Gateway 없음";
}

/**
 * 에이전트 프로필(프로필 스펙 3.1) — 연결·모델(러너만)·소유자·DM 허용은 모두에게, 권한 모드·허용·금지 도구·기본 프롬프트는 admin
 * 이상에게만(서버도 member 에게는 runnerAgent 를 싣지 않는다 — 기본 프롬프트는 화면이 가린다)
 */
export function AgentProfile({ agentId }: { agentId: string }) {
  const agents = useAgents();
  const people = usePeople();
  const canManage = useCanManage();
  const role = useCachedMe()?.role;
  const entry = usePresence("agent", agentId);
  const agent = agents.data?.find((a) => a.id === agentId);
  if (!agent) return agents.isPending ? null : <NotFound />;
  const archived = isArchived(agent);
  const owner = agent.createdBy ? people.data?.find((p) => p.id === agent.createdBy) : undefined;
  const stateLabel = archived ? "보관됨" : entry?.state ? PRESENCE_LABEL[entry.state] : "알 수 없음";
  const runner = agent.runnerAgent;

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="profile-agent">
      <div className="flex items-center gap-3">
        <WithPresence kind="agent" id={agent.id} size="lg">
          <Avatar className="size-16 border-2" style={{ borderColor: agentColorVar(agent.handle) }}>
            {agent.avatarUrl && <AvatarImage src={agent.avatarUrl} alt="" />}
            <AvatarFallback className="text-xl">{agent.name.slice(0, 1)}</AvatarFallback>
          </Avatar>
        </WithPresence>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-lg font-semibold">{agent.name}</h3>
            <Badge variant="outline">에이전트</Badge>
          </div>
          <p className="text-sm text-muted-foreground">@{agent.handle}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {!agent.enabled && !archived && <Badge variant="outline">꺼짐</Badge>}
        {archived && <Badge variant="secondary">보관됨</Badge>}
      </div>
      <dl className="flex flex-col gap-3">
        <Field label="상태">{stateLabel}</Field>
        <Field label="연결">{connectionOf(agent)}</Field>
        {agent.provider === "runner" && <Field label="모델">{agent.model ?? "기본"}</Field>}
        <Field label="소유자">
          {agent.createdBy === null ? (
            "기록 없음"
          ) : owner ? (
            <>
              @{owner.handle}
              {isDeactivated(owner) && <DeactivatedTag className="ml-1 text-xs text-muted-foreground" />}
            </>
          ) : (
            "알 수 없음"
          )}
        </Field>
        <Field label="DM 허용">{DM_ACCESS_LABEL[agent.dmAccess]}</Field>
        {canManage && runner && (
          <>
            <Field label="권한 모드">{PERMISSION_MODE_LABEL[runner.permissionMode]}</Field>
            <Field label="허용 도구">
              {runner.allowedTools?.length ? runner.allowedTools.join(", ") : "없음"}
            </Field>
            <Field label="금지 도구">
              {runner.disallowedTools.length ? runner.disallowedTools.join(", ") : "없음"}
            </Field>
          </>
        )}
      </dl>
      {canManage && !archived && <AgentAvatarField agent={agent} />}
      {canManage && agent.basePrompt && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground">기본 프롬프트</summary>
          <p className="mt-1 whitespace-pre-wrap">{agent.basePrompt}</p>
        </details>
      )}
      <div className="flex flex-wrap gap-2">
        {canOpenDm(agent, role) && (
          <Button asChild variant="outline" size="sm">
            <Link to="/dm/$agentId" params={{ agentId: agent.id }}>
              DM 열기
            </Link>
          </Button>
        )}
        {!archived && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => requestMention({ kind: "a", id: agent.id, handle: agent.handle })}
          >
            멘션
          </Button>
        )}
        {canManage && (
          <Button asChild variant="outline" size="sm">
            <Link to="/settings/connection/agent/$agentId" params={{ agentId: agent.id }}>
              에이전트 설정
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

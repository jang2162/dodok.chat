import type { Agent, ChannelMember, Person } from "@dodok/shared";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formError } from "@/api/formErrors";
import { usePeople, useRole } from "@/api/queries";
import { isArchived } from "@/features/agents/archived";
import { josa } from "@/lib/josa";
import { Button } from "@/ui/button";
import { IdentityAvatar } from "@/ui/identity-avatar";
import { AgentMemberRow } from "./AgentMemberRow";
import type { AutoRespondStep } from "./autoRespond";
import { ConfirmDialog } from "./ConfirmDialog";
import { InviteMembersDialog } from "./InviteMembersDialog";
import { usePatchMember, useRemoveMember } from "./mutations";
import { Section } from "./Section";

export type AgentMember = { member: ChannelMember; agent: Agent };

/**
 * 채널의 에이전트 멤버(합류 순)와 그 에이전트. 목록에 없는 에이전트·보관(삭제)한 에이전트는 건너뛴다 — 서버 멤버 응답이 보관한 것을
 * 이미 빼지만, 다른 탭의 보관 뒤 멤버를 다시 받기 전 틈에도 줄이 남지 않게
 */
export function agentMembers(members: ChannelMember[] = [], agents: Agent[] = []): AgentMember[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return members.flatMap((member) => {
    const agent = member.memberType === "agent" ? byId.get(member.memberId) : undefined;
    return agent && !isArchived(agent) ? [{ member, agent }] : [];
  });
}

/**
 * 멤버(스펙 6.4·채널 UI 스펙 4장): 맨 위 「초대」(사람·에이전트를 한 대화상자에서), 그 아래 「사람」·「에이전트」 두 묶음. 자동 응답
 * 바꾸기는 여기서 차례로 보낸다 — 한 번에 하나만 돌고, 도는 동안 모든 행의 자동 응답 스위치를 잠근다(두 흐름이 겹쳐 둘이 켜지지 않게)
 */
export function MembersSection({
  channelId,
  members,
  agents,
  loadError,
  onRetry,
  agentsError = false,
  onRetryAgents,
}: {
  channelId: string;
  members: ChannelMember[] | undefined;
  agents: Agent[] | undefined;
  loadError: boolean;
  onRetry: () => void;
  /** 에이전트 목록 조회가 실패했나 — 「아직 에이전트가 없습니다」 대신 상태를 보인다 */
  agentsError?: boolean;
  onRetryAgents?: () => void;
}) {
  const patch = usePatchMember(channelId);
  const people = usePeople().data;
  const [busy, setBusy] = useState(false);
  const rows = agentMembers(members, agents);
  const inviteRef = useRef<HTMLButtonElement>(null);
  // 행이 사라지면 초점을 「초대」로 옮긴다 — 제거 뒤 body 로 떨어지지 않게
  const [removedAt, setRemovedAt] = useState(0);
  useEffect(() => {
    if (removedAt > 0) inviteRef.current?.focus();
  }, [removedAt]);

  /**
   * 차례로(병렬 아님) — 앞 걸음이 끝나야 다음을 보낸다. 중간에 실패하면 멈춘다: 이미 끈 것은 캐시에 반영된
   * 그대로 둔다(되돌리지 않는다 — 어느 순간에도 둘이 켜지지는 않는다). 원인은 전역 토스트가 알린다
   */
  async function applyAutoRespond(steps: AutoRespondStep[]) {
    setBusy(true);
    try {
      for (const step of steps) {
        await patch.mutateAsync({ memberId: step.memberId, patch: { autoRespond: step.autoRespond } });
      }
    } catch (e) {
      // VALIDATION·CONFLICT 는 전역 토스트에서 빠진다 — 폼이 없으니 여기서 한 번
      const message = formError(e);
      if (message) toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  const handleOf = (agentId: string) => rows.find((r) => r.agent.id === agentId)?.agent.handle ?? "?";
  const humans = (members ?? []).filter((m) => m.memberType === "user");
  const byPerson = new Map((people ?? []).map((p) => [p.id, p]));

  return (
    <Section title="멤버">
      <InviteMembersDialog
        channelId={channelId}
        members={members}
        people={people}
        agents={agents}
        agentsError={agentsError}
        onRetryAgents={onRetryAgents}
        triggerRef={inviteRef}
      />
      {members === undefined ? (
        loadError ? (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            멤버 목록을 불러오지 못했습니다
            <Button variant="outline" size="sm" onClick={onRetry}>
              다시 시도
            </Button>
          </div>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            불러오는 중…
          </p>
        )
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-medium">사람</h4>
            {humans.length === 0 ? (
              <p className="text-sm text-muted-foreground">아직 참여한 사람이 없습니다.</p>
            ) : (
              <ul aria-label="채널 사람" className="flex flex-col gap-1">
                {humans.map((member) => (
                  <PersonMemberRow
                    key={member.id}
                    channelId={channelId}
                    member={member}
                    person={byPerson.get(member.memberId)}
                    onRemoved={() => setRemovedAt((n) => n + 1)}
                  />
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-medium">에이전트</h4>
            {agents === undefined ? (
              agentsError ? (
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  에이전트 목록을 불러오지 못했습니다
                  {onRetryAgents && (
                    <Button variant="outline" size="sm" onClick={onRetryAgents}>
                      다시 시도
                    </Button>
                  )}
                </div>
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  에이전트 목록을 불러오는 중…
                </p>
              )
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">아직 에이전트가 없습니다.</p>
            ) : (
              <ul aria-label="채널 에이전트" className="flex flex-col gap-2">
                {rows.map(({ member, agent }) => (
                  <AgentMemberRow
                    key={member.id}
                    channelId={channelId}
                    member={member}
                    agent={agent}
                    members={members}
                    handleOf={handleOf}
                    autoRespondBusy={busy}
                    onAutoRespond={(steps) => void applyAutoRespond(steps)}
                    onRemoved={() => setRemovedAt((n) => n + 1)}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </Section>
  );
}

/**
 * 채널의 사람 한 줄 — 아바타·이름·@핸들과 「빼기」. 빼기는 누구나(팀 스펙 「역할과 권한」 — 서버 authorizeChannelMemberRemove 가
 * member 이상), 역할을 모르면(옛 me·guest) 숨긴다. 뺀 사람도 그 채널에 다시 쓰거나 멘션되면 저절로 참여한다(「채널 참여」).
 * 사람 목록에 없으면 「알 수 없는 사람」
 */
function PersonMemberRow({
  channelId,
  member,
  person,
  onRemoved,
}: {
  channelId: string;
  member: ChannelMember;
  person: Person | undefined;
  onRemoved: () => void;
}) {
  const remove = useRemoveMember(channelId);
  const canRemove = useRole() !== undefined;
  const [removing, setRemoving] = useState(false);
  const removeRef = useRef<HTMLButtonElement>(null);
  const name = person ? person.displayName || person.handle : "알 수 없는 사람";
  const label = person ? `@${person.handle}` : name;
  return (
    <li className="flex min-w-0 items-center gap-2 text-sm">
      <IdentityAvatar
        kind="person"
        id={member.memberId}
        name={name}
        avatarUrl={person?.avatarUrl}
        size={24}
      />
      <span className="truncate font-medium">{name}</span>
      {person && <span className="truncate text-muted-foreground">@{person.handle}</span>}
      {canRemove && (
        <Button
          ref={removeRef}
          variant="ghost"
          size="xs"
          className="ml-auto"
          aria-label={`${label} 빼기`}
          onClick={() => setRemoving(true)}
        >
          빼기
        </Button>
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="사람 빼기"
        description={`${label} ${josa(label, "을", "를")} 이 채널에서 뺍니다. 이 채널에 다시 쓰거나 멘션되면 다시 참여합니다`}
        confirmLabel="빼기"
        pendingLabel="빼는 중…"
        pending={remove.isPending}
        destructive
        returnFocus={removeRef}
        onConfirm={() =>
          // mutate 의 콜백이 아니라 mutateAsync().then — 캐시 갱신으로 이 줄이 먼저 언마운트되면 mutate 콜백은 불리지 않아
          // 초점이 body 로 떨어진다(docs/guides/browser-verification.md 「초점 이동은 …」). 실패는 전역 토스트, 대화상자는 남는다
          void remove
            .mutateAsync({ memberType: "user", memberId: member.memberId })
            .then(() => {
              setRemoving(false);
              onRemoved();
            })
            .catch(() => {})
        }
      />
    </li>
  );
}

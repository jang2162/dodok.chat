import type { Agent, ChannelMember } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { formError } from "@/api/formErrors";
import { useCanManage } from "@/api/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { FieldError } from "@/ui/field-error";
import { Label } from "@/ui/label";
import { AgentMemberRow } from "./AgentMemberRow";
import type { AutoRespondStep } from "./autoRespond";
import { useAddMember, usePatchMember } from "./mutations";
import { Section } from "./Section";

export type AgentMember = { member: ChannelMember; agent: Agent };

/** 채널의 에이전트 멤버(합류 순)와 그 에이전트. 목록에 없는 에이전트는 건너뛴다 */
export function agentMembers(members: ChannelMember[] = [], agents: Agent[] = []): AgentMember[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return members.flatMap((member) => {
    const agent = member.memberType === "agent" ? byId.get(member.memberId) : undefined;
    return agent ? [{ member, agent }] : [];
  });
}

/**
 * 멤버(스펙 6.4): 에이전트 추가 + 에이전트 행. 자동 응답 바꾸기는 여기서 차례로 보낸다 — 한 번에 하나만 돌고,
 * 도는 동안 모든 행의 자동 응답 스위치를 잠근다(두 흐름이 겹쳐 둘이 켜지지 않게)
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
  const [busy, setBusy] = useState(false);
  const rows = agentMembers(members, agents);
  const addRef = useRef<HTMLSelectElement>(null);
  // 행이 사라지면 초점을 「에이전트 추가」로 옮긴다 — 제거 뒤 body 로 떨어지지 않게
  const [removedAt, setRemovedAt] = useState(0);
  useEffect(() => {
    if (removedAt > 0) addRef.current?.focus();
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

  return (
    <Section title="멤버">
      <AddAgentForm
        channelId={channelId}
        members={members}
        agents={agents}
        agentsError={agentsError}
        onRetryAgents={onRetryAgents}
        selectRef={addRef}
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
      ) : agents === undefined ? null : rows.length === 0 ? ( // 에이전트 목록 상태는 위 폼이 보인다
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
    </Section>
  );
}

/** 등록됐고 아직 멤버가 아닌 에이전트를 골라 넣는다. VALIDATION·CONFLICT 만 폼 안에, 그 밖은 전역 토스트 */
function AddAgentForm({
  channelId,
  members,
  agents,
  agentsError,
  onRetryAgents,
  selectRef,
}: {
  channelId: string;
  members: ChannelMember[] | undefined;
  agents: Agent[] | undefined;
  agentsError: boolean;
  onRetryAgents?: () => void;
  selectRef: RefObject<HTMLSelectElement | null>;
}) {
  const add = useAddMember(channelId);
  const canManage = useCanManage();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string>();
  const id = useId();

  // 에이전트 목록을 아직 못 받았으면 상태를 보인다 — 「등록된 에이전트가 없습니다」와 섞이지 않게(원인은 전역 토스트)
  if (agents === undefined) {
    return agentsError ? (
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
    );
  }
  if (agents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        등록된 에이전트가 없습니다.
        {canManage && (
          <>
            {" "}
            <Link to="/agents" className="text-primary underline-offset-4 hover:underline">
              에이전트 화면에서 등록하세요
            </Link>
          </>
        )}
      </p>
    );
  }
  const memberIds = new Set((members ?? []).filter((m) => m.memberType === "agent").map((m) => m.memberId));
  const candidates = agents.filter((a) => !memberIds.has(a.id));
  const ready = members !== undefined;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected || add.isPending) return;
    setError(undefined);
    add.mutate(selected, {
      onSuccess: () => setSelected(""),
      onError: (err) => setError(formError(err)),
    });
  }

  if (ready && candidates.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        등록된 에이전트가 모두 채널에 있습니다.
        {canManage && (
          <>
            {" "}
            <Link to="/agents" className="text-primary underline-offset-4 hover:underline">
              에이전트 등록
            </Link>
          </>
        )}
      </p>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5">
      <Label htmlFor={id}>에이전트 추가</Label>
      <div className="flex gap-2">
        <select
          id={id}
          ref={selectRef}
          value={selected}
          aria-invalid={error !== undefined || undefined}
          aria-describedby={error === undefined ? undefined : `${id}-error`}
          disabled={!ready || add.isPending}
          onChange={(e) => {
            setSelected(e.target.value);
            setError(undefined);
          }}
          className={cn(
            "h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none",
            "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50",
          )}
        >
          <option value="">에이전트 선택</option>
          {candidates.map((a) => (
            <option key={a.id} value={a.id}>
              {`@${a.handle} — ${a.name}${a.enabled ? "" : " (꺼짐)"}`}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" className="h-9" disabled={!selected || add.isPending}>
          {add.isPending ? "추가하는 중…" : "추가"}
        </Button>
      </div>
      <FieldError id={`${id}-error`} role="alert" className="text-sm empty:-mt-1.5">
        {error}
      </FieldError>
    </form>
  );
}

import type { Agent, ChannelMember, Person } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { type RefObject, useId, useState } from "react";
import { formError } from "@/api/formErrors";
import { useCanManage } from "@/api/queries";
import { isArchived } from "@/features/agents/archived";
import { gatewaySuffix } from "@/features/agents/gatewaySuffix";
import { isDeactivated } from "@/features/members/deactivated";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import { IdentityAvatar } from "@/ui/identity-avatar";
import { Input } from "@/ui/input";
import { type MemberRef, useAddMember } from "./mutations";

/** 후보 한 줄 — 사람이면 person, 에이전트면 agent */
export type InviteCandidate =
  | { kind: "user"; key: string; id: string; name: string; handle: string; person: Person }
  | { kind: "agent"; key: string; id: string; name: string; handle: string; agent: Agent };

const keyOf = (ref: MemberRef) => `${ref.memberType}:${ref.memberId}`;

/**
 * 초대할 수 있는 사람·에이전트 — 이미 멤버인 것, 보관(삭제)한 에이전트, 비활성 사람과 membership 이 없는 사람은 뺀다(서버도 404·409).
 * 나 자신은 아직 참여하지 않았을 때만 남는다(멤버 거름이 한다). 사람이 먼저, 각 묶음 안에서는 받은 순서 그대로
 */
export function inviteCandidates(
  members: readonly ChannelMember[],
  people: readonly Person[],
  agents: readonly Agent[],
): InviteCandidate[] {
  const taken = new Set(members.map(keyOf));
  const humans = people
    .filter((p) => p.role !== undefined && !isDeactivated(p) && !taken.has(`user:${p.id}`))
    .map((p): InviteCandidate => ({
      kind: "user",
      key: `user:${p.id}`,
      id: p.id,
      name: p.displayName || p.handle,
      handle: p.handle,
      person: p,
    }));
  const bots = agents
    .filter((a) => !isArchived(a) && !taken.has(`agent:${a.id}`))
    .map((a): InviteCandidate => ({
      kind: "agent",
      key: `agent:${a.id}`,
      id: a.id,
      name: a.name,
      handle: a.handle,
      agent: a,
    }));
  return [...humans, ...bots];
}

/** 핸들·이름의 부분 일치(대소문자 무시). 앞의 `@` 는 떼고 본다 */
export function matchesQuery(c: Pick<InviteCandidate, "name" | "handle">, query: string): boolean {
  const q = query.trim().replace(/^@/, "").toLowerCase();
  return q === "" || c.handle.toLowerCase().includes(q) || c.name.toLowerCase().includes(q);
}

/**
 * 채널 설정 「멤버」 칸의 「초대」(채널 UI 스펙 4장) — 사람과 에이전트를 한 검색칸으로 찾아 여럿 골라 넣는다. 넣기는 고른 차례로 하나씩
 * POST 한다(병렬 아님 — 서버의 첫 Gateway 프롬프트 동기화가 겹치지 않게). 성공한 것은 멤버 캐시에 들어가 후보에서 저절로 빠지고, 실패한 것은
 * 골라 둔 채 그 줄에 까닭을 남긴다 — 하나라도 실패하면 닫지 않는다. 전부 성공하면 닫고 초점은 Radix 가 「초대」 단추로 돌린다.
 * 폼 오류(VALIDATION·CONFLICT·AGENT_ARCHIVED)는 그 줄에만, 그 밖은 전역 토스트도 함께 알리고 줄에는 짧은 문구
 */
export function InviteMembersDialog({
  channelId,
  members,
  people,
  agents,
  agentsError,
  onRetryAgents,
  triggerRef,
}: {
  channelId: string;
  /** undefined 면 아직 못 받았다 — 단추를 잠근다 */
  members: ChannelMember[] | undefined;
  people: Person[] | undefined;
  agents: Agent[] | undefined;
  agentsError: boolean;
  onRetryAgents?: () => void;
  /** 멤버를 뺀 뒤 초점을 돌려받을 자리 */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const add = useAddMember(channelId);
  const canManage = useCanManage();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const id = useId();

  const all = inviteCandidates(members ?? [], people ?? [], agents ?? []);
  const byKey = new Map(all.map((c) => [c.key, c]));
  // 실패한 줄은 거름 밖으로 밀려도(그 사이 다른 탭이 넣었거나 보관했다) 까닭과 함께 남는다 — 사라지면 무엇이 실패했는지 모른다
  const shown = all.filter((c) => matchesQuery(c, query) || errors[c.key] !== undefined);
  const chosen = picked.filter((k) => byKey.has(k));
  const liveAgents = (agents ?? []).filter((a) => !isArchived(a));

  function onOpenChange(next: boolean) {
    if (!next && busy) return;
    setOpen(next);
    setQuery("");
    setPicked([]);
    setErrors({});
  }

  function toggle(key: string) {
    setPicked((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function submit() {
    if (chosen.length === 0 || busy) return;
    setBusy(true);
    const failed: Record<string, string> = {};
    for (const key of chosen) {
      const c = byKey.get(key);
      if (!c) continue;
      try {
        await add.mutateAsync({ memberType: c.kind, memberId: c.id });
      } catch (e) {
        failed[key] = formError(e) ?? "초대하지 못했습니다";
      }
    }
    setBusy(false);
    const left = Object.keys(failed);
    if (left.length === 0) {
      setOpen(false);
      setQuery("");
      setPicked([]);
      setErrors({});
      return;
    }
    setPicked(left);
    setErrors(failed);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          ref={triggerRef}
          variant="outline"
          size="sm"
          className="self-start"
          disabled={members === undefined}
        >
          초대
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>채널에 초대</DialogTitle>
          <DialogDescription>사람과 에이전트를 여럿 골라 한 번에 넣습니다.</DialogDescription>
        </DialogHeader>
        <Input
          aria-label="사람·에이전트 찾기"
          placeholder="핸들이나 이름"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {agents === undefined && (
          <div role="status" className="flex items-center gap-3 text-sm text-muted-foreground">
            {agentsError ? "에이전트 목록을 불러오지 못했습니다" : "에이전트 목록을 불러오는 중…"}
            {agentsError && onRetryAgents && (
              <Button variant="outline" size="sm" onClick={onRetryAgents}>
                다시 시도
              </Button>
            )}
          </div>
        )}
        {agents !== undefined && liveAgents.length === 0 && (
          <p className="text-sm text-muted-foreground">
            등록된 에이전트가 없습니다.
            {canManage && (
              <>
                {" "}
                <Link to="/settings/connection" className="text-primary underline-offset-4 hover:underline">
                  설정 → 연결에서 데려오세요
                </Link>
              </>
            )}
          </p>
        )}
        {liveAgents.length > 0 && !all.some((c) => c.kind === "agent") && (
          <p className="text-xs text-muted-foreground">
            등록된 에이전트가 모두 채널에 있습니다.
            {canManage && (
              <>
                {" "}
                <Link to="/settings/connection" className="text-primary underline-offset-4 hover:underline">
                  에이전트 등록
                </Link>
              </>
            )}
          </p>
        )}
        {all.length === 0 ? (
          <p className="text-sm text-muted-foreground">초대할 사람이나 에이전트가 없습니다.</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">찾는 사람이나 에이전트가 없습니다.</p>
        ) : (
          <ul aria-label="초대 후보" className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {shown.map((c) => (
              <CandidateRow
                key={c.key}
                candidate={c}
                on={picked.includes(c.key)}
                disabled={busy}
                error={errors[c.key]}
                errorId={`${id}-${c.key}-error`}
                onToggle={() => toggle(c.key)}
              />
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button
            size="sm"
            aria-disabled={chosen.length === 0 || busy || undefined}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={() => void submit()}
          >
            {busy ? "초대하는 중…" : chosen.length > 0 ? `초대 (${chosen.length})` : "초대"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 후보 한 줄 — 누르면 고르기·풀기(`aria-pressed`). 종류(「사람」/「에이전트」)·Gateway 꼬리·「꺼짐」, 실패하면 그 아래 까닭 */
function CandidateRow({
  candidate: c,
  on,
  disabled,
  error,
  errorId,
  onToggle,
}: {
  candidate: InviteCandidate;
  on: boolean;
  disabled: boolean;
  error: string | undefined;
  errorId: string;
  onToggle: () => void;
}) {
  return (
    <li className="flex flex-col gap-0.5">
      <button
        type="button"
        aria-pressed={on}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        disabled={disabled}
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 aria-pressed:bg-accent"
      >
        {c.kind === "user" ? (
          <IdentityAvatar kind="person" id={c.id} name={c.name} avatarUrl={c.person.avatarUrl} size={24} />
        ) : (
          <IdentityAvatar
            kind="agent"
            id={c.id}
            name={c.name}
            handle={c.handle}
            avatarUrl={c.agent.avatarUrl}
            size={24}
          />
        )}
        <span className="truncate font-medium">{c.name}</span>
        <span className="truncate text-muted-foreground">
          @{c.handle}
          {c.kind === "agent" ? gatewaySuffix(c.agent) : ""}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {c.kind === "agent" && !c.agent.enabled && <span>꺼짐</span>}
          <span className="rounded-sm border px-1">{c.kind === "user" ? "사람" : "에이전트"}</span>
          {on && <CheckIcon aria-hidden className="size-4" />}
        </span>
      </button>
      {error !== undefined && (
        <p id={errorId} role="alert" className="px-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

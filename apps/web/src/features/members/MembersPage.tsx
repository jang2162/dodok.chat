import type { Invite, MemberRow, TeamRole } from "@dodok/shared";
import { ChevronRightIcon } from "lucide-react";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { useCachedMe, useRole } from "@/api/queries";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { isDeactivated } from "./deactivated";
import { InviteDialog } from "./InviteDialog";
import { MemberRowActions, canActOn } from "./MemberRowActions";
import { useChangeRole, useRevokeInvite, useSetMemberActive } from "./mutations";
import { useInvites, useTeamMembers } from "./queries";

const ROLE_LABEL: Record<TeamRole, string> = { owner: "소유자", admin: "관리자", member: "멤버" };
const DATE = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" });
const dateOf = (iso: string) => DATE.format(new Date(iso));

/**
 * 멤버 관리(`/settings/members`, 팀 스펙 4·6장): 멤버 표·줄 동작·「비활성 멤버 N」·초대·대기 중인 초대. admin 이상만 본다 — 아니면 팀 API 를
 * 부르지 않고 「권한이 없습니다」(운영·연결 페이지와 같은 규칙). 역할이 내려가면 me 를 다시 받는 순간(403 전역 처리) 이 문구로 바뀐다
 */
export function MembersPage() {
  const role = useRole();
  const manager = role === "owner" || role === "admin" ? role : undefined;
  return (
    <section data-testid="page-members" className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">멤버</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            워크스페이스 사람을 초대하고 역할·비밀번호 재설정·비활성화를 맡습니다.
          </p>
        </div>
        {manager && <InviteDialog viewerRole={manager} />}
      </header>
      {manager ? (
        <>
          <MembersTable viewerRole={manager} />
          <PendingInvites viewerRole={manager} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          권한이 없습니다 — 멤버 관리는 관리자만 볼 수 있습니다.
        </p>
      )}
    </section>
  );
}

/**
 * 서버 목록은 비활성 멤버도 함께 준다 — 활성 멤버는 표에, 비활성 멤버는 아래 접힌 「비활성 멤버 N」 묶음에
 * (채널 보관·멤버 비활성화 스펙 「웹」 소절, 에이전트 탭의 「삭제된 에이전트 N」과 같은 꼴)
 */
function MembersTable({ viewerRole }: { viewerRole: "owner" | "admin" }) {
  const members = useTeamMembers();
  const groupRef = useRef<HTMLButtonElement>(null);
  // 비활성화하면 그 줄(과 「비활성화」)이 사라진다 — 초점을 묶음 단추로. 묶음은 다시 그린 뒤에야 생기므로 그려진 다음에 옮긴다
  const [deactivatedAt, setDeactivatedAt] = useState(0);
  useEffect(() => {
    if (deactivatedAt > 0) groupRef.current?.focus();
  }, [deactivatedAt]);
  // 다시 활성화하면 그 줄이 묶음에서 빠진다 — 묶음이 남으면 묶음 단추로, 마지막 하나였으면(묶음도 사라진다) 표에 돌아온 그 줄로
  const [reactivatedId, setReactivatedId] = useState<string | null>(null);
  const reactivatedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const data = members.data ?? [];
    if (reactivatedId === null || !data.some((m) => m.id === reactivatedId && !isDeactivated(m))) return;
    (data.some(isDeactivated) ? groupRef.current : reactivatedRef.current)?.focus();
    setReactivatedId(null);
  }, [reactivatedId, members.data]);

  if (!members.data) {
    return members.isError ? (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">멤버 목록을 불러오지 못했습니다</p>
        <Button
          variant="outline"
          size="sm"
          disabled={members.isFetching}
          onClick={() => void members.refetch()}
        >
          다시 시도
        </Button>
      </div>
    ) : (
      <p role="status" className="text-sm text-muted-foreground">
        불러오는 중…
      </p>
    );
  }
  const active = members.data.filter((m) => !isDeactivated(m));
  const deactivated = members.data.filter(isDeactivated);
  return (
    <>
      {/* 좁은 화면에서는 표가 제 상자 안에서 가로로 스크롤한다 — 페이지가 넘치지 않게.
          relative 가 없으면 「동작」 sr-only span(absolute)의 포함 블록이 이 상자 밖(초기 포함 블록)이 되어
          표가 넓어진 만큼 문서 전체를 가로로 넓힌다(D1) */}
      <div className="relative overflow-x-auto rounded-lg border">
        <table aria-label="멤버" className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              {["핸들", "이름", "이메일", "역할", "가입일"].map((h) => (
                <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
              <th scope="col" className="px-3 py-2 text-right font-medium">
                <span className="sr-only">동작</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {active.map((m) => (
              <MemberLine
                key={m.id}
                member={m}
                viewerRole={viewerRole}
                onDeactivated={() => setDeactivatedAt((n) => n + 1)}
                {...(m.id === reactivatedId ? { focusRef: reactivatedRef } : {})}
              />
            ))}
          </tbody>
        </table>
      </div>
      {deactivated.length > 0 && (
        <DeactivatedMembers
          members={deactivated}
          viewerRole={viewerRole}
          toggleRef={groupRef}
          onReactivated={setReactivatedId}
        />
      )}
    </>
  );
}

function MemberLine({
  member,
  viewerRole,
  focusRef,
  onDeactivated,
}: {
  member: MemberRow;
  viewerRole: "owner" | "admin";
  focusRef?: RefObject<HTMLButtonElement | null>;
  onDeactivated: () => void;
}) {
  const meId = useCachedMe()?.user.id;
  return (
    <tr>
      <td className="px-3 py-2 font-medium whitespace-nowrap">
        @{member.handle}
        {member.id === meId && <span className="ml-1 text-xs font-normal text-muted-foreground">(나)</span>}
      </td>
      <td className="px-3 py-2">{member.displayName}</td>
      <td className="px-3 py-2 text-muted-foreground">
        {/* 좁은 화면에서 글자 단위로 끊지 않고 말줄임 — 전체 값은 툴팁 */}
        <span className="block max-w-48 truncate sm:max-w-64" title={member.email ?? undefined}>
          {member.email ?? "—"}
        </span>
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <RoleCell member={member} viewerRole={viewerRole} />
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{dateOf(member.createdAt)}</td>
      <td className="px-3 py-2">
        <MemberRowActions
          member={member}
          viewerRole={viewerRole}
          onDeactivated={onDeactivated}
          {...(focusRef ? { focusRef } : {})}
        />
      </td>
    </tr>
  );
}

/**
 * 「비활성 멤버 N」 접힌 묶음 — 줄마다 핸들·이름·이메일·역할, 손댈 수 있는 줄(비활성화와 같은 권한)이면 「다시 활성화」.
 * 역할 바꾸기·재설정 링크는 없다 — 서버가 비활성 대상을 없는 사람(404)으로 본다. 다시 활성화하면 줄이 표로 옮겨 간다
 */
function DeactivatedMembers({
  members,
  viewerRole,
  toggleRef,
  onReactivated,
}: {
  members: readonly MemberRow[];
  viewerRole: "owner" | "admin";
  toggleRef: RefObject<HTMLButtonElement | null>;
  onReactivated: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <section aria-label="비활성 멤버" className="flex flex-col gap-3">
      <Button
        ref={toggleRef}
        variant="ghost"
        size="sm"
        className="self-start text-muted-foreground"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRightIcon aria-hidden className={cn("transition-transform", open && "rotate-90")} />
        비활성 멤버 {members.length}
      </Button>
      {open && (
        <ul id={listId} className="flex flex-col divide-y rounded-lg border border-dashed">
          {members.map((member) => (
            <DeactivatedLine
              key={member.id}
              member={member}
              viewerRole={viewerRole}
              onReactivated={onReactivated}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function DeactivatedLine({
  member,
  viewerRole,
  onReactivated,
}: {
  member: MemberRow;
  viewerRole: "owner" | "admin";
  onReactivated: (id: string) => void;
}) {
  const reactivate = useSetMemberActive();
  const handle = `@${member.handle}`;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm text-muted-foreground">
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{handle}</span>
        <span>{member.displayName}</span>
        <span className="max-w-full truncate" title={member.email ?? undefined}>
          {member.email ?? "—"}
        </span>
        <span>{ROLE_LABEL[member.role]}</span>
      </div>
      {canActOn(viewerRole, member.role) && (
        <Button
          variant="outline"
          size="sm"
          aria-label={`${handle} 다시 활성화`}
          disabled={reactivate.isPending}
          onClick={() => reactivate.setActive(member.id, true, () => onReactivated(member.id))}
        >
          {reactivate.isPending ? "활성화하는 중…" : "다시 활성화"}
        </Button>
      )}
    </li>
  );
}

/**
 * 역할 — owner 가 보는 owner 아닌 줄만 바꿀 수 있다(admin ↔ member). 바꾸는 중에는 잠근다.
 * 승격은 곧바로, **강등(admin → member)만** 확인을 거친다 — 강등하면 서버가 그 사람이 만든 쓰이지 않은 초대·재설정 링크를 폐기하고
 * 다시 올려도 살아나지 않는다(p4m-t7b o6). 셀렉트는 제어형이라 확인 전·취소 뒤에는 원래 값(관리자)을 보인다
 */
function RoleCell({ member, viewerRole }: { member: MemberRow; viewerRole: "owner" | "admin" }) {
  const change = useChangeRole();
  const [confirming, setConfirming] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  if (viewerRole !== "owner" || member.role === "owner") return <>{ROLE_LABEL[member.role]}</>;
  const handle = `@${member.handle}`;
  return (
    <>
      <select
        ref={selectRef}
        aria-label={`${handle} 역할`}
        value={member.role}
        disabled={change.isPending}
        onChange={(e) => {
          const role = e.target.value as "admin" | "member";
          if (member.role === "admin" && role === "member") setConfirming(true);
          else change.mutate({ userId: member.id, role });
        }}
        className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <option value="member">{ROLE_LABEL.member}</option>
        <option value="admin">{ROLE_LABEL.admin}</option>
      </select>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`${handle} 을 ${ROLE_LABEL.member}로 바꿀까요?`}
        description={`이 사람이 만든 쓰이지 않은 초대·재설정 링크는 쓸 수 없게 되고, 다시 ${ROLE_LABEL.admin}로 올려도 살아나지 않습니다.`}
        confirmLabel={`${ROLE_LABEL.member}로 바꾸기`}
        pendingLabel="바꾸는 중…"
        pending={change.isPending}
        destructive
        returnFocus={selectRef}
        onConfirm={() =>
          change.mutate({ userId: member.id, role: "member" }, { onSettled: () => setConfirming(false) })
        }
      />
    </>
  );
}

/** 대기 중인(유효한) 초대 — 역할·만료·원문 앞 8자, 「폐기」. admin 은 member 초대만 폐기한다(서버가 막는다) */
function PendingInvites({ viewerRole }: { viewerRole: "owner" | "admin" }) {
  const invites = useInvites();
  const revoke = useRevokeInvite();
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-base font-semibold">
        대기 중인 초대
      </h2>
      {!invites.data ? (
        <p role="status" className="text-sm text-muted-foreground">
          {invites.isError ? "초대 목록을 불러오지 못했습니다" : "불러오는 중…"}
        </p>
      ) : invites.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">대기 중인 초대가 없습니다</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {invites.data.map((invite: Invite) => {
            const role = invite.role ?? "member";
            return (
              <li
                key={invite.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <span>
                  {ROLE_LABEL[role]} 초대{" "}
                  <code className="font-mono text-xs text-muted-foreground">{invite.prefix}…</code>
                  <span className="text-muted-foreground"> · 만료 {dateOf(invite.expiresAt)}</span>
                </span>
                {(viewerRole === "owner" || role === "member") && (
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={`${invite.prefix} 초대 폐기`}
                    disabled={revoke.isPending && revoke.variables === invite.id}
                    onClick={() => revoke.mutate(invite.id)}
                  >
                    폐기
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

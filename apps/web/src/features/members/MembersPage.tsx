import type { Invite, MemberRow, TeamRole } from "@dodok/shared";
import { useId } from "react";
import { useCachedMe, useRole } from "@/api/queries";
import { Button } from "@/ui/button";
import { InviteDialog } from "./InviteDialog";
import { MemberRowActions } from "./MemberRowActions";
import { useChangeRole, useRevokeInvite } from "./mutations";
import { useInvites, useTeamMembers } from "./queries";

const ROLE_LABEL: Record<TeamRole, string> = { owner: "소유자", admin: "관리자", member: "멤버" };
const DATE = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" });
const dateOf = (iso: string) => DATE.format(new Date(iso));

/**
 * 멤버 관리(`/settings/members`, 팀 스펙 4·6장): 멤버 표·줄 동작·초대·대기 중인 초대. admin 이상만 본다 — 아니면 팀 API 를
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
            워크스페이스 사람을 초대하고 역할·비밀번호 재설정·내보내기를 맡습니다.
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

function MembersTable({ viewerRole }: { viewerRole: "owner" | "admin" }) {
  const members = useTeamMembers();
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
  return (
    // 좁은 화면에서는 표가 제 상자 안에서 가로로 스크롤한다 — 페이지가 넘치지 않게.
    // relative 가 없으면 「동작」 sr-only span(absolute)의 포함 블록이 이 상자 밖(초기 포함 블록)이 되어
    // 표가 넓어진 만큼 문서 전체를 가로로 넓힌다(D1)
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
          {members.data.map((m) => (
            <MemberLine key={m.id} member={m} viewerRole={viewerRole} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberLine({ member, viewerRole }: { member: MemberRow; viewerRole: "owner" | "admin" }) {
  const meId = useCachedMe()?.user.id;
  return (
    <tr>
      <td className="px-3 py-2 font-medium whitespace-nowrap">
        @{member.handle}
        {member.id === meId && <span className="ml-1 text-xs font-normal text-muted-foreground">(나)</span>}
      </td>
      <td className="px-3 py-2">{member.displayName}</td>
      <td className="px-3 py-2 break-all text-muted-foreground">{member.email ?? "—"}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        <RoleCell member={member} viewerRole={viewerRole} />
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{dateOf(member.createdAt)}</td>
      <td className="px-3 py-2">
        <MemberRowActions member={member} viewerRole={viewerRole} />
      </td>
    </tr>
  );
}

/** 역할 — owner 가 보는 owner 아닌 줄만 바꿀 수 있다(admin ↔ member). 바꾸는 중에는 잠근다 */
function RoleCell({ member, viewerRole }: { member: MemberRow; viewerRole: "owner" | "admin" }) {
  const change = useChangeRole();
  if (viewerRole !== "owner" || member.role === "owner") return <>{ROLE_LABEL[member.role]}</>;
  return (
    <select
      aria-label={`@${member.handle} 역할`}
      value={member.role}
      disabled={change.isPending}
      onChange={(e) => change.mutate({ userId: member.id, role: e.target.value as "admin" | "member" })}
      className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <option value="member">{ROLE_LABEL.member}</option>
      <option value="admin">{ROLE_LABEL.admin}</option>
    </select>
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

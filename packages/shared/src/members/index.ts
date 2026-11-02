import { z } from "zod";
import { Id, IsoDateTime } from "../common";
import { Handle } from "../domain";
import { AvatarUrl, StatusMessage } from "../profile";

// 팀 계약(설계 `2026-09-26-team-members-design.md` 「역할과 권한」·「초대·가입·로그인」·「멤버 관리」 절).
// 서버가 역할을 막는다 — 여기 스키마는 모양만 검증한다.

export const TeamRole = z.enum(["owner", "admin", "member"]);
export type TeamRole = z.infer<typeof TeamRole>;

const ROLE_RANK: Record<TeamRole, number> = { member: 0, admin: 1, owner: 2 };

/** role 이 min 이상인가. 모르는 값(guest·undefined)은 false */
export function roleAtLeast(role: string | undefined, min: TeamRole): boolean {
  if (role === undefined) return false;
  const parsed = TeamRole.safeParse(role);
  return parsed.success && ROLE_RANK[parsed.data] >= ROLE_RANK[min];
}

export const Password = z.string().min(12).max(256);
export type Password = z.infer<typeof Password>;
export const DisplayName = z.string().trim().min(1).max(64);
export type DisplayName = z.infer<typeof DisplayName>;

export const InviteKind = z.enum(["invite", "reset"]);
export type InviteKind = z.infer<typeof InviteKind>;

export const Invite = z.object({
  id: Id,
  kind: InviteKind,
  role: z.enum(["admin", "member"]).optional(), // kind === "invite" 일 때만
  targetUserId: Id.optional(), // kind === "reset" 일 때만
  prefix: z.string(),
  createdBy: Id,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type Invite = z.infer<typeof Invite>;

export const IssueInviteBody = z.object({ role: z.enum(["admin", "member"]) });
export type IssueInviteBody = z.infer<typeof IssueInviteBody>;

/** 발급 응답 — token 원문은 이 응답 한 번뿐이다(목록·로그·wire 에 다시 나오지 않는다) */
export const IssuedInvite = z.object({ invite: Invite, token: z.string(), url: z.string() });
export type IssuedInvite = z.infer<typeof IssuedInvite>;

export const TokenBody = z.object({ token: z.string().min(1).max(200) });
export type TokenBody = z.infer<typeof TokenBody>;

export const InviteLookup = z.object({
  workspaceName: z.string(),
  kind: InviteKind,
  role: z.enum(["admin", "member"]).optional(),
});
export type InviteLookup = z.infer<typeof InviteLookup>;

export const AcceptInviteBody = z.object({
  token: z.string().min(1).max(200),
  handle: Handle,
  displayName: DisplayName,
  email: z.email().max(254),
  password: Password,
});
export type AcceptInviteBody = z.infer<typeof AcceptInviteBody>;

export const ResetPasswordBody = z.object({ token: z.string().min(1).max(200), password: Password });
export type ResetPasswordBody = z.infer<typeof ResetPasswordBody>;

/** owner 는 로컬 토큰, 멤버는 이메일+비밀번호(설계 「로그인」 절). strict — 두 모양이 섞이면 거절한다 */
export const LocalLoginBody = z.union([
  z.strictObject({ token: z.string().min(1).max(256) }),
  z.strictObject({ email: z.email().max(254), password: z.string().min(1).max(256) }),
]);
export type LocalLoginBody = z.infer<typeof LocalLoginBody>;

/** 워크스페이스 사람 목록 한 줄(wire `people.changed`, @멘션 해석, 참여자 표시) */
export const Person = z.object({
  id: Id,
  handle: z.string(),
  displayName: z.string(),
  role: TeamRole.optional(), // role 없음 = membership 이 없거나 모르는 역할(guest 등)
  /** 비활성화한 시각 — null 이면 활성. 비활성 멤버도 목록에 남는다(기록의 작성자·멘션 칩을 그리려면 웹이 알아야 한다) */
  deactivatedAt: IsoDateTime.nullable(),
  avatarUrl: AvatarUrl.optional(),
  /** 상태 메시지 — 만료가 지난 것은 싣지 않는다. 수동 상태 모드는 싣지 않는다(오프라인으로 보이기가 드러나지 않게) */
  statusMessage: StatusMessage.nullable().default(null),
});
export type Person = z.infer<typeof Person>;

/** `/settings/members` 표 한 줄 — membership 이 있는 사람만이라 role 이 항상 있다. 비활성 멤버도 deactivatedAt 과 함께 싣는다 */
export const MemberRow = Person.extend({
  role: TeamRole,
  email: z.string().optional(),
  createdAt: IsoDateTime,
});
export type MemberRow = z.infer<typeof MemberRow>;

export const UpdateMemberRoleBody = z.object({ role: z.enum(["admin", "member"]) });
export type UpdateMemberRoleBody = z.infer<typeof UpdateMemberRoleBody>;

export const UpdateMeBody = z.object({ displayName: DisplayName });
export type UpdateMeBody = z.infer<typeof UpdateMeBody>;

export const ChangePasswordBody = z.object({ current: z.string().min(1).max(256), next: Password });
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;

// 개인 토큰(PAT) — 바깥 MCP 클라이언트가 `/mcp` 에 붙는 토큰(제어 MCP 스펙 「주체」 장). 원문 dpt_… 은 발급 응답 한 번뿐이다

/** 사람마다 살아 있는(폐기 안 한) 토큰 상한 */
export const PERSONAL_TOKENS_MAX = 10;

export const PersonalTokenCreate = z.object({ label: z.string().trim().min(1).max(40) });
export type PersonalTokenCreate = z.infer<typeof PersonalTokenCreate>;

export const PersonalTokenSummary = z.object({
  id: Id,
  label: z.string(),
  prefix: z.string(), // 원문 앞부분 — 목록에서 어느 토큰인지 가른다
  createdAt: IsoDateTime,
  lastUsedAt: IsoDateTime.optional(),
});
export type PersonalTokenSummary = z.infer<typeof PersonalTokenSummary>;

export const PersonalTokenIssued = z.object({ token: PersonalTokenSummary, raw: z.string() });
export type PersonalTokenIssued = z.infer<typeof PersonalTokenIssued>;

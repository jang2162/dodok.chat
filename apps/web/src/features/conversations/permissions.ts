import {
  type ChannelMember,
  type Conversation,
  roleAtLeast,
  type SessionPolicy,
  type TeamRole,
} from "@dodok/shared";
import { useCachedMe, useChannel, useMembers, useRole } from "@/api/queries";
import { isChannelArchived } from "@/features/channels/archived";
import { isDmChannel, useDm } from "@/features/dms/queries";

// 서버 판정(apps/server/src/auth/policies.ts 의 세션 쪽 — authorizeConversationCreate·authorizeConversationManage)을 웹이 흉내 낸다.
// 숨김·잠금은 편의이고 판정은 서버가 요청마다 한다(채널 세션 스펙 「권한」 장). 표를 바꾸면 두 곳을 함께 바꾼다

/** 이 사람이 그 채널의 세션 관리자인가 — 채널 멤버(사람 행)의 role */
export const isSessionManagerOf = (
  members: readonly ChannelMember[] | undefined,
  userId: string | undefined,
) =>
  userId !== undefined &&
  (members ?? []).some((m) => m.memberType === "user" && m.memberId === userId && m.role === "manager");

/** 새 세션 — 정책 members 면 누구나, managers 면 그 채널의 세션 관리자와 admin 이상 */
export function canCreateConversation(
  role: TeamRole | undefined,
  policy: SessionPolicy,
  isManager: boolean,
): boolean {
  if (!roleAtLeast(role, "member")) return false;
  return policy.create === "members" || isManager || roleAtLeast(role, "admin");
}

/** 제목 바꾸기·닫기·다시 열기 — 만든 사람(자기 세션), 세션 관리자, admin 이상. 자동화가 만든 세션은 만든 사람이 없다 */
export function canManageConversation(
  role: TeamRole | undefined,
  conversation: Pick<Conversation, "createdBy">,
  userId: string | undefined,
  isManager: boolean,
): boolean {
  if (!roleAtLeast(role, "member")) return false;
  const isCreator = conversation.createdBy.type === "user" && conversation.createdBy.id === userId;
  return isCreator || isManager || roleAtLeast(role, "admin");
}

/**
 * 지금 사람의 세션 권한 — 채널·멤버·me 캐시에서. 보관한 채널에는 새 세션을 만들 수 없다(서버가 409 — 정책과 따로 쓰기 막기가 먼저다).
 * `canCreate` 는 아직 가를 수 없으면(채널을, 「세션 관리자만」이면 멤버를 아직 못 받았다) undefined — 숨기는 쪽은 거짓처럼 쓰고, 작성기 대신
 * 안내를 그리는 쪽은 `false` 일 때만 그린다(받는 동안 모든 사람에게 안내가 번쩍이지 않게). `enabled` 가 거짓이면 멤버를 부르지 않는다.
 * DM 은 주인만 보고(남에게는 서버가 404) 세션 정책이 늘 「주인만」이다 — 읽기 전용 DM(에이전트 DM 스펙 3.3)이면 새 세션을 만들 수 없다
 * (서버 409 DM_READ_ONLY). 사유는 DM 목록에서 읽는다
 */
export function useConversationPermissions(
  channelId: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const role = useRole();
  // 관찰자를 두지 않는다(`useCachedMe`) — 로그아웃·401 의 캐시 비우기 뒤 머리가 me 를 다시 불러 로그인 화면을 되돌리지 않게
  const meId = useCachedMe()?.user.id;
  const channel = useChannel(channelId).data;
  const members = useMembers(channelId, { enabled }).data;
  const isManager = isSessionManagerOf(members, meId);
  const dm = useDm(channelId, isDmChannel(channel));
  const policy = channel?.sessionPolicy ?? { create: "members" };
  const canCreate =
    channel === undefined
      ? undefined
      : isChannelArchived(channel) || (dm !== undefined && dm.readOnlyReason !== null)
        ? false
        : canCreateConversation(role, policy, isManager) ||
          (members === undefined && policy.create === "managers" ? undefined : false);
  return {
    canCreate,
    canManage: (conversation: Pick<Conversation, "createdBy">) =>
      canManageConversation(role, conversation, meId, isManager),
  };
}

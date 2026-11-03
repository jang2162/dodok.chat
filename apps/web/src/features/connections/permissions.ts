import { roleAtLeast, type TeamRole } from "@dodok/shared";
import { useCachedMe, useRole } from "@/api/queries";

/**
 * 연결을 관리할 수 있는가(연결 탭 통합 스펙 5.2) — 그 연결의 주인(member 이상)이거나 admin 이상. 서버 정책(authorizeConnectionManage)과
 * 같은 표다. 화면의 쓰기 단추와 주소·토큰이 든 섹션이 이것으로 갈린다 — 정본은 서버고 이것은 숨김 편의다
 */
export function canManageConnection(
  role: TeamRole | undefined,
  meId: string | null,
  ownerId: string | null,
): boolean {
  if (!roleAtLeast(role, "member")) return false;
  if (roleAtLeast(role, "admin")) return true;
  return meId !== null && ownerId !== null && ownerId === meId;
}

/** 두 연결 사이로 옮기기(Gateway 옮기기·프로젝트 옮기기) — admin 이상, 또는 두 쪽이 다 자기 것 */
export function canMoveBetween(
  role: TeamRole | undefined,
  meId: string | null,
  fromOwner: string | null,
  toOwner: string | null,
): boolean {
  if (!roleAtLeast(role, "member")) return false;
  if (roleAtLeast(role, "admin")) return true;
  return meId !== null && fromOwner === meId && toOwner === meId;
}

/** 지금 사람의 역할과 id — 위 두 판정에 넘긴다 */
export function useViewer(): { role: TeamRole | undefined; meId: string | null } {
  return { role: useRole(), meId: useCachedMe()?.user.id ?? null };
}

/** 그 주인의 연결을 지금 사람이 관리할 수 있는가 */
export function useCanManageConnection(ownerId: string | null): boolean {
  const { role, meId } = useViewer();
  return canManageConnection(role, meId, ownerId);
}

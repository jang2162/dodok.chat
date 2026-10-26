import { type Approval, roleAtLeast } from "@dodok/shared";
import type { MeResponse } from "@/api/queries";

/**
 * 이 승인을 내가 결정할 수 있는가 — 카드의 버튼과 탭 안 알림(`realtime/handlers` 의 `approval.requested`)이 같은 규칙을 본다.
 * 확인 카드(`dodok_control`)는 그 일을 시킨 사람 본인만이고 역할을 보지 않는다(제어 MCP 스펙 「확인 카드」 장 — 서버가 남의
 * 결정을 FORBIDDEN 으로 거절한다). 다른 종류는 admin 이상(팀 스펙 「역할과 권한」).
 * 승인 이벤트는 워크스페이스 방으로 오므로, 이 규칙을 건너뛰고 역할만 보면 남의 확인 카드 알림이 admin 모두에게 뜬다.
 * DM 의 승인은 종류와 역할에 상관없이 DM 주인만 결정한다(에이전트 DM 계획 판정 PD7 — member 주인 포함). `dmOwnerId` 는 승인의 채널이
 * DM 일 때 그 주인, 아니면 넘기지 않는다
 */
export function canDecideApproval(
  approval: Pick<Approval, "kind" | "requestedBy">,
  me: (Pick<MeResponse, "role"> & { user?: Pick<MeResponse["user"], "id"> }) | undefined,
  dmOwnerId?: string | null,
): boolean {
  if (dmOwnerId != null) return me?.user?.id === dmOwnerId;
  if (approval.kind === "dodok_control")
    return approval.requestedBy !== undefined && approval.requestedBy === me?.user?.id;
  return roleAtLeast(me?.role, "admin");
}

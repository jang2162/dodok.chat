import { type Approval, type Channel, roleAtLeast } from "@dodok/shared";
import type { MeResponse } from "@/api/queries";

/**
 * 이 승인을 내가 결정할 수 있는가 — 카드의 버튼과 탭 안 알림(`realtime/handlers` 의 `approval.requested`)이 같은 규칙을 본다.
 * `channel` 은 승인의 채널(캐시에 있으면) — 그 종류로 먼저 가른다:
 * - 에이전트 DM(`dm`)은 종류·역할과 상관없이 DM 주인만(에이전트 DM 계획 판정 PD7 — member 주인 포함).
 * - 사람 DM·그룹 DM(`direct`)은 종류·역할과 상관없이 그 일을 시킨 사람(`requestedBy`)만, 비었으면 아무도(사람 간 DM 계획 판정 PH7 —
 *   참여하지 않은 admin 이 결정자가 되지 않게. 서버도 FORBIDDEN 으로 거절한다).
 * - 모르는 종류는 아무도 — 일반 채널 규칙으로 새지 않는다(같은 계획 Global Constraints 「기본이 닫힘」).
 * 일반 채널(또는 `kind` 가 없는 옛 사본·캐시에 없는 채널)에서 확인 카드(`dodok_control`)는 시킨 사람 본인만이고 역할을 보지 않는다(제어
 * MCP 스펙 「확인 카드」 장), 다른 종류는 admin 이상(팀 스펙 「역할과 권한」). 승인 이벤트는 워크스페이스 방으로 오므로, 이 규칙을
 * 건너뛰고 역할만 보면 남의 확인 카드 알림이 admin 모두에게 뜬다
 */
export function canDecideApproval(
  approval: Pick<Approval, "kind" | "requestedBy">,
  me: (Pick<MeResponse, "role"> & { user?: Pick<MeResponse["user"], "id"> }) | undefined,
  channel?: Partial<Pick<Channel, "kind">> & Pick<Channel, "dmOwnerId">,
): boolean {
  const kind = channel?.kind ?? "channel";
  const requester = () => approval.requestedBy !== undefined && approval.requestedBy === me?.user?.id;
  if (kind === "dm") return channel?.dmOwnerId != null && me?.user?.id === channel.dmOwnerId;
  if (kind === "direct") return requester();
  if (kind !== "channel") return false;
  if (approval.kind === "dodok_control") return requester();
  return roleAtLeast(me?.role, "admin");
}

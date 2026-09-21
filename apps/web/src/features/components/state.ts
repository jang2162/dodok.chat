import type { Message } from "@dodok/shared";

/** 아이템 하나(버튼·셀렉트·모달 트리거)를 지금 누를 수 있는가, 못 누르면 왜인가(스펙 5.5) */
export type ItemState = {
  disabled: boolean;
  reason?: "disconnected" | "expired" | "consumed" | "forbidden" | "busy";
};

export type StateInput = {
  message: Message;
  /** wire 가 connected 인가 */
  connected: boolean;
  hasSocket: boolean;
  meId: string | undefined;
  /** componentState.expiresAt 이 지났는가 — 시각은 부르는 쪽이 useExpired 로 잰다 */
  expired: boolean;
  /** 응답을 기다리는 아이템 id 들 */
  busy: ReadonlySet<string>;
  /** 그 아이템(또는 모달)의 allowedUsers — 없거나 비어 있으면 누구나 */
  allowedUsers: readonly string[] | undefined;
  itemId: string;
};

/** 비활성 사유를 사람에게 말하는 문구 — title·aria-describedby 로 싣는다(스펙 5.7) */
export const DISABLED_REASON_TEXT: Record<NonNullable<ItemState["reason"]>, string> = {
  disconnected: "연결이 끊겨 지금은 보낼 수 없습니다",
  expired: "만료되었습니다",
  consumed: "이미 처리되었습니다",
  forbidden: "이 항목을 쓸 권한이 없습니다",
  busy: "보내는 중입니다",
};

/**
 * 버튼·셀렉트·모달이 함께 쓰는 비활성 규칙 한 곳(스펙 5.5, 순수).
 * 사유가 겹치면 먼저 나온 것을 돌려준다: 연결 → 만료 → 소비 → 권한 → 전송 중.
 * components.id 가 없으면 disconnected — 서버가 아직 id 를 안 준 카드는 보낼 곳이 없다
 */
export function itemState(input: StateInput): ItemState {
  const { message, itemId } = input;
  const c = message.components;
  if (!input.hasSocket || !input.connected || !c?.id) return { disabled: true, reason: "disconnected" };
  if (input.expired) return { disabled: true, reason: "expired" };
  if (!c.reusable && message.componentState?.consumed.includes(itemId)) {
    return { disabled: true, reason: "consumed" };
  }
  // 서버 interact 와 같다 — 빈 배열은 제한 없음
  const allowed = input.allowedUsers;
  if (
    allowed !== undefined &&
    allowed.length > 0 &&
    (input.meId === undefined || !allowed.includes(input.meId))
  ) {
    return { disabled: true, reason: "forbidden" };
  }
  if (input.busy.has(itemId)) return { disabled: true, reason: "busy" };
  return { disabled: false };
}

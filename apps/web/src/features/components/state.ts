import type { DmReadOnlyReason, Message } from "@dodok/shared";
import { CHANNEL_ARCHIVED_TEXT, CONVERSATION_CLOSED_TEXT } from "@/api/formErrors";
import { DM_READ_ONLY_TEXT } from "@/features/dms/queries";

/**
 * 아이템 하나(버튼·셀렉트·모달 트리거)를 지금 누를 수 있는가, 못 누르면 왜인가(스펙 5.5).
 * `dm_read_only` 면 `dmReason` 이 어느 읽기 전용인지 말한다 — 문구가 사유마다 달라서다(`reasonText`)
 */
export type ItemState = {
  disabled: boolean;
  reason?:
    | "archived"
    | "closed"
    | "dm_read_only"
    | "disconnected"
    | "expired"
    | "consumed"
    | "forbidden"
    | "busy";
  dmReason?: DmReadOnlyReason;
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
  /** 카드가 있는 채널이 보관됐는가 — 서버가 보관 해제 전에는 어떤 상호작용도 받지 않는다(409 CHANNEL_ARCHIVED) */
  archived: boolean;
  /** 카드가 있는 세션이 닫혔는가 — 다시 열기 전에는 서버가 받지 않는다(409 CONVERSATION_CLOSED, 채널 세션 스펙 「세션 만들기·닫기」 절) */
  closed: boolean;
  /** 카드가 있는 DM 이 읽기 전용이면 그 사유(`useDmView`) — 채널이거나 쓸 수 있는 DM 이면 null. 서버는 409 DM_READ_ONLY 로 거절한다 */
  dmReadOnly: DmReadOnlyReason | null;
};

/**
 * 비활성 사유를 사람에게 말하는 문구 — 보이는 글로 두고 컨트롤이 aria-describedby 로 가리킨다(스펙 5.7, `DisabledHint`).
 * 읽기 전용 DM 은 사유마다 문구가 달라 `reasonText` 가 `dmReason` 으로 고른다 — 여기 값은 사유를 모를 때의 것(가장 넓은 사유,
 * `dmReadOnlyReasonOf` 와 같은 판단)이다. 화면은 이 표가 아니라 `reasonText` 를 쓴다
 */
export const DISABLED_REASON_TEXT: Record<NonNullable<ItemState["reason"]>, string> = {
  archived: CHANNEL_ARCHIVED_TEXT,
  closed: CONVERSATION_CLOSED_TEXT,
  dm_read_only: DM_READ_ONLY_TEXT.dm_not_allowed,
  disconnected: "연결이 끊겨 지금은 보낼 수 없습니다",
  expired: "만료되었습니다",
  consumed: "이미 처리되었습니다",
  forbidden: "이 항목을 쓸 권한이 없습니다",
  busy: "보내는 중입니다",
};

/**
 * 잠긴 아이템의 사유 문구(잠기지 않았으면 undefined). 읽기 전용 DM 은 작성기 자리 사유 줄과 같은 글이다(`DM_READ_ONLY_TEXT`)
 */
export function reasonText(state: ItemState): string | undefined {
  if (!state.reason) return undefined;
  if (state.reason === "dm_read_only" && state.dmReason) return DM_READ_ONLY_TEXT[state.dmReason];
  return DISABLED_REASON_TEXT[state.reason];
}

/**
 * 버튼·셀렉트·모달이 함께 쓰는 비활성 규칙 한 곳(스펙 5.5, 순수).
 * 사유가 겹치면 먼저 나온 것을 돌려준다: 보관 → 닫힘 → 읽기 전용 DM → 연결 → 만료 → 소비 → 권한 → 전송 중. 보관·닫힘·읽기 전용 DM 이
 * 앞인 까닭은 다른 사유가 풀려도 보관 해제·다시 열기·DM 이 다시 열리기 전에는 누를 수 없어서다(서버의 쓰기 막기 순서도 보관 → 닫힘).
 * components.id 가 없으면 disconnected — 서버가 아직 id 를 안 준 카드는 보낼 곳이 없다
 */
export function itemState(input: StateInput): ItemState {
  const { message, itemId } = input;
  const c = message.components;
  if (input.archived) return { disabled: true, reason: "archived" };
  if (input.closed) return { disabled: true, reason: "closed" };
  if (input.dmReadOnly) return { disabled: true, reason: "dm_read_only", dmReason: input.dmReadOnly };
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

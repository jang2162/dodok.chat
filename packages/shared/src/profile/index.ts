import { z } from "zod";
import { Id, IsoDateTime } from "../common";

// 프로필·상태 계약(설계 `2026-11-02-profiles-presence-design.md` 2장·3장).
// 수동 모드와 그 만료는 본인에게만 간다(`MyStatus`) — 남에게는 유효 상태(`PresenceEntry`)만 간다. 모드를 사람 목록에
// 실으면 「오프라인으로 보이기」인 사람이 드러난다.

/** 사람의 상태 — auto 는 접속으로 정해지고, 나머지는 손으로 고른 값이다 */
export const StatusMode = z.enum(["auto", "away", "busy", "dnd", "invisible"]);
export type StatusMode = z.infer<typeof StatusMode>;

/** 상태 메시지 — 이모지 하나(문자열) + 글 + 지워질 시각(null 이면 직접 지울 때까지) */
export const StatusMessage = z.object({
  emoji: z.string().min(1).max(16).nullable(),
  text: z.string().trim().min(1).max(100),
  until: IsoDateTime.nullable(),
});
export type StatusMessage = z.infer<typeof StatusMessage>;

/** 본인의 상태 — `/auth/me` 와 user 룸 `me.status` 로만 간다 */
export const MyStatus = z.object({
  mode: StatusMode,
  modeUntil: IsoDateTime.nullable(),
  message: StatusMessage.nullable(),
  dndAllowApprovals: z.boolean(),
});
export type MyStatus = z.infer<typeof MyStatus>;

/** `PUT /api/v1/me/status` 본문 — 보낸 칸만 바꾼다. auto 에는 만료가 없다 */
export const UpdateMyStatusBody = z
  .object({
    mode: StatusMode,
    modeUntil: IsoDateTime.nullable(),
    message: StatusMessage.nullable(),
    dndAllowApprovals: z.boolean(),
  })
  .partial()
  .refine((b) => !(b.mode === "auto" && b.modeUntil != null), {
    message: "자동 상태에는 만료를 걸 수 없습니다",
    path: ["modeUntil"],
  });
export type UpdateMyStatusBody = z.infer<typeof UpdateMyStatusBody>;

/** 남에게 보이는 사람의 점 */
export const UserPresenceState = z.enum(["online", "away", "busy", "dnd", "offline"]);
export type UserPresenceState = z.infer<typeof UserPresenceState>;
/** 에이전트의 점 — 자동만 있다 */
export const AgentPresenceState = z.enum(["available", "working", "disconnected", "off"]);
export type AgentPresenceState = z.infer<typeof AgentPresenceState>;

/**
 * 접속 점 한 줄(wire `presence.snapshot`·`presence.changed`). state null 은 점 없음(비활성 멤버·보관한 에이전트).
 * until 은 수동 away·busy·dnd 의 만료, dnd 는 방해 금지 표지 — 오프라인이어도 싣는다. invisible 은 둘 다 싣지 않는다.
 * 에이전트 줄은 어느 채널·대화·런인지 싣지 않는다(남의 DM 런이 드러나지 않게)
 */
export const PresenceEntry = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    id: Id,
    state: UserPresenceState.nullable(),
    until: IsoDateTime.optional(),
    dnd: z.object({ until: IsoDateTime.nullable() }).optional(),
  }),
  z.object({ kind: z.literal("agent"), id: Id, state: AgentPresenceState.nullable() }),
]);
export type PresenceEntry = z.infer<typeof PresenceEntry>;

/** 아바타 주소 — 올린 사진(같은 오리진 상대 경로, 내용 주소) 또는 바깥 https URL */
export const AvatarUrl = z
  .string()
  .regex(/^(https:\/\/\S+|\/api\/v1\/avatars\/[0-9a-f]{64}\.(png|jpeg|webp))$/);
export type AvatarUrl = z.infer<typeof AvatarUrl>;

/** 아바타 업로드 조건 — 서버가 확인하고, 브라우저는 TARGET 크기로 만들어 올린다 */
export const AVATAR_MAX_BYTES = 262_144;
export const AVATAR_MIN_PX = 64;
export const AVATAR_MAX_PX = 512;
export const AVATAR_TARGET_PX = 256;

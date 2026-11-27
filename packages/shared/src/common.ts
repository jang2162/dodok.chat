import { z } from "zod";

/** UUIDv7 (uuid v14 `v7()`), 모든 엔티티 PK */
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

/** wire/bridge의 시간은 ISO 8601 문자열(오프셋 또는 Z). DB는 integer ms. */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** 시간대(IANA 이름) — 여기서는 모양만 본다. 있는 이름인지는 쓰는 쪽의 Intl 이 가른다(예약을 세는 서버, 헤더 시각) */
export const TimeZoneName = z.string().min(1).max(64);

export const ErrorCode = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION",
  "CONFLICT",
  "RATE_LIMITED",
  "RELAY_LIMIT",
  "RUN_LIMIT",
  "ADAPTER_UNAVAILABLE",
  "PROTOCOL_MISMATCH",
  "EXPIRED",
  "CONSUMED",
  "TIMEOUT",
  "INSUFFICIENT_STORAGE",
  "PROVIDER_AUTH", // 러너의 Claude 로그인이 안 됐거나 풀렸다(러너 스펙 8장)
  "AGENT_ARCHIVED", // 보관(삭제)한 에이전트 — 등록 대신 되살리기, 다시 실행은 거절(details.agentId)
  "MEMBER_DEACTIVATED", // 비활성 멤버 — 로그인은 403, 같은 이메일의 가입은 409(details.userId)
  "CHANNEL_ARCHIVED", // 보관한 채널 — 읽기만 된다. 보내기·상호작용·설정·멤버·첨부 올리기는 거절
  "PUSH_UNAVAILABLE", // 그 플랫폼의 푸시 통로가 꺼져 있다 — 기기 등록은 거절
  "CONVERSATION_CLOSED", // 닫힌 세션 — 읽기만 된다. 보내기·카드·리액션·첨부 묶기는 거절(다시 열면 된다)
  "DM_READ_ONLY", // 읽기 전용 DM — 에이전트 보관·꺼짐·DM 허용 철회(details.reason 은 DmReadOnlyReason). 되돌리면 이어 쓴다
  "RUNNER_CEILING", // 러너 로컬 설정(천장)이 이 에이전트 정의를 허용하지 않는다 — message 는 항목 이름 하나(러너 일반화 스펙 3장)
  "OUT_OF_SCOPE", // 제어 도구 — 시킨 사람은 읽는 채널(그의 다른 DM)이지만 채널 안 에이전트 런의 범위 밖이다. 없는 것·남의 것은 NOT_FOUND
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiError>;

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };
/** Socket.IO ack 콜백 시그니처 */
export type Ack<T> = (res: Result<T>) => void;

/** 핸드셰이크 협상용. wire와 bridge 각각 독립적으로 올린다. */
export const WIRE_PROTOCOL = 1 as const;
export const BRIDGE_PROTOCOL = 1 as const;

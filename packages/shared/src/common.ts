import { z } from "zod";

/** UUIDv7 (uuid v14 `v7()`), 모든 엔티티 PK */
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

/** wire/bridge의 시간은 ISO 8601 문자열(오프셋 또는 Z). DB는 integer ms. */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

export const ErrorCode = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION",
  "CONFLICT",
  "RATE_LIMITED",
  "RELAY_LIMIT",
  "ADAPTER_UNAVAILABLE",
  "PROTOCOL_MISMATCH",
  "EXPIRED",
  "CONSUMED",
  "TIMEOUT",
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

import type { ApiError, ErrorCode } from "@dodok/shared";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
    this.name = "HttpError";
  }
}

const STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  RELAY_LIMIT: 409,
  ADAPTER_UNAVAILABLE: 503,
  PROTOCOL_MISMATCH: 400,
  EXPIRED: 410,
  CONSUMED: 409,
  TIMEOUT: 504,
  INTERNAL: 500,
};

export function apiError(code: ErrorCode, message: string, details?: Record<string, unknown>): HttpError {
  return new HttpError(STATUS[code], { code, message, ...(details ? { details } : {}) });
}

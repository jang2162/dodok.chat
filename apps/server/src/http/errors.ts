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
  RUN_LIMIT: 429,
  ADAPTER_UNAVAILABLE: 503,
  PROTOCOL_MISMATCH: 400,
  EXPIRED: 410,
  CONSUMED: 409,
  TIMEOUT: 504,
  INSUFFICIENT_STORAGE: 507,
  INTERNAL: 500,
};

export function apiError(code: ErrorCode, message: string, details?: Record<string, unknown>): HttpError {
  return new HttpError(STATUS[code], { code, message, ...(details ? { details } : {}) });
}

/** Fastify 가 낸 4xx(와 507) 상태를 계약 ErrorCode 로. 표에 없는 상태는 VALIDATION. */
export function httpStatusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 408:
      return "TIMEOUT";
    case 409:
      return "CONFLICT";
    case 410:
      return "EXPIRED";
    case 429:
      return "RATE_LIMITED";
    case 507:
      return "INSUFFICIENT_STORAGE";
    default:
      return "VALIDATION";
  }
}

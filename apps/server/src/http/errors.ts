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
  PROVIDER_AUTH: 502, // 러너 쪽 Claude 로그인 — 서버 앞의 제공자가 거절했다
  AGENT_ARCHIVED: 409, // 보관한 에이전트 — 같은 자리를 이미 잡고 있다(CONFLICT 와 같은 상태)
  MEMBER_DEACTIVATED: 409, // 비활성 멤버의 이메일로 가입 — 로그인(auth/routes.ts signInMember)은 403 을 직접 준다
  CHANNEL_ARCHIVED: 409, // 보관한 채널에 쓰기 — 지금 상태와 맞지 않는 요청(CONFLICT 와 같은 상태)
  CONVERSATION_CLOSED: 409, // 닫힌 세션에 쓰기 — 다시 열면 되는 일(CHANNEL_ARCHIVED 와 같은 상태)
  PUSH_UNAVAILABLE: 503, // 그 플랫폼 푸시 통로가 꺼져 있다 — 서버 설정이 바뀌면 되는 일(ADAPTER_UNAVAILABLE 과 같은 상태)
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

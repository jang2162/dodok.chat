import { ApiError, type ErrorCode } from "@dodok/shared";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/**
 * 응답을 받지 못한 실패(오프라인·서버 꺼짐·받다 끊김) — 원래 오류는 `cause`.
 * `ApiRequestError.code` 는 서버 계약(ErrorCode)이라 여기에 섞지 않고 따로 둔다
 */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("서버에 연결할 수 없습니다", { cause });
    this.name = "NetworkError";
  }
}

/** 같은 출처 REST(`/api/v1` + path). 인증은 httpOnly 쿠키가 자동으로 붙는다 — 토큰을 다루지 않는다 */
export async function api<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  // 요청을 보내고 본문을 다 받기까지만 네트워크 실패로 본다 — 직렬화 같은 코드 오류는 그대로 올라간다
  let res: Response;
  let text: string;
  try {
    res = await fetch(`/api/v1${path}`, init);
    text = await res.text();
  } catch (e) {
    throw new NetworkError(e);
  }
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const parsed = ApiError.safeParse(json);
    if (parsed.success) throw new ApiRequestError(res.status, parsed.data.code, parsed.data.message);
    throw new ApiRequestError(res.status, "INTERNAL", res.statusText || `HTTP ${res.status}`);
  }
  return json as T;
}

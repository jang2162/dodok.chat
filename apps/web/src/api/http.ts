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

/** 같은 출처 REST(`/api/v1` + path). 인증은 httpOnly 쿠키가 자동으로 붙는다 — 토큰을 다루지 않는다 */
export async function api<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
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

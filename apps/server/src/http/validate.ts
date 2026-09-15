import type { z } from "zod";
import { apiError, type HttpError } from "./errors";

/** 요청 본문을 Zod 로 파싱한다. 실패는 400 VALIDATION. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  return parseInput(schema, body, "body");
}

/** 쿼리스트링(값은 문자열)을 파싱한다 — 숫자는 스키마에서 z.coerce 로. */
export function parseQuery<S extends z.ZodType>(schema: S, query: unknown): z.output<S> {
  return parseInput(schema, query, "query");
}

export function parseParams<S extends z.ZodType>(schema: S, params: unknown): z.output<S> {
  return parseInput(schema, params, "params");
}

/**
 * DB 에서 읽은 행을 도메인 계약으로 확인한다. 어기면 서버 버그라 500 INTERNAL —
 * 원인(ZodError)은 cause 로 붙여 에러 핸들러가 로그에 남긴다(응답에는 싣지 않는다).
 * 행 매핑의 `null ?? undefined` 로 생긴 값 없는 키는 떼고 파싱한다(도메인 객체에 빈 키를 남기지 않는다).
 */
export function parseStored<S extends z.ZodType>(
  schema: S,
  value: Record<string, unknown>,
  what: string,
): z.output<S> {
  const present = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
  const result = schema.safeParse(present);
  if (result.success) return result.data;
  const error: HttpError = apiError("INTERNAL", `stored ${what} violates contract`);
  error.cause = result.error;
  throw error;
}

function parseInput<S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
  const summary = issues
    .slice(0, 5)
    .map((i) => `${i.path || "(root)"}: ${i.message}`)
    .join("; ");
  throw apiError("VALIDATION", `${where} — ${summary}`, { issues });
}

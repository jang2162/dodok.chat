import { ApiRequestError } from "./http";

/**
 * 폼 안에 그리는 서버 오류(스펙 8장) — `VALIDATION`·`CONFLICT` 는 전역 토스트에서 저절로 빠지므로 폼이 그린다.
 * 그 밖(네트워크·5xx·404)은 undefined — 전역 토스트가 알린다
 */
export function formError(e: unknown): string | undefined {
  return e instanceof ApiRequestError && (e.code === "VALIDATION" || e.code === "CONFLICT")
    ? e.message
    : undefined;
}

/**
 * 서버 VALIDATION message 가 가리킨 칸. 서버는 `body — <경로>: <까닭>` 꼴로 보낸다(`http/validate.ts`).
 * 못 찾으면 undefined — 어느 칸에도 표시하지 않고 문구만 폼에 그린다
 */
export function validationField<F extends string>(
  message: string | undefined,
  fields: readonly F[],
): F | undefined {
  return message === undefined
    ? undefined
    : fields.find((field) => new RegExp(`(^|[^a-zA-Z])${field}:`).test(message));
}

/**
 * 서버가 `details.field` 로 가리킨 칸(가입 409 `handle`·`email`, 비밀번호 400 `current`). 목록에 없는 값이면 undefined —
 * 폼은 그때 문구를 폼 아래에 그린다
 */
export function detailField<F extends string>(e: unknown, fields: readonly F[]): F | undefined {
  const field = e instanceof ApiRequestError ? e.details?.field : undefined;
  return fields.find((f) => f === field);
}

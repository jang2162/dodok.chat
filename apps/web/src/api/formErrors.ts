import { ApiRequestError } from "./http";

/** `AGENT_ARCHIVED`(보관한 에이전트를 등록·채널에 넣기·다시 실행)의 화면 문구 — 스펙 「오류」 절 */
export const AGENT_ARCHIVED_TEXT = "삭제된 에이전트입니다";
/** `CHANNEL_ARCHIVED`(보관한 채널에 보내기·상호작용·설정·첨부)의 화면 문구 — 채널 보관 스펙 「웹」 절의 카드 비활성 사유와 같은 말 */
export const CHANNEL_ARCHIVED_TEXT = "보관된 채널입니다";
/** `CONVERSATION_CLOSED`(닫힌 세션에 보내기)의 화면 문구 — 채널 세션 계획 Global Constraints 의 문구 그대로 */
export const CONVERSATION_CLOSED_TEXT = "닫힌 세션입니다";

/** 폼이 그리는 409·400 — 전역 뮤테이션 토스트(app/queryClient)도 이 판정으로 뺀다 */
export const isFormErrorCode = (code: string): boolean =>
  code === "VALIDATION" || code === "CONFLICT" || code === "AGENT_ARCHIVED";

/**
 * 폼 안에 그리는 서버 오류(스펙 8장) — `VALIDATION`·`CONFLICT`·`AGENT_ARCHIVED` 는 전역 토스트에서 저절로 빠지므로 폼이 그린다.
 * 그 밖(네트워크·5xx·404)은 undefined — 전역 토스트가 알린다
 */
export function formError(e: unknown): string | undefined {
  if (!(e instanceof ApiRequestError) || !isFormErrorCode(e.code)) return undefined;
  return e.code === "AGENT_ARCHIVED" ? AGENT_ARCHIVED_TEXT : e.message;
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

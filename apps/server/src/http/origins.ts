/**
 * 쿠키 인증·CORS·Better Auth 가 받아들이는 출처. 지금은 APP_ORIGIN 하나다.
 * 출처를 더하는 날 세 자리가 한꺼번에 따라오도록 비교는 여기서만 한다.
 * 커스텀 스킴(capacitor://·file: 등)의 `.origin` 은 "null" 이라 목록에 넣지 않는다 —
 * 넣으면 샌드박스 iframe·file 페이지가 보내는 `Origin: null` 이 쿠키를 읽는다.
 */
export function allowedOrigins(config: { APP_ORIGIN: string }): string[] {
  return [new URL(config.APP_ORIGIN).origin].filter((origin) => origin !== "null");
}

export function isAllowedOrigin(config: { APP_ORIGIN: string }, origin: string | undefined): boolean {
  return origin !== undefined && allowedOrigins(config).includes(origin);
}

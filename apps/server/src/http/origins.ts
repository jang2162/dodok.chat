/**
 * 쿠키 인증·CORS·Better Auth 가 받아들이는 출처. 지금은 APP_ORIGIN 하나다.
 * 출처를 더하는 날 세 자리가 한꺼번에 따라오도록 비교는 여기서만 한다.
 */
export function allowedOrigins(config: { APP_ORIGIN: string }): string[] {
  return [new URL(config.APP_ORIGIN).origin];
}

export function isAllowedOrigin(config: { APP_ORIGIN: string }, origin: string | undefined): boolean {
  return origin !== undefined && allowedOrigins(config).includes(origin);
}

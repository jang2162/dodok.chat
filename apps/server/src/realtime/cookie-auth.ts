import { SESSION_COOKIE } from "../auth";
import { isAllowedOrigin } from "../http/origins";

type HandshakeHeaders = { origin?: string | string[]; cookie?: string | string[] };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * 같은 출처(Origin 이 allowedOrigins) 핸드셰이크에서만 세션 쿠키 값을 꺼낸다 — 다른 출처 페이지가 사용자의 쿠키로
 * 소켓을 여는 것(Cross-Site WebSocket Hijacking)을 막는다. 브라우저는 토큰을 보관하지 않고 이 경로로만 붙는다.
 */
export function cookieSessionToken(headers: HandshakeHeaders, appOrigin: string): string | undefined {
  if (!isAllowedOrigin({ APP_ORIGIN: appOrigin }, first(headers.origin))) return undefined;
  const raw = Array.isArray(headers.cookie) ? headers.cookie.join("; ") : headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    // setCookie 가 값을 URL 인코딩한다. 첫 dodok.session 만 본다
    try {
      return decodeURIComponent(part.slice(eq + 1).trim()) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

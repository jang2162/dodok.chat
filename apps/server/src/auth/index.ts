import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins/bearer";
import * as authSchema from "../db/auth-schema";
import type { Db } from "../db/client";
import { allowedOrigins } from "../http/origins";
import type { Logger } from "../logger";

export const OWNER_EMAIL = "owner@dodok.local";
export const SESSION_COOKIE = "dodok.session";
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30;

/**
 * Better Auth 가 클라이언트 IP 를 읽는 유일한 헤더(advanced.ipAddress.ipAddressHeaders). 기본값 X-Forwarded-For 를 그대로 두면
 * TRUST_PROXY 판정을 거치지 않고 클라이언트가 꾸민 값이 세션 ip_address 와 Better Auth 자체 레이트리밋 키가 된다. 서버가 Better Auth
 * 로 넘기는 자리(auth/routes.ts betterAuthHeaders)는 들어온 같은 이름을 버리고 request.ip 만 싣는다
 */
export const CLIENT_IP_HEADER = "x-dodok-client-ip";

export function createAuth(
  db: Db,
  config: { BETTER_AUTH_SECRET: string; APP_ORIGIN: string },
  logger?: Logger,
) {
  return betterAuth({
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.APP_ORIGIN,
    basePath: "/api/auth",
    trustedOrigins: allowedOrigins(config),
    // auth-schema 를 명시한다 — db 의 schema 에는 우리 users 도 있어 모델 이름 추론에 맡기면 안 된다
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    // 가입은 막는다. owner 는 bootstrapOwner 가 내부 어댑터로 만든다.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 16,
      maxPasswordLength: 256,
    },
    // 비밀번호 사인인은 레이트리밋이 걸린 /api/v1/auth/local 로만 — 서버 API(auth.api.signInEmail)는 영향 없음.
    // 비밀번호·프로필 변경 경로도 닫는다: 「로컬 토큰 = owner 비밀번호」 불변식과 users 행 동기화를 지키기 위해(리뷰 sc-t3 지적 2)
    // 세션 폐기·로그아웃도 닫는다 — 세션 행은 그 세션의 wire 소켓을 함께 끊는 우리 경로(/api/v1/auth/logout·me/password·재설정·비활성화)만 지운다
    // HTTP 는 auth/routes.ts BETTER_AUTH_HTTP_PATHS 허용 목록이 먼저 닫는다 — 이 목록은 그 밑의 겹 방어다
    disabledPaths: [
      "/sign-in/email",
      "/change-password",
      "/set-password",
      "/update-user",
      "/change-email",
      "/delete-user",
      "/sign-out",
      "/revoke-session",
      "/revoke-sessions",
      "/revoke-other-sessions",
    ],
    session: { expiresIn: SESSION_MAX_AGE_S, updateAge: 60 * 60 * 24 },
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    plugins: [bearer()],
    telemetry: { enabled: false },
    ...(logger
      ? {
          logger: {
            log: (level: "debug" | "info" | "warn" | "error", message: string, ...args: unknown[]) => {
              const err = args.find((a) => a instanceof Error);
              logger[level](err ? { err } : {}, `better-auth: ${message}`);
            },
          },
        }
      : {}),
  });
}
export type Auth = ReturnType<typeof createAuth>;

/** 세션 토큰(= /auth/local 응답 sessionToken)을 검증한다. Better Auth 자체 쿠키는 보지 않는다. */
/** 헤더 값이 될 수 있는 토큰만(가시 ASCII). wire 의 auth.token 은 임의 유니코드가 올 수 있다 — Headers 가 던지지 않게 먼저 거른다 */
const TOKEN_RE = /^[\x21-\x7e]+$/;

/** sessionId 는 Better Auth session 행의 id — 토큰 원문 대신 세션을 가리킬 때 쓴다(wire 소켓의 세션 단위 끊기) */
export async function verifySessionToken(
  auth: Auth,
  token: string,
): Promise<{ userId: string; sessionId: string } | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  try {
    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    return session ? { userId: session.user.id, sessionId: session.session.id } : null;
  } catch {
    // 무효 토큰은 예외가 아니라 null 이다(리뷰 sc-t3 지적 1)
    return null;
  }
}

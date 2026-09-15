import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins/bearer";
import * as authSchema from "../db/auth-schema";
import type { Db } from "../db/client";
import type { Logger } from "../logger";

export const OWNER_EMAIL = "owner@dodok.local";
export const SESSION_COOKIE = "dodok.session";
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30;

export function createAuth(
  db: Db,
  config: { BETTER_AUTH_SECRET: string; APP_ORIGIN: string },
  logger?: Logger,
) {
  return betterAuth({
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.APP_ORIGIN,
    basePath: "/api/auth",
    trustedOrigins: [config.APP_ORIGIN],
    // auth-schema 를 명시한다 — db 의 schema 에는 우리 users 도 있어 모델 이름 추론에 맡기면 안 된다
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    // 가입은 막는다. owner 는 bootstrapOwner 가 내부 어댑터로 만든다.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 16,
      maxPasswordLength: 256,
    },
    // 비밀번호 사인인은 레이트리밋이 걸린 /api/v1/auth/local 로만 — 서버 API(auth.api.signInEmail)는 영향 없음
    disabledPaths: ["/sign-in/email"],
    session: { expiresIn: SESSION_MAX_AGE_S, updateAge: 60 * 60 * 24 },
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
export async function verifySessionToken(auth: Auth, token: string): Promise<{ userId: string } | null> {
  if (!token) return null;
  const session = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${token}` }),
  });
  return session ? { userId: session.user.id } : null;
}

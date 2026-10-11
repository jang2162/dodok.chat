/** FCM 통로 — HTTP v1. 서비스 계정 JWT(RS256)로 OAuth 토큰을 받아(캐시) 기기 토큰으로 보낸다(네이티브 푸시 스펙 「통로」 장) */
import { createSign } from "node:crypto";
import { z } from "zod";
import type { Logger } from "../../../logger";
import type { FcmCredentials } from "../fcm-credentials";
import { PUSH_SEND_TIMEOUT_MS, PUSH_TTL_SECONDS, pushTopic } from "../service";
import type { PushTransport, TransportResult } from "./types";

export const FCM_TOKEN_TTL_MS = 55 * 60_000;
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_HOST = "https://fcm.googleapis.com";
/** Google 이 준 expires_in 이 캐시 상한보다 짧으면 그만큼 일찍 버린다 — 만료 직전 토큰으로 보내지 않게 */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
});
const ErrorBody = z.object({
  error: z
    .object({
      status: z.string().optional(),
      details: z.array(z.object({ errorCode: z.string().optional() }).loose()).optional(),
    })
    .optional(),
});

/** 토큰 교환이 결과를 정한 경우 — 네트워크·5xx 는 retry, 키를 거부하는 4xx 는 credentials */
class TokenExchangeError extends Error {
  constructor(readonly result: TransportResult) {
    super("fcm token exchange failed");
  }
}

/** 응답 쪽 값을 로그에 싣기 전에 고정 꼴(대문자·소문자 식별자)만 통과시킨다 — 임의 문자열이 로그로 새지 않게 */
function safeReason(v: string | undefined): string {
  return v !== undefined && /^[A-Za-z_]{1,64}$/.test(v) ? v : "unknown";
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export function fcmTransport(opts: {
  credentials: FcmCredentials;
  /** 발송 호스트 오리진 — 통합 테스트가 가짜 서버로 덮는다. 기본 https://fcm.googleapis.com */
  host?: string;
  tokenUri?: string;
  now?: () => number;
  fetch?: typeof fetch;
  logger?: Pick<Logger, "warn">;
}): PushTransport {
  const { credentials } = opts;
  const host = opts.host ?? DEFAULT_HOST;
  const tokenUri = opts.tokenUri ?? credentials.tokenUri;
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? fetch;

  let cached: { token: string; expiresAt: number } | undefined;
  /** 동시에 온 알림이 토큰 교환을 한 번만 내보내게 — 끝나면(성공이든 실패든) 비운다. 실패는 캐시하지 않는다 */
  let exchanging: Promise<string> | undefined;

  const exchange = async (): Promise<string> => {
    const iat = Math.floor(now() / 1000);
    const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
      iss: credentials.clientEmail,
      scope: FCM_SCOPE,
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    })}`;
    const sig = createSign("RSA-SHA256").update(head).sign(credentials.privateKey).toString("base64url");
    let res: Response;
    try {
      res = await doFetch(tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: `${head}.${sig}`,
        }),
        signal: AbortSignal.timeout(PUSH_SEND_TIMEOUT_MS),
      });
    } catch {
      opts.logger?.warn(
        { transport: "fcm", reason: "token_exchange_unreachable" },
        "push fcm token exchange failed",
      );
      throw new TokenExchangeError("retry");
    }
    if (!res.ok) {
      const oauth = await res
        .json()
        .then((j: unknown) => z.object({ error: z.string() }).parse(j).error)
        .catch(() => undefined);
      opts.logger?.warn(
        { transport: "fcm", statusCode: res.status, reason: safeReason(oauth) },
        "push fcm token exchange rejected",
      );
      // 키를 거부하는 응답(폐기된 키의 invalid_grant 등)은 기기 탓이 아니라 자격 증명이다
      throw new TokenExchangeError(
        res.status === 400 || res.status === 401 || res.status === 403 ? "credentials" : "retry",
      );
    }
    const parsed = TokenResponse.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) {
      opts.logger?.warn(
        { transport: "fcm", reason: "token_response_malformed" },
        "push fcm token exchange failed",
      );
      throw new TokenExchangeError("retry");
    }
    const ttl = Math.min(
      FCM_TOKEN_TTL_MS,
      (parsed.data.expires_in ?? Infinity) * 1000 - TOKEN_EXPIRY_MARGIN_MS,
    );
    cached = { token: parsed.data.access_token, expiresAt: now() + ttl };
    return parsed.data.access_token;
  };

  const accessToken = (): Promise<string> => {
    if (cached !== undefined && now() < cached.expiresAt) return Promise.resolve(cached.token);
    exchanging ??= exchange().finally(() => {
      exchanging = undefined;
    });
    return exchanging;
  };

  return {
    kind: "fcm",
    async send(target, n) {
      if (target.kind !== "device" || target.platform !== "android")
        throw new Error("fcm transport can only send to an android device target");
      let token: string;
      try {
        token = await accessToken();
      } catch (err) {
        if (err instanceof TokenExchangeError) return err.result;
        throw err;
      }
      const { payload } = n;
      const res = await doFetch(
        `${host}/v1/projects/${encodeURIComponent(credentials.projectId)}/messages:send`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            message: {
              token: target.token,
              notification: { title: payload.title, body: payload.body },
              data: { url: payload.url, kind: payload.kind, channelId: payload.channelId },
              android: {
                priority: n.urgency === "high" ? "HIGH" : "NORMAL",
                collapse_key: pushTopic(payload.tag),
                ttl: `${PUSH_TTL_SECONDS}s`,
              },
            },
          }),
          signal: AbortSignal.timeout(PUSH_SEND_TIMEOUT_MS),
        },
      );
      if (res.ok) return "ok";
      const body = ErrorBody.safeParse(await res.json().catch(() => undefined));
      const err = body.success ? body.data.error : undefined;
      const unregistered = err?.details?.some((d) => d.errorCode === "UNREGISTERED") === true;
      const result = resultOf(res.status, unregistered);
      if (res.status === 401) cached = undefined; // 토큰이 거부됐다 — 다음 발송이 새로 교환한다
      if (result === "rejected" || result === "credentials")
        opts.logger?.warn(
          { transport: "fcm", statusCode: res.status, reason: safeReason(err?.status) },
          "push fcm response rejected",
        );
      return result;
    },
  };
}

/** 스펙 「통로」 장의 fcm 결과 표. 401·403 은 기기가 아니라 서비스 계정·프로젝트 쪽 문제라 행을 지우지 않는다 */
function resultOf(statusCode: number, unregistered: boolean): TransportResult {
  if (statusCode === 404 || unregistered) return "gone";
  if (statusCode === 401 || statusCode === 403) return "credentials";
  if (statusCode === 429 || statusCode >= 500) return "retry";
  return "rejected";
}

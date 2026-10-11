/** APNs 통로 — `http2` + ES256 JWT(네이티브 푸시 스펙 「통로」 장). 새 의존성 없이 Node 내장만 쓴다 */
import { constants as http2, type ClientHttp2Session, connect } from "node:http2";
import { sign } from "node:crypto";
import type { Logger } from "../../../logger";
import type { ApnsCredentials } from "../credentials";
import { PUSH_SEND_TIMEOUT_MS, PUSH_TTL_SECONDS, pushTopic } from "../service";
import type { DeviceTarget, PushNotification, PushTransport, TransportResult } from "./types";

/** Apple 은 토큰을 20분 안에는 새로 만들지 말고 60분 넘기지 말라고 한다 — 그 사이 50분 */
export const APNS_JWT_TTL_MS = 50 * 60_000;

export const APNS_PRODUCTION_HOST = "api.push.apple.com";
export const APNS_SANDBOX_HOST = "api.sandbox.push.apple.com";

/** 기기가 등록한 환경의 호스트 — 환경을 안 실은 기기는 production 이다 */
export function apnsHostFor(environment: DeviceTarget["environment"]): string {
  return environment === "sandbox" ? APNS_SANDBOX_HOST : APNS_PRODUCTION_HOST;
}

/**
 * 응답 → 결과. 403 은 이유와 무관하게 credentials 다 — APNs 의 403 은 전부 제공자 인증(토큰·인증서·토픽 권한) 문제라
 * 기기 탓이 아니다(스펙 표는 InvalidProviderToken·ExpiredProviderToken 만 적었다).
 * 400 은 기기가 사라졌거나 환경을 잘못 등록한 두 사유만 gone — 환경이 틀린 기기는 앱이 다시 등록한다
 */
export function apnsResult(status: number, reason: string | undefined): TransportResult {
  if (status === 200) return "ok";
  if (status === 410) return "gone";
  if (status === 403) return "credentials";
  if (status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")) return "gone";
  // 0 은 응답 헤더 없이 스트림이 끝난 것 — 서버가 끊은 네트워크 사정이라 기기·요청 탓이 아니다
  if (status === 0 || status === 429 || status >= 500) return "retry";
  return "rejected";
}

/** APNs 의 reason 은 CamelCase 단어다 — 모양이 다른 응답 값은 로그에 옮기지 않는다(토큰이 섞여 올 가능성을 막는다) */
const REASON = /^[A-Za-z]{1,40}$/;

/**
 * 서버가 요청을 처리하지 않았다고 확실한 오류 — 세션이 GOAWAY·종료로 막 닫혔거나(요청이 시작되지 못함), GOAWAY 와 엇갈려 나간
 * 요청이 REFUSED_STREAM 으로 돌아온 경우. 이때만 새 세션으로 한 번 더 보낸다(그 밖의 오류를 되풀이하면 알림이 두 번 갈 수 있다)
 */
function notProcessed(err: unknown): boolean {
  const { code, message } = err as NodeJS.ErrnoException;
  return (
    code === "ERR_HTTP2_GOAWAY_SESSION" ||
    code === "ERR_HTTP2_INVALID_SESSION" ||
    (code === "ERR_HTTP2_STREAM_ERROR" && /REFUSED_STREAM/.test(message))
  );
}

export function apnsTransport(opts: {
  credentials: ApnsCredentials;
  /** 호스트[:포트]. 없으면 기기 environment 로 고른다 — 통합 테스트가 가짜 서버로 덮는다 */
  host?: string;
  ca?: Buffer;
  now?: () => number;
  logger?: Pick<Logger, "warn">;
}): PushTransport & { close(): Promise<void> } {
  const { credentials, now = Date.now, logger } = opts;
  const sessions = new Map<string, ClientHttp2Session>();
  let jwt: { token: string; issuedAt: number } | undefined;

  /** 서명은 동기라 동시 발송이 둘을 만들지 않는다. 폐기된 키로 403 이 연달아 와도 토큰은 이 규칙대로만 새로 만든다 */
  const bearer = (): string => {
    const t = now();
    if (jwt !== undefined && t - jwt.issuedAt < APNS_JWT_TTL_MS) return jwt.token;
    const part = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const input = `${part({ alg: "ES256", kid: credentials.keyId })}.${part({ iss: credentials.teamId, iat: Math.floor(t / 1000) })}`;
    const sig = sign("sha256", Buffer.from(input), { key: credentials.key, dsaEncoding: "ieee-p1363" });
    jwt = { token: `${input}.${sig.toString("base64url")}`, issuedAt: t };
    return jwt.token;
  };

  const drop = (host: string, session: ClientHttp2Session) => {
    if (sessions.get(host) === session) sessions.delete(host);
    if (!session.destroyed) session.close();
  };

  /** 호스트마다 세션 하나를 재사용한다. 끊기거나 GOAWAY 를 받은 세션은 붙잡지 않는다 — 다음 발송이 새로 연결한다 */
  const sessionFor = (host: string): ClientHttp2Session => {
    const existing = sessions.get(host);
    if (existing !== undefined && !existing.closed && !existing.destroyed) return existing;
    const session = connect(`https://${host}`, opts.ca === undefined ? {} : { ca: opts.ca });
    session.unref();
    sessions.set(host, session);
    session.on("close", () => drop(host, session));
    session.on("goaway", () => drop(host, session));
    // 연결 오류는 진행 중인 요청의 stream 오류로도 온다 — 여기서는 세션만 버린다
    session.on("error", () => drop(host, session));
    return session;
  };

  const post = (
    host: string,
    token: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ status: number; reason: string | undefined }> =>
    new Promise((resolve, reject) => {
      const req = sessionFor(host).request({
        [http2.HTTP2_HEADER_METHOD]: "POST",
        [http2.HTTP2_HEADER_PATH]: `/3/device/${token}`,
        "content-type": "application/json",
        ...headers,
      });
      let status = 0;
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        req.close(http2.NGHTTP2_CANCEL);
        reject(new Error("apns request timed out"));
      }, PUSH_SEND_TIMEOUT_MS);
      timer.unref();
      req.on("response", (h) => {
        status = Number(h[http2.HTTP2_HEADER_STATUS]);
      });
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.on("end", () => {
        clearTimeout(timer);
        let reason: unknown;
        try {
          reason = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { reason?: unknown }).reason;
        } catch {
          reason = undefined;
        }
        resolve({ status, reason: typeof reason === "string" ? reason : undefined });
      });
      req.end(body);
    });

  return {
    kind: "apns",
    async send(target, n: PushNotification) {
      if (target.kind !== "device" || target.platform !== "ios")
        throw new Error(`apns transport cannot send to a ${target.kind} target`);
      const { payload } = n;
      const host = opts.host ?? apnsHostFor(target.environment);
      const headers = {
        authorization: `bearer ${bearer()}`,
        "apns-topic": target.appId,
        "apns-push-type": "alert",
        "apns-priority": payload.kind === "approval" ? "10" : "5",
        "apns-collapse-id": pushTopic(payload.tag),
        "apns-expiration": String(Math.floor(now() / 1000) + PUSH_TTL_SECONDS),
      };
      const body = JSON.stringify({
        aps: {
          alert: { title: payload.title, body: payload.body },
          sound: "default",
          "thread-id": payload.channelId,
        },
        dodok: { url: payload.url, kind: payload.kind, channelId: payload.channelId },
      });
      let res: { status: number; reason: string | undefined };
      try {
        res = await post(host, target.token, headers, body);
      } catch (err) {
        if (!notProcessed(err)) throw err;
        res = await post(host, target.token, headers, body);
      }
      const result = apnsResult(res.status, res.reason);
      if (result === "rejected" || result === "credentials")
        logger?.warn(
          {
            transport: "apns",
            statusCode: res.status,
            reason: res.reason !== undefined && REASON.test(res.reason) ? res.reason : "unknown",
          },
          "apns refused the push",
        );
      return result;
    },
    async close() {
      for (const [host, session] of sessions) drop(host, session);
    },
  };
}

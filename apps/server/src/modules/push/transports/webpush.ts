/** 웹 푸시 통로 — VAPID 로 브라우저 푸시 서비스에 보낸다(PWA·푸시 스펙 5.4) */
import webpush from "web-push";
import { PUSH_SEND_TIMEOUT_MS, PUSH_TTL_SECONDS, pushTopic } from "../service";
import type { PushTransport, TransportResult } from "./types";

export type PushSend = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  body: string,
  opts: { TTL: number; urgency: "high" | "normal"; topic: string },
) => Promise<{ statusCode: number }>;

/** 실제 발송기 — `AppDeps.pushSend` 가 없을 때. 2xx 가 아닌 응답(WebPushError)은 statusCode 로 바꾸고, 그 밖(네트워크)은 던진다 */
export function webPushSender(vapid: { subject: string; publicKey: string; privateKey: string }): PushSend {
  return async (sub, body, opts) => {
    try {
      const r = await webpush.sendNotification(sub, body, {
        ...opts,
        vapidDetails: vapid,
        timeout: PUSH_SEND_TIMEOUT_MS,
      });
      return { statusCode: r.statusCode };
    } catch (err) {
      if (err instanceof webpush.WebPushError) return { statusCode: err.statusCode };
      throw err;
    }
  };
}

/**
 * 상태 코드 → 결과. 403 은 VAPID 주체·키 문제(Apple 의 BadJwtToken 등)라 구독 탓이 아니다 — 지우지 않게 rejected 로 둔다.
 * credentials 로 올리지 않는 것은 스펙 「통로」 장의 webpush 결과 표를 따른 것이다
 */
function resultOf(statusCode: number): TransportResult {
  if (statusCode >= 200 && statusCode < 300) return "ok";
  if (statusCode === 404 || statusCode === 410) return "gone";
  if (statusCode === 400 || statusCode === 403 || statusCode === 413) return "rejected";
  return "retry";
}

/** 발송기를 통로로 감싼다. `send` 는 첫 await 앞에서 부른다 — 통합 시나리오가 버스 emit 안에서 발송 호출을 동기로 센다 */
export function webPushTransport(send: PushSend): PushTransport {
  return {
    kind: "webpush",
    async send(target, n) {
      if (target.kind !== "web") throw new Error(`webpush transport cannot send to a ${target.kind} target`);
      const { statusCode } = await send(
        { endpoint: target.endpoint, keys: target.keys },
        JSON.stringify(n.payload),
        {
          TTL: PUSH_TTL_SECONDS,
          urgency: n.urgency,
          topic: pushTopic(n.payload.tag),
        },
      );
      return resultOf(statusCode);
    },
  };
}

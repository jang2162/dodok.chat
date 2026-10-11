import { z } from "zod";
import { Id } from "../common";

// 웹 푸시 계약(스펙 2.3·5.1). 구독 keys 는 브라우저 PushSubscription.toJSON() 의 base64url(끝 = 패딩 둘까지)
const B64Url = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/);

/** POST /api/v1/push/subscriptions 본문 — endpoint 로 upsert(다른 사용자에게 묶여 있으면 지금 사용자로 옮긴다) */
export const PushSubscriptionInput = z.object({
  endpoint: z.url().startsWith("https://").max(2048),
  keys: z.object({ p256dh: B64Url.max(200), auth: B64Url.max(100) }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;

/** DELETE /api/v1/push/subscriptions 본문 — 세션 사용자의 것만 지운다, 없으면 204(멱등) */
export const PushUnsubscribeInput = z.object({ endpoint: z.string().max(2048) });
export type PushUnsubscribeInput = z.infer<typeof PushUnsubscribeInput>;

/**
 * POST /api/v1/push/devices 본문 — token 으로 upsert(다른 사용자에게 묶여 있으면 지금 사용자로 옮긴다).
 * iOS 토큰은 APNs 기기 토큰(hex 64자), Android 는 FCM 등록 토큰. environment 는 iOS 만 — APNs 호스트를 가른다
 */
export const PushDeviceInput = z.discriminatedUnion("platform", [
  z.object({
    platform: z.literal("ios"),
    token: z.string().regex(/^[0-9a-f]{64}$/i),
    appId: z.string().min(1).max(200),
    environment: z.enum(["sandbox", "production"]),
  }),
  z.object({
    platform: z.literal("android"),
    token: z.string().min(1).max(4096),
    appId: z.string().min(1).max(200),
  }),
]);
export type PushDeviceInput = z.infer<typeof PushDeviceInput>;

/** DELETE /api/v1/push/devices 본문 — 세션 사용자의 것만 지운다, 없으면 204(멱등) */
export const PushDeviceRemove = z.object({ token: z.string().min(1).max(4096) });
export type PushDeviceRemove = z.infer<typeof PushDeviceRemove>;

/** GET /api/v1/push/capabilities — 통로가 켜졌는가(웹·iOS·Android) */
export const PushCapabilities = z.object({ webpush: z.boolean(), ios: z.boolean(), android: z.boolean() });
export type PushCapabilities = z.infer<typeof PushCapabilities>;

/** 서버 → 푸시 서비스 → 서비스 워커. 누가·어디·무엇만 싣는다 — 메시지 본문·툴 인자·승인 내용은 넣지 않는다(결정 1) */
export const PushPayload = z.object({
  kind: z.enum(["mention", "approval", "relay_limit"]),
  channelId: Id,
  title: z.string().max(80),
  body: z.string().max(200),
  url: z.string().max(200), // 같은 출처 상대 경로(/c/<uuid>·/c/<uuid>/activity·/c/<uuid>/t/<uuid>) — 서비스 워커가 다시 거른다
  tag: z.string().max(80),
});
export type PushPayload = z.infer<typeof PushPayload>;

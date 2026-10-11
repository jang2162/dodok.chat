/** 푸시 통로 계약(네이티브 푸시 스펙 「통로」 장) — 디스패처는 대상의 종류·플랫폼으로 통로를 고르고 결과만 본다 */
import type { PushPayload } from "@dodok/shared";

export type TransportKind = "webpush" | "apns" | "fcm" | "relay";

/**
 * 디스패처가 결과마다 하는 일: ok → debug · gone → 그 구독·기기 행 삭제 · rejected → error(행 유지) ·
 * credentials → 행 유지·운영 사건 push_credentials_invalid · retry → warn. 재시도는 없다.
 * 네트워크 오류처럼 결과를 정할 수 없으면 던진다 — 디스패처가 warn 으로 남긴다
 */
export type TransportResult = "ok" | "gone" | "rejected" | "credentials" | "retry";

export type WebTarget = { kind: "web"; id: string; endpoint: string; keys: { p256dh: string; auth: string } };
export type DeviceTarget = {
  kind: "device";
  id: string;
  platform: "ios" | "android";
  token: string;
  appId: string;
  environment?: "sandbox" | "production";
};

export type PushNotification = { payload: PushPayload; urgency: "high" | "normal" };

export interface PushTransport {
  readonly kind: TransportKind;
  send(target: WebTarget | DeviceTarget, n: PushNotification): Promise<TransportResult>;
}

/** 앱이 켠 통로 — 없는 키는 그 통로가 꺼져 있다. relay 는 자리만이라 여기 오지 않는다 */
export type PushTransports = Partial<Record<"webpush" | "apns" | "fcm", PushTransport>>;

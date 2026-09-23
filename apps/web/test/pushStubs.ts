import { stubNotification } from "./domStubs";

/** 가짜 PushSubscription — endpoint·applicationServerKey·해지 여부 */
export type FakeSubscription = {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null; userVisibleOnly: boolean };
  unsubscribed: boolean;
  toJSON(): { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } };
  unsubscribe(): Promise<boolean>;
};

/** 테스트용 VAPID 공개키(base64url) 와 그 바이트 */
export const VAPID_KEY = "AQIDBAUGBwg";
export const OTHER_KEY = "CQoLDA0ODxA";

const keyBytes = (b64: string): ArrayBuffer => {
  const raw = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i += 1) view[i] = raw.charCodeAt(i);
  return buf;
};

let seq = 0;
export function fakeSubscription(key = VAPID_KEY): FakeSubscription {
  seq += 1;
  const sub: FakeSubscription = {
    endpoint: `https://push.example/send/${seq}`,
    options: { applicationServerKey: keyBytes(key), userVisibleOnly: true },
    unsubscribed: false,
    toJSON: () => ({ endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: "BPk", auth: "au" } }),
    unsubscribe: async () => {
      sub.unsubscribed = true;
      pushStub.current = pushStub.current === sub ? null : pushStub.current;
      return true;
    },
  };
  return sub;
}

/** 지금 스텁 상태(한 번에 하나) — 테스트가 구독·호출을 들여다본다 */
export const pushStub: {
  current: FakeSubscription | null;
  subscribed: Array<{ applicationServerKey: Uint8Array }>;
  failSubscribe: boolean;
} = { current: null, subscribed: [], failSubscribe: false };

/**
 * 푸시 전역 스텁 — `navigator.serviceWorker`(ready·getRegistration)·`PushManager`·`Notification`.
 * `registered: false` 면 서비스 워커가 아직 없는 것(getRegistration 이 undefined, ready 는 끝나지 않음).
 * `restore()` 가 전역을 되돌린다 — jsdom 에는 없던 이름이라 지운다
 */
export function stubPush(
  opts: {
    permission?: NotificationPermission;
    registered?: boolean;
    subscription?: FakeSubscription | null;
  } = {},
) {
  pushStub.current = opts.subscription ?? null;
  pushStub.subscribed = [];
  pushStub.failSubscribe = false;
  const notification = stubNotification(opts.permission ?? "default");
  const registration = {
    pushManager: {
      getSubscription: async () => pushStub.current,
      subscribe: async (o: { applicationServerKey: Uint8Array }) => {
        if (pushStub.failSubscribe) throw new DOMException("push service error", "AbortError");
        pushStub.subscribed.push(o);
        const bytes = [...o.applicationServerKey];
        const b64 = btoa(String.fromCharCode(...bytes))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        pushStub.current = fakeSubscription(b64);
        return pushStub.current;
      },
    },
  };
  const registered = opts.registered ?? true;
  const container = {
    ready: registered ? Promise.resolve(registration) : new Promise(() => {}),
    getRegistration: async () => (registered ? registration : undefined),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true });
  const g = globalThis as Record<string, unknown>;
  g.PushManager = class {};
  return {
    notification,
    restore() {
      notification.restore();
      delete (navigator as unknown as Record<string, unknown>).serviceWorker;
      delete g.PushManager;
    },
  };
}

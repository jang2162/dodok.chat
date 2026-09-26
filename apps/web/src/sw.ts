/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import {
  focusAndNavigate,
  notificationFromPush,
  pickClient,
  safeNotificationUrl,
  urlBase64ToUint8Array,
} from "./pwa/sw-logic";

// 주입 자리의 타입(Array<PrecacheEntry | string>)은 workbox-precaching 이 ServiceWorkerGlobalScope 에 더한다
declare const self: ServiceWorkerGlobalScope;

// 주입 자리는 한 번만 — workbox injectManifest 는 주입 자리가 파일에 정확히 한 번 나오기를 요구한다
const manifest = self.__WB_MANIFEST;

cleanupOutdatedCaches();
precacheAndRoute(manifest);

// SPA 탐색 폴백 — /api·/socket.io 는 네트워크만(스펙 3장). 개발 모드는 매니페스트가 비어 index.html 이 없을 수 있다
if (manifest.some((e) => (typeof e === "string" ? e : e.url) === "index.html")) {
  registerRoute(
    new NavigationRoute(createHandlerBoundToURL("index.html"), { denylist: [/^\/api\//, /^\/socket\.io\//] }),
  );
}

// 새 버전은 웹이 「새로고침」을 누를 때만 넘어간다(스펙 결정 7)
self.addEventListener("message", (event) => {
  if ((event.data as { type?: unknown } | null)?.type === "SKIP_WAITING") void self.skipWaiting();
});

// ── 푸시(스펙 3장) ──

self.addEventListener("push", (event) => {
  let data: unknown;
  try {
    data = event.data?.json();
  } catch {
    data = undefined; // JSON 이 아니면 「dodok — 새 알림」
  }
  const { title, options } = notificationFromPush(data);
  event.waitUntil(
    self.registration.showNotification(title, {
      ...options,
      icon: "/pwa-192x192.png",
      badge: "/pwa-64x64.png",
    }),
  );
});

// 누르면 같은 출처 창(보이는 창 먼저)을 앞으로 가져와 라우터로 옮긴다 — 전체 새로고침은 작성 중인 초안을 잃는다(결정 7)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeNotificationUrl((event.notification.data as { url?: unknown } | null)?.url);
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const i = pickClient(
        all.map((c) => ({ url: c.url, visibilityState: c.visibilityState, focused: c.focused })),
        self.location.origin,
      );
      const client = all[i];
      if (!client) {
        await self.clients.openWindow(url);
        return;
      }
      await focusAndNavigate(client, url);
    })(),
  );
});

// 브라우저가 구독을 갈았다 — 새로 구독해 등록한다(쿠키 인증). 실패는 조용히: 다음에 앱을 열면 동기화가 고친다(스펙 5.1)
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch("/api/v1/push/vapid-public-key", { credentials: "same-origin" }).catch(
        () => undefined,
      );
      const key = res?.ok ? ((await res.json().catch(() => null)) as { publicKey?: unknown } | null) : null;
      if (typeof key?.publicKey !== "string") return;
      const sub = await self.registration.pushManager
        .subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key.publicKey) })
        .catch(() => undefined);
      if (!sub) return;
      await fetch("/api/v1/push/subscriptions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      }).catch(() => undefined);
    })(),
  );
});

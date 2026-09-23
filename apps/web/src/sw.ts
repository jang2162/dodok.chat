/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

// __WB_MANIFEST 의 타입(Array<PrecacheEntry | string>)은 workbox-precaching 이 ServiceWorkerGlobalScope 에 더한다
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

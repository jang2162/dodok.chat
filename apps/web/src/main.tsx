import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { createApp } from "./app/createApp";
import { registerSessionReset } from "./app/session";
import { BUILD_ID, startPersistence } from "./pwa/persist";
import { showUpdateToast, startPwa } from "./pwa/register";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root 가 없다");

// 오프라인 사본(스펙 4장)은 그리기 전에 복원한다(최대 1초) — 같은 queryClient 를 App 에 넘긴다.
// 로그아웃·401 은 resetClientState 가 정리를 부르므로 사본 지우기를 거기에 건다
const app = createApp();
void startPersistence(app.queryClient, { buster: BUILD_ID }).then((persistence) => {
  registerSessionReset(() => void persistence.clear());

  createRoot(root).render(
    <StrictMode>
      <App app={app} />
    </StrictMode>,
  );

  // 서비스 워커 등록은 첫 화면을 막지 않는다 — 가상 모듈은 vite-plugin-pwa 가 빌드·개발 서버에서만 만든다
  void import("virtual:pwa-register")
    .then(({ registerSW }) => startPwa({ register: registerSW, onNeedRefresh: showUpdateToast }))
    .catch((err: unknown) => console.warn("service worker registration skipped", err));
});

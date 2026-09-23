import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { showUpdateToast, startPwa } from "./pwa/register";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root 가 없다");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// 서비스 워커 등록은 첫 화면을 막지 않는다 — 가상 모듈은 vite-plugin-pwa 가 빌드·개발 서버에서만 만든다
void import("virtual:pwa-register")
  .then(({ registerSW }) => startPwa({ register: registerSW, onNeedRefresh: showUpdateToast }))
  .catch((err: unknown) => console.warn("service worker registration skipped", err));

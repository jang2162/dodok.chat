import "./lib/zodJitless";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bootApp } from "./app/boot";
import { createApp } from "./app/createApp";
import { BUILD_ID } from "./pwa/persist";
import { showUpdateToast, startPwa } from "./pwa/register";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root 가 없다");

// 온라인 여부 알리기·오프라인 사본 복원(최대 1초)·사본 지우기 등록을 마친 뒤 그린다(bootApp)
void bootApp(createApp(), {
  buster: BUILD_ID,
  render: (el) => createRoot(root).render(<StrictMode>{el}</StrictMode>),
}).then(() => {
  // 서비스 워커 등록은 첫 화면을 막지 않는다 — 가상 모듈은 vite-plugin-pwa 가 빌드·개발 서버에서만 만든다
  void import("virtual:pwa-register")
    .then(({ registerSW }) => startPwa({ register: registerSW, onNeedRefresh: showUpdateToast }))
    .catch((err: unknown) => console.warn("service worker registration skipped", err));
});

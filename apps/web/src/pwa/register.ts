import { toast } from "sonner";
import type { registerSW as RegisterSW } from "virtual:pwa-register";

type StartOptions = { onNeedRefresh(update: () => Promise<void>): void; register?: typeof RegisterSW };

/** 서비스 워커 등록(스펙 3장). 새 버전은 스스로 바꾸지 않고 onNeedRefresh 로 묻는다(결정 7) */
export function startPwa(opts: StartOptions): void {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker) return;
  const register = opts.register;
  if (!register) return;
  const updateSW = register({
    immediate: true,
    onNeedRefresh: () => opts.onNeedRefresh(() => updateSW(true)),
    onRegisterError: (err: unknown) => console.warn("service worker registration failed", err),
  });
}

export function showUpdateToast(update: () => Promise<void>): void {
  toast.info("새 버전이 있습니다", {
    id: "pwa-update",
    duration: Number.POSITIVE_INFINITY,
    action: { label: "새로고침", onClick: () => void update() },
  });
}

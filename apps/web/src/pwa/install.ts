import { useSyncExternalStore } from "react";

/** Chromium 의 `beforeinstallprompt` 이벤트 — 표준 타입이 없다 */
type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/** 설치해 연 앱인가 — `display-mode: standalone` 또는 iOS Safari 의 `navigator.standalone` */
export function isStandalone(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  let displayStandalone = false;
  try {
    displayStandalone = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  } catch {
    displayStandalone = false;
  }
  return iosStandalone || displayStandalone;
}

/**
 * iOS·iPadOS 인가 — 푸시는 홈 화면에 추가한 앱(16.4+)에서만 된다(스펙 6장 「설치 필요」).
 * iPadOS 13+ 의 Safari 는 데스크톱 맥으로 자기를 소개하므로 터치 지점 수로 가른다
 */
export function isIos(): boolean {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

// `beforeinstallprompt` 는 페이지마다 한 번, 화면이 그 패널을 열기 전에 올 수 있다 — 모듈에서 받아 둔다
let deferred: BeforeInstallPromptEvent | undefined;
const listeners = new Set<() => void>();
const emit = () => {
  for (const fn of listeners) fn();
};
let capturing = false;

/** 설치 이벤트를 받기 시작한다(여러 번 불러도 한 번). createApp 이 앱 시작 때 부른다 */
export function captureInstallPrompt(): void {
  if (capturing || typeof window === "undefined") return;
  capturing = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // 브라우저 기본 배너 대신 패널의 「앱 설치」로
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = undefined;
    emit();
  });
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** 「앱 설치」 — 받은 설치 이벤트가 있고 아직 설치해 연 앱이 아니면 `canInstall` */
export function useInstallPrompt(): { canInstall: boolean; install(): Promise<void> } {
  const event = useSyncExternalStore(subscribe, () => deferred);
  return {
    canInstall: event !== undefined && !isStandalone(),
    install: async () => {
      const e = deferred;
      if (!e) return;
      // 이벤트는 한 번만 쓸 수 있다 — 거절해도 다시 오기 전까지 버튼을 숨긴다
      deferred = undefined;
      emit();
      await e.prompt();
      await e.userChoice.catch(() => undefined);
    },
  };
}

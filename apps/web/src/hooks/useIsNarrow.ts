import { useSyncExternalStore } from "react";

/** 사이드바를 시트로 접는 폭(스펙 2.4 — 768px 미만) */
const NARROW = "(max-width: 767px)";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(NARROW);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useIsNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

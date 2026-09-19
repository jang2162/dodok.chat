import type { QueryClient } from "@tanstack/react-query";

const resets = new Set<() => void>();

/** 로그아웃·401 때 부를 정리(소켓 끊기·런 스토어 비우기 등). 해제 함수를 돌려준다 */
export function registerSessionReset(fn: () => void): () => void {
  resets.add(fn);
  return () => {
    resets.delete(fn);
  };
}

export function resetClientState(queryClient: QueryClient): void {
  for (const fn of resets) fn();
  queryClient.clear();
}

const unauthorized = new Set<() => void>();

/**
 * Query 밖 REST(과거 페이지·빈틈 이어 받기)의 401 을 받을 곳 — App 이 마운트 동안 createApp 의 onUnauthorized 를
 * 등록한다(next·「이미 /login 이면 생략」이 그쪽에 있다). 해제 함수를 돌려준다
 */
export function registerUnauthorized(fn: () => void): () => void {
  unauthorized.add(fn);
  return () => {
    unauthorized.delete(fn);
  };
}

/** Query 밖 REST 401(스펙 8장 「REST 401 → 로그인」). 토스트는 부른 쪽이 내지 않는다 */
export function notifyUnauthorized(): void {
  for (const fn of unauthorized) fn();
}

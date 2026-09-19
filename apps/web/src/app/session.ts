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

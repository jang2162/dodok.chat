import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { api } from "@/api/http";
import { qk } from "@/api/queries";
import { resetClientState } from "@/app/session";

/**
 * 응답의 sessionToken 은 쓰지 않는다 — 쿠키가 인증이다(Global Constraints).
 * 성공하면 me 를 다시 불러오고, 이동은 LoginPage 가 me 성공을 보고 한 번만 한다.
 */
export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api<unknown>("POST", "/auth/local", { token }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
  });
}

/** 성공·실패와 상관없이 클라이언트 상태를 비우고 `/login` 으로 간다 — 부르는 쪽은 mutate() 만 */
export function useLogout() {
  const qc = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: () => api<{ ok: true }>("POST", "/auth/logout"),
    onSettled: () => {
      resetClientState(qc);
      // 401(이미 끊긴 세션)이면 onUnauthorized 가 먼저 로그인으로 보냈다 — 두 번 가지 않는다
      if (router.latestLocation.pathname !== "/login") void router.navigate({ to: "/login", replace: true });
    },
  });
}

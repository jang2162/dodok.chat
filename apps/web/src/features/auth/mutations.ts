import type { AcceptInviteBody, LocalLoginBody, ResetPasswordBody } from "@dodok/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { api } from "@/api/http";
import { qk } from "@/api/queries";
import { resetClientState } from "@/app/session";
import { disablePush } from "@/pwa/push";

/** 로그아웃 앞 푸시 해지를 기다리는 최대 시간 — 서버가 답하지 않아도 로그아웃은 막히지 않는다 */
const PUSH_OFF_WAIT_MS = 3000;

/**
 * 응답의 sessionToken 은 쓰지 않는다 — 쿠키가 인증이다(Global Constraints).
 * 성공하면 me 를 다시 불러오고, 이동은 LoginPage 가 me 성공을 보고 한 번만 한다.
 * 토큰·비밀번호가 뮤테이션 `variables` 로 남지 않게 `gcTime: 0` — 부르는 쪽은 끝나면 `reset()` 해 캐시에서 곧 빠지게 한다.
 * 오류는 폼 안에서만 알린다(`silent`).
 */
export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    // 본문({ sessionToken, user })은 버린다 — 세션 자격이 뮤테이션 state.data 에 실리지 않게
    mutationFn: async (body: LocalLoginBody) => {
      await api<unknown>("POST", "/auth/local", body);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.me }),
    gcTime: 0,
    meta: { silent: true },
  });
}

/**
 * 초대 수락·재설정 수락 — 둘 다 로그인과 같은 `{ sessionToken, user }` 를 주고 쿠키를 굽는다. 본문은 버리고(useLogin 과 같은 까닭)
 * `gcTime: 0` 이다. 뒷일(상태 비우기·토큰 걷기·이동)은 `useFinishInvite` 가 한다
 */
function useInviteMutation<B extends { token: string }>(path: "/invites/accept" | "/invites/reset") {
  return useMutation({
    mutationFn: async (body: B) => {
      await api<unknown>("POST", path, body);
    },
    gcTime: 0,
    meta: { silent: true },
  });
}
export const useAcceptInvite = () => useInviteMutation<AcceptInviteBody>("/invites/accept");
export const useResetPassword = () => useInviteMutation<ResetPasswordBody>("/invites/reset");

/**
 * 수락이 끝난 뒤 — 새 사용자로 바뀌었으니 앞 사용자의 클라이언트 상태를 비우고(다른 계정으로 로그인해 있던 브라우저),
 * `/` 로 **바꿔** 간다. 라우터의 replace 이동은 `history.replaceState` 라 토큰 든 주소가 주소창·뒤로 가기에서 사라진다(스펙 7장).
 * me 는 앱 가드가 새 쿠키로 다시 받고, `/` 는 첫 채널로 보낸다
 */
export function useFinishInvite() {
  const qc = useQueryClient();
  const router = useRouter();
  return () => {
    resetClientState(qc);
    void router.navigate({ to: "/", replace: true });
  };
}

/**
 * 성공·실패와 상관없이 클라이언트 상태를 비우고 `/login` 으로 간다(그래서 오류 토스트도 없다) — 부르는 쪽은 mutate() 만.
 * 이 기기의 푸시 구독은 서버 로그아웃 **전에** 지운다 — 서버 해지(DELETE)에 세션이 필요하다(Review Focus 1).
 * 그 해지는 실패해도·늦어도 로그아웃을 막지 않는다(기기 구독은 세션 정리가 한 번 더 해지한다 — WireProvider)
 */
export function useLogout() {
  const qc = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        disablePush(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, PUSH_OFF_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      return api<{ ok: true }>("POST", "/auth/logout");
    },
    meta: { silent: true },
    onSettled: () => {
      resetClientState(qc);
      // 401(이미 끊긴 세션)이면 onUnauthorized 가 먼저 로그인으로 보냈다 — 두 번 가지 않는다
      if (router.latestLocation.pathname !== "/login") void router.navigate({ to: "/login", replace: true });
    },
  });
}

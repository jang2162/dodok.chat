import type { AcceptInviteBody, LocalLoginBody, ResetPasswordBody } from "@dodok/shared";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
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
      // 401(이미 끊긴 세션)이면 onUnauthorized 가 먼저 비우고 로그인으로 보냈다 — 두 번 가지 않는다
      if (router.latestLocation.pathname === "/login") {
        resetClientState(qc);
        return;
      }
      void leaveToLoginThenReset(qc, router);
    },
  });
}

/**
 * 화면을 `/login` 으로 바꾸는 **그 커밋 안에서** 상태를 비운다(plan.md 이월 D11). 먼저 비우고 이동하면, 이동이 끝나기 전까지 마운트돼 있는
 * 셸의 관찰자(채널·에이전트·DM·어댑터 상태)가 정리(`resets`)가 바꾼 스토어로 다시 그려지며 빈 캐시에서 새로 받아 끊긴 세션으로 401 이
 * 몇 건 더 났다. 라우터가 새 매치를 넣은 직후(`onBeforeRouteMount`) 비우면 스토어 변화와 화면 교체가 한 번에 그려져 셸은 다시 그려지지
 * 않고 내려간다. 그 전에는 me 가 남아 있어도 로그인 화면은 아직 그려지지 않았으니 「이미 로그인」으로 되돌아가지 않는다.
 * 진행 중인 조회는 먼저 끊는다 — 응답이 비운 캐시에 다시 들어오지 않게.
 * 로그아웃(`useLogout`)과 세션 만료 401(`createApp` 의 `onUnauthorized`, `next` 를 싣는다)이 함께 쓴다. 비운 뒤 풀리는 약속을 돌려준다
 */
export function leaveToLoginThenReset(
  qc: QueryClient,
  router: ReturnType<typeof useRouter>,
  next?: string,
): Promise<void> {
  void qc.cancelQueries();
  let done = false;
  const reset = () => {
    if (done) return;
    done = true;
    off();
    resetClientState(qc);
  };
  const off = router.subscribe("onBeforeRouteMount", (e) => {
    if (e.toLocation.pathname === "/login") reset();
  });
  // 실패해도 상태는 비운다 — 세션은 이미 끝났다. 이동 막기(useBlocker)는 무시한다: 막힌 이동의 약속은 풀리지도 거절되지도 않아 정리가 영영 안 돈다
  const moved =
    next === undefined
      ? router.navigate({ to: "/login", replace: true, ignoreBlocker: true })
      : router.navigate({ to: "/login", search: { next }, replace: true, ignoreBlocker: true });
  return moved.then(reset, reset);
}

import type { ChangePasswordBody, UpdateMeBody, User } from "@dodok/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/http";
import { type MeResponse, qk } from "@/api/queries";

/** `PATCH /me` — 응답의 사용자로 me 캐시를 고친다(역할·워크스페이스 칸은 그대로). 오류는 대화상자 안에서 알린다 */
export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateMeBody) => api<{ user: User }>("PATCH", "/me", body),
    onSuccess: ({ user }) => qc.setQueryData<MeResponse>(qk.me, (prev) => prev && { ...prev, user }),
    meta: { silent: true },
  });
}

/**
 * `POST /me/password` — 성공은 204, 이 세션을 뺀 본인 세션이 끊긴다. 틀린 현재 비밀번호는 401 이 아니라 400 `field: "current"` 다
 * (401 이면 세션 끝남으로 읽혀 로그인 화면으로 간다). 비밀번호가 `variables` 로 남지 않게 `gcTime: 0` — 부르는 쪽이 끝나면 `reset()`
 */
export function useChangePassword() {
  return useMutation({
    mutationFn: async (body: ChangePasswordBody) => {
      await api<unknown>("POST", "/me/password", body);
    },
    gcTime: 0,
    meta: { silent: true },
  });
}

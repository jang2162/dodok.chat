import type { IssuedInvite, MemberRow } from "@dodok/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/**
 * 링크 발급(초대·재설정 — 팀 스펙 3.2). 원문은 발급 응답에만 있다 — 결과를 뮤테이션 상태로 돌려주지 않고 `onIssued` 로
 * 부르는 쪽 컴포넌트 상태에만 넘긴다(설정 마법사 `useIssueBridgeToken` 과 같은 규칙). 뮤테이션 캐시의 `data` 는 늘 undefined 다
 */
function useIssueLink<V>(
  request: (v: V) => Promise<IssuedInvite>,
  onIssued: (url: string) => void,
  after?: () => void,
) {
  return useMutation({
    mutationFn: async (v: V): Promise<void> => {
      onIssued((await request(v)).url);
    },
    gcTime: 0,
    onSuccess: after,
  });
}

/** 초대 링크 — admin 은 member 만(서버가 막는다). 대기 목록은 원문 없는 줄로 다시 받는다 */
export function useIssueInvite(onIssued: (url: string) => void) {
  const qc = useQueryClient();
  return useIssueLink(
    (role: "admin" | "member") => api<IssuedInvite>("POST", "/invites", { role }),
    onIssued,
    () => void qc.invalidateQueries({ queryKey: qk.invites }),
  );
}

/** 비밀번호 재설정 링크(24시간·1회) — 같은 사람의 앞 링크는 서버가 폐기한다. 대기 초대 목록에는 나오지 않는다 */
export function useIssueResetLink(userId: string, onIssued: (url: string) => void) {
  return useIssueLink(() => api<IssuedInvite>("POST", `/members/${userId}/reset-link`), onIssued);
}

export function useRevokeInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>("DELETE", `/invites/${id}`),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.invites }),
  });
}

/**
 * 역할 바꾸기(owner 만). 사람 목록은 wire `people.changed` 가 고친다 — 표는 응답 줄로 곧바로 바꾼다.
 * 강등이면 서버가 그 사람이 만든 쓰이지 않은 링크를 폐기하므로 대기 초대도 다시 받는다
 */
export function useChangeRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: "admin" | "member" }) =>
      (await api<{ member: MemberRow }>("PATCH", `/members/${userId}`, { role })).member,
    onSuccess: (member) => {
      qc.setQueryData<MemberRow[]>(qk.teamMembers, (list) =>
        list?.map((m) => (m.id === member.id ? member : m)),
      );
      void qc.invalidateQueries({ queryKey: qk.invites });
    },
  });
}

/**
 * 비활성화·다시 활성화(채널 보관·멤버 비활성화 스펙 「멤버 비활성화」 절) — 비활성화하면 서버가 그 사람의 세션·소켓·푸시 구독을 끊고
 * 그 사람이 만들었거나 그 사람을 겨눈 쓰이지 않은 링크를 폐기한다. 둘 다 멱등이고 지금 줄을 돌려준다 — 표는 응답 줄로 곧바로
 * 바꾸고(줄이 「비활성 멤버 N」 묶음과 표 사이를 옮겨 간다) 대기 초대는 다시 받는다. 사람 목록은 wire `people.changed` 가 고친다
 */
export function useSetMemberActive() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: async ({ userId, active }: { userId: string; active: boolean }) =>
      (await api<{ member: MemberRow }>("POST", `/members/${userId}/${active ? "reactivate" : "deactivate"}`))
        .member,
    onSuccess: (member) => {
      qc.setQueryData<MemberRow[]>(qk.teamMembers, (list) =>
        list?.map((m) => (m.id === member.id ? member : m)),
      );
      void qc.invalidateQueries({ queryKey: qk.invites });
    },
  });
  // 같은 틱 두 번 클릭에 한 번만 보낸다 — 까닭은 `useRestoreAgent` 와 같다(`isPending` 은 다시 그린 뒤에야 참). 실패는 전역 토스트
  const sending = useRef(false);
  const { mutate } = mutation;
  const setActive = useCallback(
    (userId: string, active: boolean, onSuccess?: () => void) => {
      if (sending.current) return;
      sending.current = true;
      mutate(
        { userId, active },
        {
          ...(onSuccess ? { onSuccess } : {}),
          onSettled: () => {
            sending.current = false;
          },
        },
      );
    },
    [mutate],
  );
  return { setActive, isPending: mutation.isPending };
}

import type { IssuedInvite, MemberRow } from "@dodok/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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

/** 역할 바꾸기(owner 만). 사람 목록은 wire `people.changed` 가 고친다 — 표는 응답 줄로 곧바로 바꾼다 */
export function useChangeRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: "admin" | "member" }) =>
      (await api<{ member: MemberRow }>("PATCH", `/members/${userId}`, { role })).member,
    onSuccess: (member) =>
      qc.setQueryData<MemberRow[]>(qk.teamMembers, (list) =>
        list?.map((m) => (m.id === member.id ? member : m)),
      ),
  });
}

/** 내보내기 — 서버가 그 사람의 세션·소켓·푸시 구독을 끊는다. 표에서 곧바로 뺀다 */
export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api<void>("DELETE", `/members/${userId}`),
    onSuccess: (_void, userId) =>
      qc.setQueryData<MemberRow[]>(qk.teamMembers, (list) => list?.filter((m) => m.id !== userId)),
  });
}

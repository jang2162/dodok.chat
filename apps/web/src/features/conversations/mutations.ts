import type { ChannelMember, Conversation, ConversationPatch } from "@dodok/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";
import { applyConversation } from "./cache";

/**
 * 제목 바꾸기·닫기·다시 열기(`PATCH /conversations/:id`). 응답으로 세션 캐시·목록 칸을 고친다 — 같은 변경이 wire `conversation.updated`
 * 로도 오지만(다른 탭이 이것으로 안다) 응답이 먼저 와도 늦게 와도 같은 값이다. 403·409 는 전역 토스트가 알린다
 */
export function usePatchConversation(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: ConversationPatch) =>
      (await api<{ conversation: Conversation }>("PATCH", `/conversations/${conversationId}`, patch))
        .conversation,
    onSuccess: (conversation) => applyConversation(qc, conversation),
  });
}

/**
 * 세션 관리자 지정(`PUT`)·해제(`DELETE …/session-managers/:userId`, admin 이상). 응답의 멤버 한 줄로 멤버 캐시를 고친다 — 지정은 채널에
 * 없던 사람을 참여시키므로 없으면 더한다. 서버가 `channel.member.changed` 로 목록 전체도 보낸다
 */
export function useSetSessionManager(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, on }: { userId: string; on: boolean }) =>
      (
        await api<{ member: ChannelMember }>(
          on ? "PUT" : "DELETE",
          `/channels/${channelId}/session-managers/${userId}`,
        )
      ).member,
    onSuccess: (member) =>
      qc.setQueryData<ChannelMember[]>(
        qk.members(channelId),
        (prev) =>
          prev &&
          (prev.some((m) => m.id === member.id)
            ? prev.map((m) => (m.id === member.id ? member : m))
            : [...prev, member]),
      ),
  });
}

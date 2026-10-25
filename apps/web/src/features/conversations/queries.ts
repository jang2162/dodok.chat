import type { Conversation, ConversationList, ServerToClientEvents } from "@dodok/shared";
import {
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { api } from "@/api/http";
import { qk } from "@/api/queries";
import { NEW_CONVERSATION } from "@/features/messages/timeline";
import { useWire } from "@/realtime/WireProvider";
import { type ConversationPages, noteConversationActivity, visibleConversations } from "./cache";

/**
 * 세션 하나(`GET /conversations/:id`) — 세션 머리의 제목·닫힘. 새 세션 창(`NEW_CONVERSATION`)은 부르지 않는다. 오류는 화면이 따로
 * 그리지 않는다(메시지 목록이 「세션을 찾을 수 없습니다」를 그린다) — 토스트를 끈다(`silent`). 실시간으로는 `conversation.updated` 가
 * 갈아 끼운다(`applyConversation`). 받는 것은 세션 화면(`ChannelPage`)이 맡는다 — 그 아래 자리는 `useConversationView`
 */
const conversationQuery = (conversationId: string) =>
  queryOptions({
    queryKey: qk.conversation(conversationId),
    queryFn: async () =>
      (await api<{ conversation: Conversation }>("GET", `/conversations/${conversationId}`)).conversation,
    enabled: conversationId !== NEW_CONVERSATION,
    meta: { silent: true },
  });
export const useConversation = (conversationId: string) => useQuery(conversationQuery(conversationId));
/**
 * 세션 화면 아래 자리(머리의 제목·닫기, 스레드 패널)가 같은 세션을 읽는다 — 마운트할 때 다시 받지 않는다. 세션 화면이 먼저 받은 값을 채널이
 * 확인된 뒤 붙는 자리가 또 받으면 화면이 뜰 때 같은 GET 이 두 번 나간다(태스크 6 리뷰 L1). 값이 없으면 받고(나가 있으면 그것을 기다린다),
 * 다시 받기(재연결·409 의 무효화)는 세션 화면의 관찰자가 맡는다
 */
export const useConversationView = (conversationId: string) =>
  useQuery({ ...conversationQuery(conversationId), refetchOnMount: false });

/**
 * 세션 목록 칸 — 최근 활동순 20개씩(채널 세션 스펙 「wire·REST」 장), 상태·제목 검색어마다 따로. 화면 목록은 쪽을 펼쳐 상태·검색어로
 * 다시 거르고 정렬한 것이다(`visibleConversations` — 실시간 반영이 자리만 고친다). 검색어를 바꾸는 동안은 앞 결과를 보인다
 */
export function useConversationList(channelId: string, status: "open" | "closed", q: string) {
  const query = useInfiniteQuery({
    queryKey: qk.conversationList(channelId, status, q),
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ status });
      if (q !== "") params.set("q", q);
      if (pageParam !== undefined) params.set("cursor", pageParam);
      return api<ConversationList>("GET", `/channels/${channelId}/conversations?${params}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    meta: { silent: true },
  });
  return {
    ...query,
    conversations: visibleConversations(query.data as ConversationPages | undefined, status, q),
  };
}

/**
 * 주소의 채널(`/c/<A>/s/<B 채널의 세션>`)과 받은 세션의 채널이 다르면 그 세션의 채널 주소로 바꿔 간다(replace — 태스크 5 리뷰 L1). 세션
 * 메시지 REST 는 워크스페이스만 보므로, 그대로 두면 A 의 머리·멤버·작성기 아래 B 의 글이 그려지고 보내기는 서버가 VALIDATION 으로 거절한다.
 * 패널 탭(`settings`·`activity`·`t/<root>`)과 검색 문자열은 그대로 가져간다. 옮긴 뒤 틀린 채널 키로 받아 둔 타임라인·스레드는 버린다.
 * 세션이 이 채널 것으로 확인됐는가를 돌려준다 — 그 전에는 최근 본 세션으로 남기지 않는다(오프라인 사본이 틀린 짝을 담지 않게)
 */
export function useSessionChannelGuard(
  channelId: string,
  conversationId: string,
  conversation: Conversation | undefined,
): boolean {
  const qc = useQueryClient();
  const router = useRouter();
  const owner = conversation?.id === conversationId ? conversation.channelId : undefined;
  useEffect(() => {
    if (owner === undefined || owner === channelId) return;
    const prefix = `/c/${channelId}/s/${conversationId}`;
    const { pathname, searchStr } = router.state.location;
    const tail = pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : "";
    const forget = () => {
      qc.removeQueries({ queryKey: qk.timeline(channelId, conversationId), exact: true });
      qc.removeQueries({ queryKey: qk.threads(channelId, conversationId) });
    };
    void router
      .navigate({ href: `/c/${owner}/s/${conversationId}${tail}${searchStr}`, replace: true })
      .then(forget, forget);
  }, [qc, router, owner, channelId, conversationId]);
  return owner === channelId;
}

type MessageCreated = Parameters<ServerToClientEvents["message.created"]>[0];

/**
 * 목록 칸이 떠 있는 동안 그 채널의 새 글로 세션 순서를 올린다(`noteConversationActivity`). 실시간 계층(realtime/handlers)은 글을 타임라인에
 * 넣을 뿐이라, 순서는 목록을 그리는 쪽이 같은 이벤트를 따로 듣는다 — 칸이 닫혀 있는 동안 놓친 것은 다시 열 때 목록을 새로 받아 맞는다
 */
export function useConversationActivity(channelId: string): void {
  const qc = useQueryClient();
  const { socket } = useWire();
  useEffect(() => {
    if (!socket) return;
    const onCreated = ({ message }: MessageCreated) => {
      if (message.channelId === channelId) noteConversationActivity(qc, message);
    };
    socket.on("message.created", onCreated);
    return () => {
      socket.off("message.created", onCreated);
    };
  }, [socket, qc, channelId]);
}

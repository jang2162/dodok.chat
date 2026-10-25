import type { Conversation, ConversationList, Message } from "@dodok/shared";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { qk } from "@/api/queries";

/** 세션 목록 칸의 캐시 모양 — 쪽 묶음. 쪽 매개변수는 서버 커서(첫 쪽은 undefined) */
export type ConversationPages = InfiniteData<ConversationList, string | undefined>;

/** 목록 순서의 기준 — 서버 목록 REST 와 같다(최근 활동 = 마지막 메시지, 없으면 만든 때) */
const activityOf = (c: Conversation) => Date.parse(c.lastMessageAt ?? c.createdAt);

/** 최근 활동순, 같으면 id 내림차순(서버 `listConversations` 의 정렬과 같다) */
export function byActivity(a: Conversation, b: Conversation): number {
  return activityOf(b) - activityOf(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * 쪽들을 화면 목록으로 — 펼치고(같은 id 는 앞 것), 상태·제목 검색어로 거르고, 최근 활동순으로. 실시간 반영(`applyConversation`·
 * `noteConversationActivity`)은 쪽 안 자리만 고치거나 첫 쪽 앞에 넣으므로, 순서·거름은 여기 한 곳에서 다시 맞춘다
 */
export function visibleConversations(
  pages: ConversationPages | undefined,
  status: "open" | "closed",
  q: string,
): Conversation[] {
  const seen = new Set<string>();
  const needle = q.toLowerCase();
  const out: Conversation[] = [];
  for (const page of pages?.pages ?? []) {
    for (const c of page.conversations) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if ((c.closedAt !== undefined) !== (status === "closed")) continue;
      if (needle !== "" && !c.title.toLowerCase().includes(needle)) continue;
      out.push(c);
    }
  }
  return out.sort(byActivity);
}

/** 쪽 묶음에서 그 세션을 고친다 — 없으면 undefined(손대지 않았다) */
function patchPages(
  pages: ConversationPages,
  id: string,
  fn: (c: Conversation) => Conversation,
): ConversationPages | undefined {
  let found = false;
  const next = pages.pages.map((page) =>
    page.conversations.some((c) => c.id === id)
      ? {
          ...page,
          conversations: page.conversations.map((c) => {
            if (c.id !== id) return c;
            found = true;
            return fn(c);
          }),
        }
      : page,
  );
  return found ? { ...pages, pages: next } : undefined;
}

/**
 * wire `conversation.created`·`conversation.updated`(제목·닫기·다시 열기 — 계획 판정 PS12)와 우리 PATCH 응답. 세션 하나 캐시를 갈아
 * 끼우고, 그 채널의 목록 칸마다 자리를 고친다 — 없으면 첫 쪽 앞에 넣는다(다른 탭이 만든 세션, 닫혀서 닫힘 목록에 새로 드는 세션).
 * 어느 목록에 보일지는 `visibleConversations` 가 상태로 가른다. `/c/<채널>` 넘김이 쓰는 첫 쪽(`qk.conversations`)은 낡은 것으로만 둔다 —
 * 그 넘김은 늘 다시 받는다
 */
export function applyConversation(qc: QueryClient, conversation: Conversation): void {
  qc.setQueryData(qk.conversation(conversation.id), conversation);
  for (const [key, pages] of qc.getQueriesData<ConversationPages>({
    queryKey: qk.channelConversationLists(conversation.channelId),
  })) {
    if (!pages) continue;
    const patched = patchPages(pages, conversation.id, () => conversation);
    const [first, ...rest] = pages.pages;
    qc.setQueryData<ConversationPages>(
      key,
      patched ??
        (first
          ? {
              ...pages,
              pages: [{ ...first, conversations: [conversation, ...first.conversations] }, ...rest],
            }
          : pages),
    );
  }
  void qc.invalidateQueries({ queryKey: ["conversations", conversation.channelId], refetchType: "none" });
}

/**
 * 새 글이 그 세션의 활동 시각을 올린다(목록 순서 — 계획 판정 PS12: 서버는 메시지마다 `conversation.updated` 를 내지 않는다). 시스템
 * 메시지는 올리지 않는다(판정 PS11 — 서버 `touchConversation` 과 같다), 스레드 답글은 올린다. 받아 둔 목록에 그 세션이 없으면(더 옛
 * 쪽에 있었다) 그 채널의 목록을 다시 받게 한다 — 올라온 세션을 맨 위에 보이려고
 */
export function noteConversationActivity(qc: QueryClient, message: Message): void {
  if (message.kind === "system") return;
  const bump = (c: Conversation): Conversation => {
    const later =
      c.lastMessageAt === undefined || Date.parse(message.createdAt) > Date.parse(c.lastMessageAt);
    return {
      ...c,
      ...(later ? { lastMessageAt: message.createdAt } : {}),
      lastSeq: Math.max(c.lastSeq, message.seq),
    };
  };
  let missing = false;
  for (const [key, pages] of qc.getQueriesData<ConversationPages>({
    queryKey: qk.channelConversationLists(message.channelId),
  })) {
    if (!pages) continue;
    const patched = patchPages(pages, message.conversationId, bump);
    if (patched) qc.setQueryData(key, patched);
    // 닫힘 목록에 없는 것은 당연하다(글은 열린 세션에 쓴다)
    else if (key[2] === "open") missing = true;
  }
  if (missing) void qc.invalidateQueries({ queryKey: qk.channelConversationLists(message.channelId) });
}

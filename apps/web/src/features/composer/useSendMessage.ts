import type { Attachment, Message } from "@dodok/shared";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { qk } from "@/api/queries";
import { refreshArchivedChannel } from "@/features/channels/archived";
import {
  addPending,
  NEW_CONVERSATION,
  type PendingFailReason,
  removePending,
  setPendingState,
  type Timeline,
  upsert,
} from "@/features/messages/timeline";
import { getThread, getTimeline, updateThread, updateTimeline } from "@/realtime/timelineCache";
import { WireAckError, emitAck, useWireStatus } from "@/realtime/wire";
import { useWire } from "@/realtime/WireProvider";

export type SendMessage = {
  /** 보내는 중 항목을 넣고 `message.send`. 실패는 던지지 않고 항목을 `failed` 로 둔다. 첨부가 있으면 본문은 비어도 된다 */
  send(bodyMd: string, attachments?: readonly Attachment[]): Promise<void>;
  /** 같은 clientMsgId·같은 본문·같은 첨부로 다시(서버가 `(authorId, clientMsgId)` 로 멱등) */
  retry(clientMsgId: string): Promise<void>;
  /** 캐시에서만 지운다 */
  discard(clientMsgId: string): void;
};

/**
 * 새 세션 창에서 나간 첫 보내기 — QueryClient·채널마다 하나. 그 ack 를 기다리는 사이와 주소가 그 세션으로 바뀌기 전에 보낸 글은 새 세션을
 * 또 만들지 않고 그 세션으로 간다(빠르게 두 줄을 보내면 세션이 둘 생기지 않게). 실패하면 곧바로, 성공하면 주소를 바꾼 뒤 지운다
 */
const creating = new WeakMap<QueryClient, Map<string, Promise<string | undefined>>>();
const creatingOf = (qc: QueryClient) => {
  let byChannel = creating.get(qc);
  if (!byChannel) creating.set(qc, (byChannel = new Map()));
  return byChannel;
};

/**
 * 전송(스펙 4.4·채널 세션 계획 판정 PS4). 보내는 세션은 `conversationId` — 새 세션 창(`NEW_CONVERSATION`)이면 `newConversation` 을 싣고,
 * ack 가 알려 준 세션으로 확정 메시지를 옮긴 뒤 주소를 그 세션으로 바꿔 간다(replace — 뒤로 가기가 빈 창으로 돌아가지 않게). 옮긴 뒤에야
 * 새 세션 창의 보내는 중 항목을 지운다 — 주소가 바뀌기 전 화면에서 항목이 사라졌다 다시 나타나지 않게. ack 를 잃고 다시 보내도
 * 서버가 처음 만든 세션으로 답한다(판정 PS9).
 * ack `{ message }` 면 그 메시지로 확정(같은 메시지가 `message.created` 로도 오지만 한 번만 남는다),
 * ack 오류·10초 무응답이면 `failed`(ack RATE_LIMITED 면 사유 `rate_limited`, 보관한 채널·닫힌 세션이면 다시 보내기 없는 사유).
 * wire 가 `connected` 가 아니면 보내지 않고 곧바로 `failed` — socket.io 는 끊긴 동안의 emit 을 버퍼에 두었다가 붙으면 보낸다.
 * 반환하는 함수들은 렌더 사이에 같다.
 * `threadRootId` 를 주면 스레드 작성기다 — 루트를 싣고(답글이 아니라 루트, Review Focus 1) 보내는 중·확정은 스레드 캐시에.
 * 세션 타임라인의 seq 기록은 서버의 `message.created` 가 맡는다(그 이벤트가 ack 보다 먼저 온다)
 */
export function useSendMessage(
  channelId: string,
  conversationId: string,
  threadRootId?: string,
): SendMessage {
  const qc = useQueryClient();
  const { socket } = useWire();
  // 라우터 밖(작성기 단독 테스트)에서도 돈다 — 그때는 주소를 바꾸지 않는다
  const router = useRouter({ warn: false });
  const isNew = conversationId === NEW_CONVERSATION && threadRootId === undefined;

  const read = useCallback(
    (): Timeline | undefined =>
      threadRootId === undefined
        ? getTimeline(qc, channelId, conversationId)
        : getThread(qc, channelId, conversationId, threadRootId),
    [qc, channelId, conversationId, threadRootId],
  );
  const update = useCallback(
    (fn: (t: Timeline) => Timeline) =>
      threadRootId === undefined
        ? updateTimeline(qc, channelId, conversationId, fn)
        : updateThread(qc, channelId, conversationId, threadRootId, fn),
    [qc, channelId, conversationId, threadRootId],
  );

  /**
   * 새 세션 창의 보내기가 확정됐다 — 메시지를 그 세션 타임라인에 넣고, 아직 이 창을 보고 있으면 주소를 그 세션으로 바꾼 뒤 창의 항목을
   * 지운다. 처음 받는 세션이 이 메시지 하나뿐이 아니면(ack 를 잃은 재전송 — 그 사이 다른 글이 붙었다) 열 때 REST 로 다시 받게 낡은 것으로 둔다
   */
  const settleNew = useCallback(
    (clientMsgId: string, message: Message, lastSeq: number | undefined, done: () => void) => {
      const target = message.conversationId;
      const known = getTimeline(qc, channelId, target) !== undefined;
      updateTimeline(qc, channelId, target, (t) => upsert(t, message));
      if (!known && lastSeq !== message.seq)
        void qc.invalidateQueries({ queryKey: qk.timeline(channelId, target), refetchType: "none" });
      const forget = () => {
        updateTimeline(qc, channelId, NEW_CONVERSATION, (t) => removePending(t, clientMsgId));
        done();
      };
      const prefix = `/c/${channelId}/s/${NEW_CONVERSATION}`;
      const { pathname, searchStr } = router?.state.location ?? { pathname: "", searchStr: "" };
      if (!router || (pathname !== prefix && !pathname.startsWith(`${prefix}/`))) return forget();
      const href = `/c/${channelId}/s/${target}${pathname.slice(prefix.length)}${searchStr}`;
      void router.navigate({ href, replace: true }).then(forget, forget);
    },
    [qc, channelId, router],
  );

  const deliver = useCallback(
    async (clientMsgId: string, bodyMd: string, attachments: readonly Attachment[] = []) => {
      const fail = (reason?: PendingFailReason) =>
        update((t) => setPendingState(t, clientMsgId, "failed", reason));
      if (!socket || useWireStatus.getState().status !== "connected") return fail();
      const inFlight = creatingOf(qc);
      // 새 세션 창: 앞서 나간 첫 보내기가 있으면 그 세션으로 간다(실패했으면 다음 차례가 만든다). 없으면 이 보내기가 세션을
      // 만든다 — 표지는 기다리기 전에 세운다: 같은 틱에 보낸 둘째 글이 그것을 봐야 한다
      let target = isNew ? undefined : conversationId;
      let resolveCreated: ((id: string | undefined) => void) | undefined;
      while (isNew && target === undefined && resolveCreated === undefined) {
        const ahead = inFlight.get(channelId);
        if (ahead) target = await ahead;
        else inFlight.set(channelId, new Promise((resolve) => (resolveCreated = resolve)));
      }
      try {
        const ids = attachments.map((a) => a.id);
        const { message, conversation } = await emitAck(socket, "message.send", {
          channelId,
          clientMsgId,
          bodyMd,
          ...(target === undefined ? { newConversation: {} } : { conversationId: target }),
          ...(ids.length > 0 ? { attachments: ids } : {}),
          ...(threadRootId === undefined ? {} : { threadRootId }),
        });
        resolveCreated?.(message.conversationId);
        const settled = () => {
          if (resolveCreated) inFlight.delete(channelId);
        };
        if (isNew) settleNew(clientMsgId, message, conversation?.lastSeq, settled);
        else update((t) => upsert(t, message));
      } catch (e) {
        resolveCreated?.(undefined);
        if (resolveCreated) inFlight.delete(channelId);
        // wire ack 오류(TIMEOUT 포함)는 토스트 없이 항목에만 보인다(스펙 8장). 레이트리밋은 사유를 달아 다른 문구로
        // (운영 보강 스펙 4장) — 다시 보내기는 같은 clientMsgId 라 서버가 멱등으로 받는다
        const code = e instanceof WireAckError ? e.code : undefined;
        if (code === "CHANNEL_ARCHIVED") {
          // 이 탭이 보관을 아직 모른다(이벤트보다 먼저 보냈거나 놓쳤다) — 채널을 다시 받아 작성기를 안내로 바꾼다
          fail("channel_archived");
          refreshArchivedChannel(qc, channelId);
          return;
        }
        // 다른 탭이 이 세션을 닫았다(Review Focus 2) — 다시 보내도 같은 409 다. 작성기 자리는 `conversation.updated` 가 바꾼다
        if (code === "CONVERSATION_CLOSED") return fail("conversation_closed");
        fail(code === "RATE_LIMITED" ? "rate_limited" : undefined);
      }
    },
    [qc, socket, channelId, conversationId, threadRootId, isNew, update, settleNew],
  );

  const send = useCallback(
    async (bodyMd: string, attachments: readonly Attachment[] = []) => {
      const clientMsgId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const withAttachments = attachments.length > 0 ? { attachments: [...attachments] } : {};
      update((t) =>
        addPending(t, { clientMsgId, channelId, bodyMd, createdAt, state: "sending", ...withAttachments }),
      );
      await deliver(clientMsgId, bodyMd, attachments);
    },
    [channelId, deliver, update],
  );

  const retry = useCallback(
    async (clientMsgId: string) => {
      const p = read()?.pending.find((x) => x.clientMsgId === clientMsgId);
      if (!p) return;
      update((t) => setPendingState(t, clientMsgId, "sending"));
      await deliver(clientMsgId, p.bodyMd, p.attachments);
    },
    [read, update, deliver],
  );

  const discard = useCallback(
    (clientMsgId: string) => update((t) => removePending(t, clientMsgId)),
    [update],
  );

  return useMemo(() => ({ send, retry, discard }), [send, retry, discard]);
}

import type { Attachment, ErrorCode, Message } from "@dodok/shared";
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
import { WireAckError, type WireSocket, emitAck, useWireStatus } from "@/realtime/wire";
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
 * 새 세션 창의 첫 글 — QueryClient·채널마다 하나. 세션은 이 글 하나가 만든다: 그 ack 를 기다리는 사이와 주소가 그 세션으로 바뀌기 전에
 * 보낸 글은 새 세션을 또 만들지 않고 그 세션으로 간다(빠르게 두 줄을 보내면 세션이 둘 생기지 않게). 성공하면 주소를 바꾼 뒤 지운다.
 * 결과 불명(ack 시간 초과·끊김 — 서버가 저장했을 수 있다)으로 끝나면 지우지 않고 `attempt` 만 비워 둔다: 다음 보내기가 그 글을 먼저 같은
 * clientMsgId·`newConversation` 으로 다시 보내 세션을 얻는다(서버는 처음 만든 세션으로 답한다, 판정 PS9). 지우면 그 글이 실제로 저장됐을
 * 때 다음 글이 세션을 하나 더 만든다. 서버가 거절했으면(저장되지 않은 것이 확실) 지운다 — 다음 글이 새로 만든다
 */
type Creation = {
  clientMsgId: string;
  bodyMd: string;
  attachments: readonly Attachment[];
  /** 나가 있거나 성공한 보내기. 없으면 결과 불명으로 끝나 다시 보내기를 기다린다 */
  attempt?: Promise<Created>;
};
/** 세션 만들기의 끝 — 만든 세션, 결과 불명, 거절 */
type Created = { conversationId: string } | "unknown" | "rejected";
const creating = new WeakMap<QueryClient, Map<string, Creation>>();
const creatingOf = (qc: QueryClient) => {
  let byChannel = creating.get(qc);
  if (!byChannel) creating.set(qc, (byChannel = new Map()));
  return byChannel;
};

/**
 * 전송(스펙 4.4·채널 세션 계획 판정 PS4). 보내는 세션은 `conversationId` — 새 세션 창(`NEW_CONVERSATION`)이면 `newConversation` 을 싣고,
 * ack 가 알려 준 세션으로 확정 메시지를 옮긴 뒤 주소를 그 세션으로 바꿔 간다(replace — 뒤로 가기가 빈 창으로 돌아가지 않게). 그 뒤에
 * 창에 남은 항목을 그 세션으로 옮긴다(`settleNew`). 세션을 하나만 만드는 규칙은 `Creation`.
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
   * 보내는 중 항목을 고친다. 새 세션 창의 항목은 세션이 확정되면 그 세션 타임라인으로 옮겨 가므로(`settleNew`) 지금 있는 자리를 —
   * 창, 아니면 `target` 세션. 둘 다 없으면(지웠다) 캐시를 새로 만들지 않는다
   */
  const patchPending = useCallback(
    (clientMsgId: string, fn: (t: Timeline) => Timeline, target?: string) => {
      if (!isNew) return update(fn);
      const holds = (id: string) =>
        getTimeline(qc, channelId, id)?.pending.some((p) => p.clientMsgId === clientMsgId) ?? false;
      if (holds(NEW_CONVERSATION)) updateTimeline(qc, channelId, NEW_CONVERSATION, fn);
      else if (target !== undefined && holds(target)) updateTimeline(qc, channelId, target, fn);
    },
    [qc, channelId, isNew, update],
  );

  /**
   * 실패로 둔다. wire ack 오류(TIMEOUT 포함)는 토스트 없이 항목에만 보인다(스펙 8장). 레이트리밋은 사유를 달아 다른 문구로
   * (운영 보강 스펙 4장) — 다시 보내기는 같은 clientMsgId 라 서버가 멱등으로 받는다
   */
  const fail = useCallback(
    (clientMsgId: string, code: ErrorCode | undefined, target?: string) => {
      const mark = (reason?: PendingFailReason) =>
        patchPending(clientMsgId, (t) => setPendingState(t, clientMsgId, "failed", reason), target);
      if (code === "CHANNEL_ARCHIVED") {
        // 이 탭이 보관을 아직 모른다(이벤트보다 먼저 보냈거나 놓쳤다) — 채널을 다시 받아 작성기를 안내로 바꾼다
        mark("channel_archived");
        refreshArchivedChannel(qc, channelId);
        return;
      }
      // 다른 탭이 이 세션을 닫았다(Review Focus 2) — 다시 보내도 같은 409 다. 작성기 자리는 `conversation.updated` 가 바꾼다
      if (code === "CONVERSATION_CLOSED") return mark("conversation_closed");
      mark(code === "RATE_LIMITED" ? "rate_limited" : undefined);
    },
    [qc, channelId, patchPending],
  );

  /**
   * 새 세션 창의 보내기가 확정됐다 — 메시지를 그 세션 타임라인에 넣고, 아직 이 창을 보고 있으면 주소를 그 세션으로 바꾼 뒤 창에 남은
   * 항목(그 세션을 기다리는 보내는 중·앞서 실패한 것)을 모두 그 세션으로 옮긴다 — 주소가 바뀌기 전 화면에서 항목이 사라졌다 다시 나타나지
   * 않게, 그리고 실패 항목의 「다시 보내기」가 그 세션으로 나가게. 처음 받는 세션이 이 메시지 하나뿐이 아니면(ack 를 잃은 재전송 — 그 사이
   * 다른 글이 붙었다) 열 때 REST 로 다시 받게 낡은 것으로 둔다
   */
  const settleNew = useCallback(
    (clientMsgId: string, message: Message, lastSeq: number | undefined, done: () => void) => {
      const target = message.conversationId;
      const known = getTimeline(qc, channelId, target) !== undefined;
      updateTimeline(qc, channelId, target, (t) => upsert(t, message));
      if (!known && lastSeq !== message.seq)
        void qc.invalidateQueries({ queryKey: qk.timeline(channelId, target), refetchType: "none" });
      const forget = () => {
        // 이미 그 세션에 확정된 것은 옮기지 않는다 — 뒤에 보낸 글의 확정이 앞 글의 주소 바꾸기보다 먼저 끝나면 창에 앞 글이 남아 있다
        const confirmed = new Set(getTimeline(qc, channelId, target)?.items.map((m) => m.clientMsgId));
        const left = (getTimeline(qc, channelId, NEW_CONVERSATION)?.pending ?? []).filter(
          (p) => p.clientMsgId !== clientMsgId && !confirmed.has(p.clientMsgId),
        );
        if (left.length > 0)
          updateTimeline(qc, channelId, target, (t) => left.reduce((acc, p) => addPending(acc, p), t));
        if (getTimeline(qc, channelId, NEW_CONVERSATION))
          updateTimeline(qc, channelId, NEW_CONVERSATION, (t) => ({ ...t, pending: [] }));
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

  /** 새 세션 창: 이 글로 세션을 만든다(`newConversation`). 끝은 표지에 남긴다 — 위 `Creation` */
  const create = useCallback(
    (socket: WireSocket, entry: Omit<Creation, "attempt">): Promise<Created> => {
      const byChannel = creatingOf(qc);
      const own: Creation = { ...entry };
      byChannel.set(channelId, own);
      const { clientMsgId, bodyMd, attachments } = entry;
      const ids = attachments.map((a) => a.id);
      own.attempt = emitAck(socket, "message.send", {
        channelId,
        clientMsgId,
        bodyMd,
        newConversation: {},
        ...(ids.length > 0 ? { attachments: ids } : {}),
      }).then(
        ({ message, conversation }): Created => {
          settleNew(clientMsgId, message, conversation?.lastSeq, () => {
            if (byChannel.get(channelId) === own) byChannel.delete(channelId);
          });
          return { conversationId: message.conversationId };
        },
        (e: unknown): Created => {
          const code = e instanceof WireAckError ? e.code : undefined;
          fail(clientMsgId, code);
          if (byChannel.get(channelId) !== own) return code === "TIMEOUT" ? "unknown" : "rejected";
          if (code === "TIMEOUT") {
            delete own.attempt;
            return "unknown";
          }
          byChannel.delete(channelId);
          return "rejected";
        },
      );
      return own.attempt;
    },
    [qc, channelId, settleNew, fail],
  );

  const deliver = useCallback(
    async (clientMsgId: string, bodyMd: string, attachments: readonly Attachment[] = []) => {
      if (!socket || useWireStatus.getState().status !== "connected") return fail(clientMsgId, undefined);
      let target = isNew ? undefined : conversationId;
      // 새 세션 창: 세션을 만드는 첫 글이 있으면 그 세션으로 간다. 없으면(앞 글이 거절됐으면) 이 글이 만든다 — 표지는 기다리기 전에
      // 세운다(`create`): 같은 틱에 보낸 둘째 글이 그것을 봐야 한다
      while (target === undefined) {
        const ahead = creatingOf(qc).get(channelId);
        // 표지가 없거나, 결과 불명으로 끝난 이 글 자신(그 항목의 「다시 보내기」)이면 이 글이 만든다
        if (!ahead || (ahead.clientMsgId === clientMsgId && !ahead.attempt)) {
          await create(socket, { clientMsgId, bodyMd, attachments });
          return;
        }
        let created: Created;
        if (ahead.attempt) created = await ahead.attempt;
        else {
          // 결과 불명으로 끝난 첫 글 — 그것을 먼저 다시 보내 세션을 얻는다
          patchPending(ahead.clientMsgId, (t) => setPendingState(t, ahead.clientMsgId, "sending"));
          created = await create(socket, ahead);
        }
        // 첫 글이 또 결과 불명이면 이 글은 보내지 않는다 — 세션을 둘 만들지 않게
        if (created === "unknown") return fail(clientMsgId, "TIMEOUT");
        if (created !== "rejected") target = created.conversationId;
      }
      try {
        const ids = attachments.map((a) => a.id);
        const { message, conversation } = await emitAck(socket, "message.send", {
          channelId,
          clientMsgId,
          bodyMd,
          conversationId: target,
          ...(ids.length > 0 ? { attachments: ids } : {}),
          ...(threadRootId === undefined ? {} : { threadRootId }),
        });
        if (isNew) settleNew(clientMsgId, message, conversation?.lastSeq, () => {});
        else update((t) => upsert(t, message));
      } catch (e) {
        fail(clientMsgId, e instanceof WireAckError ? e.code : undefined, target);
      }
    },
    [
      qc,
      socket,
      channelId,
      conversationId,
      threadRootId,
      isNew,
      update,
      patchPending,
      fail,
      create,
      settleNew,
    ],
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
    (clientMsgId: string) => {
      update((t) => removePending(t, clientMsgId));
      // 결과 불명으로 남은 첫 글을 지웠다 — 다음 글이 그것을 다시 보내지 않고 새로 만든다(지운 글을 몰래 보내지 않게)
      const byChannel = creatingOf(qc);
      const ahead = isNew ? byChannel.get(channelId) : undefined;
      if (ahead?.clientMsgId === clientMsgId && !ahead.attempt) byChannel.delete(channelId);
    },
    [qc, channelId, isNew, update],
  );

  return useMemo(() => ({ send, retry, discard }), [send, retry, discard]);
}

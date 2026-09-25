import type { Attachment } from "@dodok/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
  type PendingFailReason,
  addPending,
  removePending,
  setPendingState,
  upsert,
} from "@/features/messages/timeline";
import { getTimeline, updateTimeline } from "@/realtime/timelineCache";
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
 * 전송(스펙 4.4). ack `{ message }` 면 그 메시지로 확정(같은 메시지가 `message.created` 로도 오지만 한 번만 남는다),
 * ack 오류·10초 무응답이면 `failed`(ack RATE_LIMITED 면 사유 `rate_limited`). wire 가 `connected` 가 아니면 보내지 않고 곧바로 `failed` —
 * socket.io 는 끊긴 동안의 emit 을 버퍼에 두었다가 붙으면 보낸다. 반환하는 함수들은 렌더 사이에 같다
 */
export function useSendMessage(channelId: string): SendMessage {
  const qc = useQueryClient();
  const { socket } = useWire();

  const deliver = useCallback(
    async (clientMsgId: string, bodyMd: string, attachments: readonly Attachment[] = []) => {
      const fail = (reason?: PendingFailReason) =>
        updateTimeline(qc, channelId, (t) => setPendingState(t, clientMsgId, "failed", reason));
      if (!socket || useWireStatus.getState().status !== "connected") return fail();
      try {
        const ids = attachments.map((a) => a.id);
        const { message } = await emitAck(socket, "message.send", {
          channelId,
          clientMsgId,
          bodyMd,
          ...(ids.length > 0 ? { attachments: ids } : {}),
        });
        updateTimeline(qc, channelId, (t) => upsert(t, message));
      } catch (e) {
        // wire ack 오류(TIMEOUT 포함)는 토스트 없이 항목에만 보인다(스펙 8장). 레이트리밋은 사유를 달아 다른 문구로
        // (운영 보강 스펙 4장) — 다시 보내기는 같은 clientMsgId 라 서버가 멱등으로 받는다
        fail(e instanceof WireAckError && e.code === "RATE_LIMITED" ? "rate_limited" : undefined);
      }
    },
    [qc, socket, channelId],
  );

  const send = useCallback(
    async (bodyMd: string, attachments: readonly Attachment[] = []) => {
      const clientMsgId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const withAttachments = attachments.length > 0 ? { attachments: [...attachments] } : {};
      updateTimeline(qc, channelId, (t) =>
        addPending(t, { clientMsgId, channelId, bodyMd, createdAt, state: "sending", ...withAttachments }),
      );
      await deliver(clientMsgId, bodyMd, attachments);
    },
    [qc, channelId, deliver],
  );

  const retry = useCallback(
    async (clientMsgId: string) => {
      const p = getTimeline(qc, channelId)?.pending.find((x) => x.clientMsgId === clientMsgId);
      if (!p) return;
      updateTimeline(qc, channelId, (t) => setPendingState(t, clientMsgId, "sending"));
      await deliver(clientMsgId, p.bodyMd, p.attachments);
    },
    [qc, channelId, deliver],
  );

  const discard = useCallback(
    (clientMsgId: string) => updateTimeline(qc, channelId, (t) => removePending(t, clientMsgId)),
    [qc, channelId],
  );

  return useMemo(() => ({ send, retry, discard }), [send, retry, discard]);
}

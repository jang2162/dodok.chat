import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { addPending, removePending, setPendingState, upsert } from "@/features/messages/timeline";
import { getTimeline, updateTimeline } from "@/realtime/timelineCache";
import { emitAck, useWireStatus } from "@/realtime/wire";
import { useWire } from "@/realtime/WireProvider";

export type SendMessage = {
  /** 보내는 중 항목을 넣고 `message.send`. 실패는 던지지 않고 항목을 `failed` 로 둔다 */
  send(bodyMd: string): Promise<void>;
  /** 같은 clientMsgId·같은 본문으로 다시(서버가 `(authorId, clientMsgId)` 로 멱등) */
  retry(clientMsgId: string): Promise<void>;
  /** 캐시에서만 지운다 */
  discard(clientMsgId: string): void;
};

/**
 * 전송(스펙 4.4). ack `{ message }` 면 그 메시지로 확정(같은 메시지가 `message.created` 로도 오지만 한 번만 남는다),
 * ack 오류·10초 무응답이면 `failed`. wire 가 `connected` 가 아니면 보내지 않고 곧바로 `failed` —
 * socket.io 는 끊긴 동안의 emit 을 버퍼에 두었다가 붙으면 보낸다. 반환하는 함수들은 렌더 사이에 같다
 */
export function useSendMessage(channelId: string): SendMessage {
  const qc = useQueryClient();
  const { socket } = useWire();

  const deliver = useCallback(
    async (clientMsgId: string, bodyMd: string) => {
      const fail = () => updateTimeline(qc, channelId, (t) => setPendingState(t, clientMsgId, "failed"));
      if (!socket || useWireStatus.getState().status !== "connected") return fail();
      try {
        const { message } = await emitAck(socket, "message.send", { channelId, clientMsgId, bodyMd });
        updateTimeline(qc, channelId, (t) => upsert(t, message));
      } catch {
        // wire ack 오류(TIMEOUT 포함)는 토스트 없이 항목에만 보인다(스펙 8장)
        fail();
      }
    },
    [qc, socket, channelId],
  );

  const send = useCallback(
    async (bodyMd: string) => {
      const clientMsgId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      updateTimeline(qc, channelId, (t) =>
        addPending(t, { clientMsgId, channelId, bodyMd, createdAt, state: "sending" }),
      );
      await deliver(clientMsgId, bodyMd);
    },
    [qc, channelId, deliver],
  );

  const retry = useCallback(
    async (clientMsgId: string) => {
      const p = getTimeline(qc, channelId)?.pending.find((x) => x.clientMsgId === clientMsgId);
      if (!p) return;
      updateTimeline(qc, channelId, (t) => setPendingState(t, clientMsgId, "sending"));
      await deliver(clientMsgId, p.bodyMd);
    },
    [qc, channelId, deliver],
  );

  const discard = useCallback(
    (clientMsgId: string) => updateTimeline(qc, channelId, (t) => removePending(t, clientMsgId)),
    [qc, channelId],
  );

  return useMemo(() => ({ send, retry, discard }), [send, retry, discard]);
}

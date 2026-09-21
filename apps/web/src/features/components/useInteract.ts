import type { Message } from "@dodok/shared";
import { useState } from "react";
import { toast } from "sonner";
import { emitAck, useWireStatus, WireAckError } from "@/realtime/wire";
import { useWire } from "@/realtime/WireProvider";

/** component.interact ack 오류(스펙 6장). wire 오류는 REST 전역 토스트 밖이라 여기서 알린다 */
const ERR: Partial<Record<string, string>> = {
  EXPIRED: "만료된 버튼입니다",
  CONSUMED: "이미 처리된 버튼입니다",
  FORBIDDEN: "이 버튼을 누를 권한이 없습니다",
  VALIDATION: "처리할 수 없는 요청입니다",
  TIMEOUT: "서버 응답이 없습니다",
};

export type Interact = {
  /** 응답을 기다리는 아이템 id 들 */
  busy: ReadonlySet<string>;
  /** 거부하지 않는다 — ack 오류는 토스트로 알린다. 소켓·components.id 가 없으면 아무것도 보내지 않는다 */
  send(itemId: string, values: Record<string, unknown>, opts?: { blockId?: string }): Promise<void>;
  connected: boolean;
  hasSocket: boolean;
};

/**
 * 카드 하나의 `component.interact` 래퍼 — 버튼·셀렉트·모달이 함께 쓴다.
 * 소비 상태는 서버의 `message.updated` 로 바뀌고, 여기서는 응답을 기다리는 동안의 전송 중 표시만 든다
 */
export function useInteract(message: Message): Interact {
  const { socket } = useWire();
  const connected = useWireStatus((s) => s.status === "connected");
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const componentId = message.components?.id;

  async function send(itemId: string, values: Record<string, unknown>, opts: { blockId?: string } = {}) {
    if (!socket || !componentId) return;
    setBusy((s) => new Set(s).add(itemId));
    try {
      await emitAck(socket, "component.interact", {
        messageId: message.id,
        componentId,
        ...(opts.blockId ? { blockId: opts.blockId } : {}),
        itemId,
        values,
      });
    } catch (e: unknown) {
      if (e instanceof WireAckError) toast.error(ERR[e.code] ?? e.message);
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(itemId);
        return next;
      });
    }
  }

  return { busy, send, connected, hasSocket: socket !== undefined };
}

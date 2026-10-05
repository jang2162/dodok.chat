import type { ErrorCode, Message } from "@dodok/shared";
import { QueryClientContext } from "@tanstack/react-query";
import { useCallback, useContext, useState } from "react";
import { toast } from "sonner";
import { emitAck, useWireStatus, WireAckError } from "@/realtime/wire";
import { AGENT_ARCHIVED_TEXT, CHANNEL_ARCHIVED_TEXT } from "@/api/formErrors";
import { refreshArchivedChannel, useChannelArchived } from "@/features/channels/archived";
import { RATE_LIMITED_TEXT } from "@/features/messages/rateLimited";
import { useWire } from "@/realtime/WireProvider";
import { DISABLED_REASON_TEXT } from "./state";

/**
 * component.interact ack 오류(스펙 6장). wire 오류는 REST 전역 토스트 밖이라 여기서 알린다.
 * 버튼·셀렉트·모달이 함께 쓰므로 「버튼」이 아니라 「항목」이라 부른다(비활성 사유 `DISABLED_REASON_TEXT` 와 같은 말)
 */
const ERR: Partial<Record<ErrorCode, string>> = {
  EXPIRED: "만료된 항목입니다",
  CONSUMED: "이미 처리된 항목입니다",
  FORBIDDEN: "이 항목을 쓸 권한이 없습니다",
  VALIDATION: "처리할 수 없는 요청입니다",
  TIMEOUT: "서버 응답이 없습니다",
  // 「다시 실행」이 런 한도에 걸린 것 — 버튼은 소비되지 않아 한도가 풀리면 다시 누른다(채널에는 한도 시스템 메시지가 따로 뜬다)
  RUN_LIMIT: "오늘 런 한도에 도달했습니다 — 한도가 풀리면 다시 누를 수 있습니다",
  // 「다시 실행」의 에이전트가 삭제(보관)됨 — 버튼은 소비되지 않는다(스펙 「오류」 절)
  AGENT_ARCHIVED: AGENT_ARCHIVED_TEXT,
  // 카드의 채널이 보관됨 — 저장·소비 전에 거절하므로 보관 해제 뒤 다시 누른다(채널 보관 스펙 「오류」 장)
  CHANNEL_ARCHIVED: CHANNEL_ARCHIVED_TEXT,
  RATE_LIMITED: RATE_LIMITED_TEXT,
};

/** ack 이 WireAckError 가 아닌 것으로 깨졌을 때(ack 모양이 계약과 다름) */
const UNKNOWN_TEXT = "요청을 처리하지 못했습니다";

/** ack 오류 코드 → 화면 문구(ERR 표 한 곳). 표에 없는 코드는 서버 문구 */
export function interactErrorText(code: ErrorCode, serverMessage: string): string {
  return ERR[code] ?? serverMessage;
}

/**
 * `send` 의 결과 — 거부하지 않고 이것으로 성공·실패를 가른다.
 * 성공의 `interactionId` 는 ack 이 돌려준 상호작용 id(= 결과 줄의 `MessageInteraction.id`). ack 모양이 깨져 없으면 빠진다.
 * `DISCONNECTED` 는 소켓이나 components.id 가 없어 보내지 않은 것. `details` 는 서버 ApiError.details 그대로
 * (`VALIDATION` 의 `issues` 등, wire 에서 온 외부 입력이라 쓰는 쪽이 Zod 로 파싱한다)
 */
export type SendResult =
  | { ok: true; interactionId?: string }
  | { ok: false; code: ErrorCode | "DISCONNECTED"; text: string; details?: Record<string, unknown> };
type SendFailure = Extract<SendResult, { ok: false }>;

export type SendOptions = {
  blockId?: string;
  /** 실패를 `text` 로 토스트한다(기본 true). 모달은 끄고 대화상자 안에 보인다(스펙 6장) */
  toast?: boolean;
  /**
   * 성공하면 그 결과 줄로 초점을 건다(기본 true, 스펙 5.7). 모달은 끄고 대화상자가 **닫힌 뒤에** `focusResult` 로 건다 —
   * 열린 채 옮기면 Radix FocusScope 가 닫으면서 트리거로 되돌려 먹힌다
   */
  focus?: boolean;
};

export type Interact = {
  /** 응답을 기다리는 아이템 id 들 */
  busy: ReadonlySet<string>;
  /** 거부하지 않는다 — 결과로 가르고, 실패는 기본으로 토스트도 한다. 소켓·components.id 가 없으면 아무것도 보내지 않는다 */
  send(itemId: string, values: Record<string, unknown>, opts?: SendOptions): Promise<SendResult>;
  connected: boolean;
  hasSocket: boolean;
  /** 카드가 있는 채널이 보관됐다(채널 화면의 `ChannelArchivedContext`) — 모든 항목이 비활성 */
  archived: boolean;
  /**
   * 초점을 옮길 결과 줄 — **내가 보내 성공한** 상호작용의 id(ack 의 interactionId). 카드가 그 줄을 그리면 옮기고 `focusDone`.
   * 다른 사람이 보낸 것·만료는 이 id 가 아니라 초점을 뺏지 않는다
   */
  focusId: string | undefined;
  /** 이 상호작용의 결과 줄로 초점을 건다 — 모달이 닫힌 뒤에 부른다 */
  focusResult(interactionId: string): void;
  /** 결과 줄로 옮겼다 — 표식을 내린다 */
  focusDone(): void;
};

function failureOf(e: unknown): SendFailure {
  if (!(e instanceof WireAckError)) return { ok: false, code: "INTERNAL", text: UNKNOWN_TEXT };
  return {
    ok: false,
    code: e.code,
    text: interactErrorText(e.code, e.message),
    ...(e.details ? { details: e.details } : {}),
  };
}

/**
 * 카드 하나의 `component.interact` 래퍼 — 버튼·셀렉트·모달이 함께 쓴다.
 * 소비 상태는 서버의 `message.updated` 로 바뀌고, 여기서는 응답을 기다리는 동안의 전송 중 표시만 든다
 */
export function useInteract(message: Message): Interact {
  const { socket } = useWire();
  const connected = useWireStatus((s) => s.status === "connected");
  const archived = useChannelArchived();
  // 채널 화면 밖(카드만 그리는 테스트)에는 QueryClient 가 없다 — 그때는 409 뒤 채널을 다시 받지 않는다
  const qc = useContext(QueryClientContext);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = useState<string>();
  const focusDone = useCallback(() => setFocusId(undefined), []);
  const componentId = message.components?.id;

  async function send(
    itemId: string,
    values: Record<string, unknown>,
    opts: SendOptions = {},
  ): Promise<SendResult> {
    const fail = (r: SendFailure) => {
      if (r.code === "CHANNEL_ARCHIVED") {
        // 이 탭이 보관을 아직 모른다 — 채널을 다시 받으면 카드가 「보관된 채널입니다」로 잠긴다. 여러 카드를 눌러도 토스트는 하나
        if (qc) refreshArchivedChannel(qc, message.channelId);
        if (opts.toast !== false) toast.error(r.text, { id: "channel-archived" });
        return r;
      }
      if (opts.toast !== false) toast.error(r.text);
      return r;
    };
    if (!socket || !componentId) {
      return fail({ ok: false, code: "DISCONNECTED", text: DISABLED_REASON_TEXT.disconnected });
    }
    setBusy((s) => new Set(s).add(itemId));
    try {
      const data = await emitAck(socket, "component.interact", {
        messageId: message.id,
        componentId,
        ...(opts.blockId ? { blockId: opts.blockId } : {}),
        itemId,
        values,
      });
      // ack 모양이 깨져 id 가 없어도 보낸 것은 성공이다 — 초점만 못 건다
      const interactionId = typeof data?.interactionId === "string" ? data.interactionId : undefined;
      if (!interactionId) return { ok: true };
      // 보낸 itemId 가 아니라 이 상호작용의 id 를 기억한다 — 재사용 카드에서 같은 itemId 의 다른 사람 줄·내 옛 줄과 섞이지 않는다
      if (opts.focus !== false) setFocusId(interactionId);
      return { ok: true, interactionId };
    } catch (e: unknown) {
      return fail(failureOf(e));
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(itemId);
        return next;
      });
    }
  }

  return {
    busy,
    send,
    connected,
    hasSocket: socket !== undefined,
    archived,
    focusId,
    focusResult: setFocusId,
    focusDone,
  };
}

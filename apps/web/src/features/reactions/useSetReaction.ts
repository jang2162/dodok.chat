import { type Message, type MessageReaction, REACTION_EMOJIS, type ReactionEmoji } from "@dodok/shared";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { useMe } from "@/api/queries";
import { refreshArchivedChannel } from "@/features/channels/archived";
import { DM_READ_ONLY_TEXT, dmReadOnlyReasonOf, invalidateDms } from "@/features/dms/queries";
import { CHANNEL_ARCHIVED_TEXT, CONVERSATION_CLOSED_TEXT } from "@/api/formErrors";
import type { Timeline } from "@/features/messages/timeline";
import { useWire } from "@/realtime/WireProvider";
import { emitAck, WireAckError } from "@/realtime/wire";
import { getThread, getTimeline, patchTimeline, updateThread } from "@/realtime/timelineCache";

const FAILED_TEXT = "반응을 저장하지 못했습니다";

/** 이 메시지의 이모지 하나에서 내 표를 켜거나 끈다 — 이미 그 상태면 그대로(캐시 변경 로그가 새 결과에 다시 적용돼도 맞는다) */
export function setMine(
  reactions: readonly MessageReaction[],
  emoji: ReactionEmoji,
  me: string,
  on: boolean,
): MessageReaction[] {
  const cur = reactions.find((r) => r.emoji === emoji);
  const has = cur?.userIds.includes(me) ?? false;
  if (has === on) return [...reactions];
  const userIds = on ? [...(cur?.userIds ?? []), me] : (cur?.userIds ?? []).filter((id) => id !== me);
  const rest = reactions.filter((r) => r.emoji !== emoji);
  if (userIds.length === 0) return rest;
  const next: MessageReaction = { emoji, count: userIds.length, userIds };
  // 서버가 REACTION_EMOJIS 순서로 싣는다 — 낙관값도 같은 순서로 두어 정본이 와도 칩이 튀지 않는다
  return [...rest, next].sort((a, b) => REACTION_EMOJIS.indexOf(a.emoji) - REACTION_EMOJIS.indexOf(b.emoji));
}

const editMessage =
  (messageId: string, emoji: ReactionEmoji, me: string, on: boolean) =>
  (t: Timeline): Timeline =>
    t.items.some((m) => m.id === messageId)
      ? {
          ...t,
          items: t.items.map((m: Message) =>
            m.id === messageId ? { ...m, reactions: setMine(m.reactions, emoji, me, on) } : m,
          ),
        }
      : t;

const mineIn = (m: Pick<Message, "reactions"> | undefined, emoji: ReactionEmoji, me: string): boolean =>
  m?.reactions.find((r) => r.emoji === emoji)?.userIds.includes(me) ?? false;

/** (메시지, 이모지) 하나에 나가 있는 요청들 — 마지막 요청 번호, 아직 안 끝난 수, 이 탭이 서버에게서 마지막으로 들은 내 표 */
type Inflight = { seq: number; open: number; server: boolean; stop: () => void };

/**
 * 나가 있는 요청은 훅 인스턴스가 아니라 QueryClient(이 탭)마다 센다 — 같은 메시지를 그리는 행이 둘(채널 행·스레드 패널 행)이거나
 * 행이 다시 마운트돼도 한 줄로 세야, 뒤 행이 앞 행의 낙관값을 「서버 상태」로 잡지 않는다
 */
const inflightBy = new WeakMap<QueryClient, Map<string, Inflight>>();
let counter = 0;

function inflightOf(qc: QueryClient): Map<string, Inflight> {
  let byKey = inflightBy.get(qc);
  if (!byKey) inflightBy.set(qc, (byKey = new Map()));
  return byKey;
}

/**
 * 낙관적 갱신 → `reaction.set` → 실패하면 되돌리고 토스트. 같은 (메시지, 이모지)는 요청마다 번호를 매겨 **마지막 요청만**
 * 화면 정본이다 — 앞 요청이 늦게 실패해도 뒤에 누른 상태를 되돌리지 않는다(리액션 계획 「Review Focus」 절의 「같은 사람이 같은
 * 이모지를 빠르게 두 번 누름」). 마지막 요청이 실패하면 「반대로」가 아니라 **이 탭이 서버에게서 마지막으로 들은 상태**로 되돌린다 —
 * 첫 요청 직전의 캐시, 그 뒤로는 성공한 ack·받은 `message.updated`. 켜기·끄기가 둘 다 실패하면 서버 상태가 그대로라
 * `message.updated` 가 오지 않으므로, 「반대로」는 서버에 없는 칩을 새로고침 전까지 남긴다.
 * 서버의 `message.updated` 는 `applyMessage`(`realtime/handlers.ts`)가 캐시에 덮는다. 세션 타임라인 캐시는 받은 적이 있을 때만
 * 고친다 — 없는 것을 빈 목록으로 만들지 않는다
 */
export function useSetReaction(
  channelId: string,
  conversationId: string,
  threadRootId?: string,
): (messageId: string, emoji: ReactionEmoji, on: boolean) => void {
  const qc = useQueryClient();
  const { socket } = useWire();
  const me = useMe().data?.user.id;

  return useCallback(
    (messageId, emoji, on) => {
      const inflight = inflightOf(qc);
      const key = `${messageId}|${emoji}`;
      const seq = ++counter;
      const apply = (value: boolean) => {
        if (!me) return;
        const fn = editMessage(messageId, emoji, me, value);
        patchTimeline(qc, channelId, conversationId, fn);
        if (threadRootId) updateThread(qc, channelId, conversationId, threadRootId, fn);
      };
      const start = (): Inflight => {
        const cached =
          getTimeline(qc, channelId, conversationId)?.items.find((m) => m.id === messageId) ??
          (threadRootId
            ? getThread(qc, channelId, conversationId, threadRootId)?.items.find((m) => m.id === messageId)
            : undefined);
        // 이 탭 어느 행에서도 나가 있는 요청이 없으면 지금 캐시가 서버에게서 들은 상태다 — 낙관값을 얹기 전에 잡는다
        const r: Inflight = { seq, open: 0, server: me ? mineIn(cached, emoji, me) : false, stop: () => {} };
        if (socket && me) {
          const heard = ({ message: m }: { message: Message }) => {
            if (m.id === messageId) r.server = mineIn(m, emoji, me);
          };
          socket.on("message.updated", heard);
          r.stop = () => socket.off("message.updated", heard);
        }
        inflight.set(key, r);
        return r;
      };
      const req = inflight.get(key) ?? start();
      req.seq = seq;
      req.open += 1;
      const settle = () => {
        if (--req.open > 0) return;
        req.stop();
        inflight.delete(key);
      };
      const ok = () => {
        req.server = on;
        settle();
      };
      const fail = (e: unknown) => {
        settle();
        if (req.seq !== seq) return;
        apply(req.server);
        if (e instanceof WireAckError && e.code === "CHANNEL_ARCHIVED") {
          refreshArchivedChannel(qc, channelId);
          toast.error(CHANNEL_ARCHIVED_TEXT, { id: "channel-archived" });
          return;
        }
        // 다른 탭이 이 세션을 닫았다 — 다시 눌러도 같은 409 다
        if (e instanceof WireAckError && e.code === "CONVERSATION_CLOSED") {
          toast.error(CONVERSATION_CLOSED_TEXT, { id: "conversation-closed" });
          return;
        }
        // 이 탭이 DM 이 읽기 전용이 된 것을 아직 모른다 — DM 목록을 다시 받으면 피커가 숨고 작성기 자리가 사유 줄로 바뀐다
        if (e instanceof WireAckError && e.code === "DM_READ_ONLY") {
          void invalidateDms(qc);
          toast.error(DM_READ_ONLY_TEXT[dmReadOnlyReasonOf(e.details)], { id: "dm-read-only" });
          return;
        }
        toast.error(FAILED_TEXT, { id: "reaction-failed" });
      };
      apply(on);
      if (!socket) return fail(new Error("no socket"));
      emitAck(socket, "reaction.set", { messageId, emoji, on }).then(ok, fail);
    },
    [qc, socket, me, channelId, conversationId, threadRootId],
  );
}

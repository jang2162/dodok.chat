import { type Message, type MessageReaction, REACTION_EMOJIS, type ReactionEmoji } from "@dodok/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { toast } from "sonner";
import { useMe } from "@/api/queries";
import { refreshArchivedChannel } from "@/features/channels/archived";
import { CHANNEL_ARCHIVED_TEXT } from "@/api/formErrors";
import type { Timeline } from "@/features/messages/timeline";
import { useWire } from "@/realtime/WireProvider";
import { emitAck, WireAckError } from "@/realtime/wire";
import { getTimeline, updateThread, updateTimeline } from "@/realtime/timelineCache";

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

/**
 * 낙관적 갱신 → `reaction.set` → 실패하면 되돌리고 토스트. 같은 (메시지, 이모지)는 요청마다 번호를 매겨 **마지막 요청만**
 * 화면 정본이다 — 앞 요청이 늦게 실패해도 뒤에 누른 상태를 되돌리지 않는다(리액션 계획 Review Focus 1). 서버의 `message.updated` 가 오면
 * 그것이 캐시를 덮는다(기존 핸들러). 채널 타임라인 캐시는 들어간 적이 있을 때만 고친다 — 없는 것을 빈 목록으로 만들지 않는다
 */
export function useSetReaction(
  channelId: string,
  threadRootId?: string,
): (messageId: string, emoji: ReactionEmoji, on: boolean) => void {
  const qc = useQueryClient();
  const { socket } = useWire();
  const me = useMe().data?.user.id;
  const latest = useRef(new Map<string, number>());
  const counter = useRef(0);

  return useCallback(
    (messageId, emoji, on) => {
      const key = `${messageId}|${emoji}`;
      const seq = ++counter.current;
      latest.current.set(key, seq);
      const apply = (value: boolean) => {
        if (!me) return;
        const fn = editMessage(messageId, emoji, me, value);
        if (getTimeline(qc, channelId)) updateTimeline(qc, channelId, fn);
        if (threadRootId) updateThread(qc, channelId, threadRootId, fn);
      };
      const fail = (e: unknown) => {
        if (latest.current.get(key) !== seq) return;
        apply(!on);
        if (e instanceof WireAckError && e.code === "CHANNEL_ARCHIVED") {
          refreshArchivedChannel(qc, channelId);
          toast.error(CHANNEL_ARCHIVED_TEXT, { id: "channel-archived" });
          return;
        }
        toast.error(FAILED_TEXT, { id: "reaction-failed" });
      };
      apply(on);
      if (!socket) return fail(new Error("no socket"));
      emitAck(socket, "reaction.set", { messageId, emoji, on }).catch(fail);
    },
    [qc, socket, me, channelId, threadRootId],
  );
}

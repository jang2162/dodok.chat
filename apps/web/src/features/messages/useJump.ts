import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getThread, getTimeline } from "@/realtime/timelineCache";
import type { Row } from "./groupRows";
import { jumpToSeq } from "./jump";
import { clearJump, HIGHLIGHT_MS, type JumpTarget, listKey, useJumpStore } from "./jumpTarget";
import type { Timeline } from "./timeline";
import { reportPageError } from "./useOlderPages";

/**
 * 이 목록의 결과로 가기(`jumpTarget`) — 그 메시지 행이 있으면 `arrive(행 번호)` 로 보내고 2초 강조, 없으면 around 로 받아
 * 갈아 끼운 뒤 다시 본다. 받은 것이 지금 것일 때만(`ready` — `useTimelineState`) 받는다: 그 전에 갈아 끼우면 뒤이은 다시 받기
 * (처음 구독·오프라인 사본 복원 뒤)가 최신 페이지로 덮는다.
 * `pending` 이면 목표가 남아 있다 — 목록은 첫 붙임(맨 아래로)을 하지 않는다
 */
export function useJump(
  channelId: string,
  conversationId: string,
  threadRootId: string | undefined,
  timeline: Timeline | undefined,
  ready: boolean,
  rows: readonly Row[],
  arrive: (index: number) => void,
): { highlighted: string | undefined; pending: boolean } {
  const qc = useQueryClient();
  const key = listKey(conversationId, threadRootId);
  const target = useJumpStore((s) => s.targets[key]);
  const [highlighted, setHighlighted] = useState<string>();
  /** 이미 around 로 받은 목표 — 받은 뒤에도 행이 없으면 되풀이하지 않는다 */
  const requested = useRef<JumpTarget | undefined>(undefined);

  useEffect(() => {
    if (!target || !ready) return;
    const index = rows.findIndex((r) => r.kind === "message" && r.message.id === target.messageId);
    if (index >= 0) {
      arrive(index);
      setHighlighted(target.messageId);
      clearJump(key, target);
      return;
    }
    if (requested.current === target) return;
    requested.current = target;
    jumpToSeq(qc, channelId, conversationId, target.seq, threadRootId).then(
      () => {
        const t =
          threadRootId === undefined
            ? getTimeline(qc, channelId, conversationId)
            : getThread(qc, channelId, conversationId, threadRootId);
        if (t?.items.some((m) => m.id === target.messageId)) return;
        toast.info("메시지를 찾을 수 없습니다");
        clearJump(key, target);
      },
      (e: unknown) => {
        reportPageError(e);
        clearJump(key, target);
      },
    );
  }, [target, ready, timeline, rows, arrive, qc, channelId, conversationId, threadRootId, key]);

  useEffect(() => {
    if (highlighted === undefined) return;
    const id = setTimeout(() => setHighlighted(undefined), HIGHLIGHT_MS);
    return () => clearTimeout(id);
  }, [highlighted]);

  return { highlighted, pending: target !== undefined };
}

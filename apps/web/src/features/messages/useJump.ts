import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getThread, getTimeline } from "@/realtime/timelineCache";
import { useBundleExpansion } from "./bundleExpansion";
import { laneOfMessage } from "./bundles";
import type { Row } from "./groupRows";
import { jumpToSeq } from "./jump";
import { clearJump, HIGHLIGHT_MS, type JumpTarget, listKey, useJumpStore } from "./jumpTarget";
import type { Timeline } from "./timeline";
import { reportPageError } from "./useOlderPages";

/** 그 메시지를 그리는 행인가 — 메시지 행이거나, 그 메시지가 든 답 묶음 행(묶음 안 메시지는 루트 글 자리에 있다) */
export function rowHolds(row: Row, messageId: string): boolean {
  if (row.kind === "message") return row.message.id === messageId;
  if (row.kind === "bundle")
    return laneOfMessage(row.bundle, messageId) !== undefined || row.bundle.tailSystemIds.includes(messageId);
  return false;
}

/**
 * 이 목록의 결과로 가기(`jumpTarget`) — 그 메시지 행이 있으면 `arrive(행 번호)` 로 보내고 2초 강조, 없으면 around 로 받아
 * 갈아 끼운 뒤 다시 본다. 받은 것이 지금 것일 때만(`ready` — `useTimelineState`) 받는다: 그 전에 갈아 끼우면 뒤이은 다시 받기
 * (처음 구독·오프라인 사본 복원 뒤)가 최신 페이지로 덮는다.
 * `pending` 이면 목표가 남아 있다 — 목록은 첫 붙임(맨 아래로)을 하지 않는다. 목표가 초점을 바라면(`JumpTarget.focus`) 도착한 뒤
 * `focus` 에 그 메시지 id 를 내놓는다 — 목록이 그 행으로 초점을 옮기고 `focused()` 로 거둔다.
 * 목표가 답 묶음 안이면 그 묶음 행으로 가고 그 줄을 펼친다(`useBundleExpansion`) — 강조는 묶음 안의 그 메시지가 맡는다
 */
export function useJump(
  channelId: string,
  conversationId: string,
  threadRootId: string | undefined,
  timeline: Timeline | undefined,
  ready: boolean,
  rows: readonly Row[],
  arrive: (index: number) => void,
): { highlighted: string | undefined; pending: boolean; focus: string | undefined; focused: () => void } {
  const qc = useQueryClient();
  const key = listKey(conversationId, threadRootId);
  const target = useJumpStore((s) => s.targets[key]);
  const [highlighted, setHighlighted] = useState<string>();
  const [focus, setFocus] = useState<string>();
  const focused = useCallback(() => setFocus(undefined), []);
  /** 이미 around 로 받은 목표 — 받은 뒤에도 행이 없으면 되풀이하지 않는다 */
  const requested = useRef<JumpTarget | undefined>(undefined);

  useEffect(() => {
    if (!target || !ready) return;
    const index = rows.findIndex((r) => rowHolds(r, target.messageId));
    if (index >= 0) {
      const row = rows[index];
      if (row?.kind === "bundle") {
        const runId = laneOfMessage(row.bundle, target.messageId);
        if (runId !== undefined) useBundleExpansion.getState().set(runId, true);
      }
      arrive(index);
      setHighlighted(target.messageId);
      if (target.focus) setFocus(target.messageId);
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

  return { highlighted, pending: target !== undefined, focus, focused };
}

import type { RunEvent, RunState } from "@dodok/shared";
import { useRunStore } from "@/features/runs/runStore";
import { emitAck, type WireSocket } from "./wire";

export type RunReplay = ReturnType<typeof createRunReplay>;

/**
 * 런 이벤트 재생(`run.events.replay`)과 실시간 `run.event` 의 경합을 맡는다(web-t3 리뷰 Ruling).
 * 재생 ack 을 기다리는 동안 그 런의 실시간 이벤트는 버퍼에 모았다가, 재생을 반영한 뒤 `applyEvent` 로 흘린다 —
 * 재생 결과가 먼저 온 델타를 덮어쓰지 않게. 겹친 이벤트는 런 스토어의 seq 중복 제거가 한 번만 남긴다.
 */
export function createRunReplay(socket: WireSocket) {
  const held = new Map<string, { holders: number; events: RunEvent[] }>();

  function hold(runId: string): void {
    const h = held.get(runId) ?? { holders: 0, events: [] };
    h.holders += 1;
    held.set(runId, h);
  }
  function release(runId: string): void {
    const h = held.get(runId);
    if (!h || --h.holders > 0) return;
    held.delete(runId);
    const { applyEvent } = useRunStore.getState();
    for (const e of h.events) applyEvent(e);
  }

  return {
    /** 입장 때 activeRuns: 처음부터(afterSeq 0) 재생해 `applyReplay` 로 새로 쌓는다. 실패하면 모아 둔 것만 흘린다 */
    async fromStart(run: RunState): Promise<void> {
      hold(run.id);
      try {
        const replay = await emitAck(socket, "run.events.replay", { runId: run.id, afterSeq: 0 });
        useRunStore.getState().applyReplay(replay.run, replay.events);
      } catch {
        // 재생 실패는 버블 텍스트가 비는 것뿐 — 모아 둔 것과 다음 델타부터 쌓인다
      } finally {
        release(run.id);
      }
    },

    /**
     * `run.state { resync: true }`: 가진 것 뒤(afterSeq = lastEventSeq)를 재생해 이벤트마다 `applyEvent` 로 잇는다 —
     * `applyReplay` 는 처음부터 새로 쌓아 앞 텍스트를 잃는다(web-t3 보고). 부르기 전에 `applyState(run)` 이 되어 있어야 한다
     */
    async resync(run: RunState): Promise<void> {
      const afterSeq = useRunStore.getState().runs[run.id]?.lastEventSeq ?? 0;
      hold(run.id);
      try {
        const replay = await emitAck(socket, "run.events.replay", { runId: run.id, afterSeq });
        const { applyEvent } = useRunStore.getState();
        for (const e of replay.events) applyEvent(e);
      } catch {
        // 이어 받기 실패 — 다음 델타부터 쌓인다
      } finally {
        release(run.id);
      }
    },

    /** 실시간 `run.event`. 재생 중인 런이면 모으고, 아니면 곧바로 반영한다 */
    live(event: RunEvent): void {
      const h = held.get(event.runId);
      if (h) h.events.push(event);
      else useRunStore.getState().applyEvent(event);
    },
  };
}

import type { RunState } from "@dodok/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { qk } from "@/api/queries";
import { TERMINAL } from "@/features/runs/runStore";

/**
 * 채널 하나에 머무는 동안 기억하는 끝난 런의 최대 수(`ended`·`vanished` 각각). 넘으면 가장 먼저 넣은 것부터 버린다 —
 * 런 종료·재접속마다 자라기만 하던 기억의 상한이다. 버린 런은 REST 목록에 이미 있거나(재조회가 받아 왔다), 그만큼 옛 런이다
 */
export const SETTLED_RUNS_LIMIT = 200;

/** Map 삽입 순서로 가장 먼저 넣은 것부터 버린다. 버린 id 를 돌려준다(짝 기억에서 함께 지우게) */
function trim<V>(map: Map<string, V>, limit: number): string[] {
  const dropped: string[] = [];
  for (const id of map.keys()) {
    if (map.size <= limit) break;
    map.delete(id);
    dropped.push(id);
  }
  return dropped;
}

export type SettledRuns = {
  /** 종료 상태를 한 번이라도 본 런 — REST **위**에 깐다(이미 본 종료가 정본) */
  ended: ReadonlyMap<string, RunState>;
  /** 종료를 못 본 채 런 스토어에서 빠진 런의 마지막 상태 — REST **밑**에 깐다 */
  vanished: ReadonlyMap<string, RunState>;
  /** 빠진 것을 안 시각(ISO) — 그 줄의 소요를 거기서 멈춘다(`freezeDurations`) */
  stopped: ReadonlyMap<string, string>;
  /** 끝난 것으로 판정된 런 id 를 정렬해 이은 열쇠 — 바뀌면 부르는 쪽이 REST 목록을 다시 받는다 */
  settledKey: string;
};

/**
 * 활동 탭이 기억하는 끝난 런(브라우저 검증 D2·D9·D12, p2-t14 리뷰 §A.2). 채널을 옮기면 통째로 버리는 것은 부르는 쪽의
 * `key` 가 한다(훅이 새로 선다).
 *
 * - `ended` — 종료 상태를 한 번이라도 본 런. 끝난 런은 몇 초 뒤 런 스토어에서 빠지는데(버블 정리, 스펙 4.5) REST 재조회는
 *   그보다 늦다 — 그 사이 목록에서 사라지면 고른 런이 옛 런으로 넘어가고 타임라인이 새로 서서 펼침·스크롤이 날아간다.
 *   종료는 마지막 사실이라 남겨 둬도 낡지 않는다. 목록 조회가 실패해도 남는다.
 * - `vanished` — 종료를 **못 본 채** 빠진 런. 재접속 스냅샷은 「더는 진행 중이 아니다」만 말해 주고(`subscriptions.applySubscribed`)
 *   무엇으로 언제 끝났는지는 REST 가 안다. 마지막으로 본 상태를 REST 밑에 깔아 줄이 한 프레임도 비지 않게 하고, 재조회가 받아 온
 *   서버 사실이 그 자리를 덮는다. 종료를 본 런(버블 정리로 빠진 것)은 `ended` 가 맡는다.
 * - `stopped` — 빠진 것을 안 시각. 재조회가 실패하면 자리값이 남는데 소요까지 흐르면 「아직 기다리는 중」이라는 지어낸 사실이 되고
 *   1초 틱도 영원히 돈다. 다시 실시간으로 오면 더는 멈춘 줄이 아니다.
 *
 * 렌더 중에 적는다 — 효과로 미루면 한 프레임 동안 목록에서 빠져 선택이 튄다. 새로 빠진 런의 타임라인(`qk.runEvents`)도 다시 받는다 —
 * 끊긴 사이의 이벤트는 재생되지 않는다(`runReplay` 는 ack 의 `activeRuns` 만). **새로 빠진 id 만** 무효화한다
 */
export function useSettledRuns(live: readonly RunState[]): SettledRuns {
  const ended = useRef(new Map<string, RunState>());
  const vanished = useRef(new Map<string, RunState>());
  const stopped = useRef(new Map<string, string>());
  const wasLive = useRef(new Map<string, RunState>());
  const seenVanished = useRef(new Set<string>());

  const forget = (ids: readonly string[]) => {
    for (const id of ids) {
      stopped.current.delete(id);
      seenVanished.current.delete(id);
    }
  };

  for (const state of live) if (TERMINAL.has(state.status)) ended.current.set(state.id, state);
  forget(trim(ended.current, SETTLED_RUNS_LIMIT));

  const liveIds = new Set(live.map((s) => s.id));
  for (const [id, state] of wasLive.current)
    if (!liveIds.has(id) && !ended.current.has(id)) {
      vanished.current.set(id, state);
      stopped.current.set(id, new Date().toISOString());
    }
  for (const id of liveIds) stopped.current.delete(id);
  wasLive.current = new Map(live.map((s) => [s.id, s]));
  forget(trim(vanished.current, SETTLED_RUNS_LIMIT));

  const queryClient = useQueryClient();
  const vanishedKey = [...vanished.current.keys()].sort().join(",");
  useEffect(() => {
    for (const id of vanishedKey ? vanishedKey.split(",") : []) {
      if (seenVanished.current.has(id)) continue;
      seenVanished.current.add(id);
      void queryClient.invalidateQueries({ queryKey: qk.runEvents(id) });
    }
  }, [vanishedKey, queryClient]);

  return {
    ended: ended.current,
    vanished: vanished.current,
    stopped: stopped.current,
    settledKey: [...ended.current.keys(), ...vanished.current.keys()].sort().join(","),
  };
}

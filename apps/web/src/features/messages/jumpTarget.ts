import { create } from "zustand";

/** 결과로 가기가 도착한 메시지를 강조하는 시간(스레드·검색 스펙 5.3) */
export const HIGHLIGHT_MS = 2_000;

/** 목록 하나가 가야 할 메시지 — `seq` 는 가지지 않았을 때 around 로 받는 자리 */
export type JumpTarget = { messageId: string; seq: number };

/** 목록 하나의 이름 — 세션 목록이면 대화 id, 스레드 패널이면 대화 id·루트 id */
export const listKey = (conversationId: string, threadRootId?: string): string =>
  `${conversationId}:${threadRootId ?? ""}`;

type JumpState = { targets: Record<string, JumpTarget> };

/**
 * 가야 할 곳 — 목록(`listKey`)마다 하나. 검색 결과를 누르면 넣고, 그 목록이 그 메시지에 닿으면(또는 못 찾으면) 뺀다.
 * 채널을 옮기는 동안 목록이 새로 그려지므로 컴포넌트 상태가 아니라 스토어에 둔다
 */
export const useJumpStore = create<JumpState>(() => ({ targets: {} }));

/**
 * 검색 결과로 간다. 답글이면 세션 목록은 그 루트로(서버 around 가 답글 seq 를 루트 가운데로 둔다), 스레드 패널은 그 답글로.
 * 이전 목표는 버린다 — 마지막으로 누른 결과만 간다
 */
export function requestJump(hit: {
  conversationId: string;
  messageId: string;
  seq: number;
  threadRootId?: string;
}): void {
  const targets: Record<string, JumpTarget> = {
    [listKey(hit.conversationId)]: { messageId: hit.threadRootId ?? hit.messageId, seq: hit.seq },
  };
  if (hit.threadRootId !== undefined)
    targets[listKey(hit.conversationId, hit.threadRootId)] = { messageId: hit.messageId, seq: hit.seq };
  useJumpStore.setState({ targets });
}

/** 그 목록의 목표가 아직 이것이면 뺀다 — 그 사이 새로 누른 결과는 남긴다 */
export function clearJump(key: string, target: JumpTarget): void {
  useJumpStore.setState((s) => {
    if (s.targets[key] !== target) return s;
    const { [key]: _, ...rest } = s.targets;
    return { targets: rest };
  });
}

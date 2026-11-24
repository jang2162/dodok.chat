import { create } from "zustand";

/**
 * 답 묶음 줄(런 하나)을 사람이 펼쳤는가·접었는가 — 값이 없으면 자동 규칙(누를 수 있는 카드가 든 줄만 펼침)을 따른다(답 묶음 설계).
 * 사람이 누르면 `set` 으로 고정하고, 묶음 안으로 가기(결과로 가기·「답 도착」)도 `set(runId, true)` 로 연다. 목록이 다시 그려지거나
 * 채널을 오가도 남도록 컴포넌트 상태가 아니라 스토어에 둔다
 */
type BundleExpansion = {
  open: Record<string, boolean>;
  set(runId: string, open: boolean): void;
  reset(): void;
};

export const useBundleExpansion = create<BundleExpansion>()((set) => ({
  open: {},
  set: (runId, open) => set((s) => (s.open[runId] === open ? s : { open: { ...s.open, [runId]: open } })),
  reset: () => set({ open: {} }),
}));

import type { PresenceEntry } from "@dodok/shared";
import { create } from "zustand";
import { useMe } from "@/api/queries";

/**
 * 접속 점(프로필 스펙 3.3) — 서버가 계산한 유효 상태. wire 가 끊긴 동안은 마지막 값으로 두고, 다시 붙으면 스냅숏으로 통째로 맞춘다.
 * 키는 `<kind>:<id>`
 */
type PresenceState = {
  entries: Record<string, PresenceEntry>;
  /** 연결 직후(재접속 포함) — 통째로 바꾼다(사라진 줄은 지운다) */
  applySnapshot(entries: PresenceEntry[]): void;
  /** 바뀐 줄만 합친다 */
  applyChanged(entries: PresenceEntry[]): void;
};

const keyOf = (e: Pick<PresenceEntry, "kind" | "id">) => `${e.kind}:${e.id}`;

export const usePresenceStore = create<PresenceState>()((set) => ({
  entries: {},
  applySnapshot: (entries) => set({ entries: Object.fromEntries(entries.map((e) => [keyOf(e), e])) }),
  applyChanged: (entries) =>
    set((s) => ({ entries: { ...s.entries, ...Object.fromEntries(entries.map((e) => [keyOf(e), e])) } })),
}));

export function usePresence(kind: "user" | "agent", id: string): PresenceEntry | undefined {
  return usePresenceStore((s) => s.entries[keyOf({ kind, id })]);
}

/**
 * 점 하나에 필요한 것 — 남에게는 오프라인인 「오프라인으로 보이기」도 본인 화면에서는 그 이름으로 보인다(스펙 3.2)
 */
export function useDot(
  kind: "user" | "agent",
  id: string | undefined,
): { entry: PresenceEntry | undefined; selfInvisible: boolean } {
  const entry = usePresenceStore((s) => (id === undefined ? undefined : s.entries[keyOf({ kind, id })]));
  const me = useMe().data;
  const selfInvisible =
    kind === "user" && id !== undefined && me?.user.id === id && me.status?.mode === "invisible";
  return { entry, selfInvisible };
}

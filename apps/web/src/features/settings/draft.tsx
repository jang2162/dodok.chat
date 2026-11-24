import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * 채널 설정 패널의 초안 등록소(패널 재설계 스펙 목표 6). 저장 버튼이 있던 세 섹션(기본·채널 프롬프트·릴레이 정책)이 제 초안을 여기에
 * 올리고, 패널 아래 저장 막대(`SaveBar`)와 떠날 때 확인(`LeaveGuard`)이 그것을 모아 본다. 고르는 즉시 저장되는 칸(세션 정책·자동 응답·
 * 멤버 등)은 여기에 오지 않는다 — 저장 막대가 즉시 반영을 「저장해야 반영」으로 바꾸지 않게
 */
export type DraftKey = "basic" | "prompt" | "relay";

/**
 * 한 섹션의 초안. `changed` 는 서버 값과 다른 칸 수(0 이면 없는 것과 같다). `save` 는 실패하면 reject 한다 — 오류는 섹션이
 * 이미 제 안에 보였다(VALIDATION·CONFLICT) 또는 전역 토스트가 알렸다
 */
export type DraftEntry = { changed: number; save(): Promise<void>; reset(): void };

/** 저장 차례 — 기본(이름)이 먼저다 */
const ORDER: readonly DraftKey[] = ["basic", "prompt", "relay"];

type Registry = {
  counts: Partial<Record<DraftKey, number>>;
  setCount(key: DraftKey, n: number): void;
  /** 섹션의 최신 초안을 돌려주는 함수 — 렌더마다 새 객체라 상태가 아니라 ref 에 둔다 */
  handles: { current: Partial<Record<DraftKey, () => DraftEntry | null>> };
  saving: boolean;
  setSaving(on: boolean): void;
  /** 두 번 눌러도(Enter 반복·막대와 대화상자의 「저장」) 한 번만 보낸다 — `saving` 은 다음 렌더에야 바뀐다 */
  busy: { current: boolean };
};

const DraftContext = createContext<Registry | null>(null);

export function DraftProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<Partial<Record<DraftKey, number>>>({});
  const [saving, setSaving] = useState(false);
  const handles = useRef<Registry["handles"]["current"]>({});
  const busy = useRef(false);
  const setCount = useCallback(
    (key: DraftKey, n: number) =>
      setCounts((prev) => ((prev[key] ?? 0) === n ? prev : { ...prev, [key]: n })),
    [],
  );
  const value = useMemo(
    () => ({ counts, setCount, handles, saving, setSaving, busy }),
    [counts, setCount, saving],
  );
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

/** 섹션이 제 초안을 올린다. null(잠금·바뀐 것 없음)이면 빠진다. 등록소 밖(Provider 없음)이면 아무것도 하지 않는다 */
export function useRegisterDraft(key: DraftKey, entry: DraftEntry | null): void {
  const reg = useContext(DraftContext);
  const latest = useRef(entry);
  latest.current = entry;
  const changed = entry?.changed ?? 0;
  const handles = reg?.handles;
  const setCount = reg?.setCount;
  useEffect(() => {
    if (!handles || !setCount) return;
    handles.current[key] = () => latest.current;
    return () => {
      delete handles.current[key];
      setCount(key, 0);
    };
  }, [handles, setCount, key]);
  useEffect(() => setCount?.(key, changed), [setCount, key, changed]);
}

export function useDrafts(): {
  total: number;
  saving: boolean;
  saveAll(): Promise<boolean>;
  resetAll(): void;
} {
  const reg = useContext(DraftContext);
  if (!reg) throw new Error("useDrafts 는 DraftProvider 안에서만 쓴다");
  const { counts, handles, saving, setSaving, busy } = reg;
  const total = ORDER.reduce((n, key) => n + (counts[key] ?? 0), 0);

  /** 바뀐 섹션을 차례로 저장한다. 하나가 실패해도 나머지를 계속 — 성공한 섹션은 저장된 채로 남는다. 모두 성공이면 true */
  async function saveAll(): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    setSaving(true);
    let ok = true;
    try {
      for (const key of ORDER) {
        const entry = handles.current[key]?.();
        if (!entry || entry.changed === 0) continue;
        try {
          await entry.save();
        } catch {
          ok = false;
        }
      }
    } finally {
      busy.current = false;
      setSaving(false);
    }
    return ok;
  }

  function resetAll() {
    for (const key of ORDER) handles.current[key]?.()?.reset();
  }

  return { total, saving, saveAll, resetAll };
}

import { useSyncExternalStore } from "react";

/**
 * 넓은 화면 레이아웃의 기기별 저장값(UI 시안 04·06) — 왼쪽 사이드바·오른쪽 패널 너비, 사이드바 접힘, 마지막으로 고른 스레드 보기.
 * 한 키(`LAYOUT_KEY`)에 JSON 하나로 둔다. 좁은 화면(시트)은 이 값을 쓰지 않는다
 */
export const LAYOUT_KEY = "dodok.layout.v1";

export type Range = { min: number; max: number; initial: number };
export const SIDEBAR: Range = { min: 200, max: 420, initial: 260 };
export const PANEL: Range = { min: 320, max: 720, initial: 384 };
/** 가운데(머리·세션 목록·대화)가 지키는 최소 폭 — 창이 모자라면 오른쪽 패널부터 줄인다 */
export const MAIN_MIN = 420;
/** 사이드바를 이보다 좁게 끌면 접는다 — 최솟값에서 손을 조금 더 끌어야 접히게 */
export const COLLAPSE_AT = SIDEBAR.min - 40;
/** 키보드 ←/→ 한 번 */
export const KEY_STEP = 16;

export type ThreadView = "panel" | "main";
export type Layout = { sidebar: number; panel: number; collapsed: boolean; threadView: ThreadView };

const DEFAULTS: Layout = {
  sidebar: SIDEBAR.initial,
  panel: PANEL.initial,
  collapsed: false,
  threadView: "panel",
};

export const clamp = (value: number, r: Pick<Range, "min" | "max">): number =>
  Math.min(r.max, Math.max(r.min, Math.round(value)));

/** 저장값을 읽는다 — 없거나 망가졌으면(JSON 아님·숫자 아님·막힌 저장소) 그 칸만 기본값, 범위 밖이면 범위 안으로 */
export function readLayout(): Layout {
  let raw: unknown;
  try {
    const text = window.localStorage.getItem(LAYOUT_KEY);
    raw = text === null ? undefined : JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const num = (v: unknown, r: Range) =>
    typeof v === "number" && Number.isFinite(v) ? clamp(v, r) : r.initial;
  return {
    sidebar: num(o.sidebar, SIDEBAR),
    panel: num(o.panel, PANEL),
    collapsed: o.collapsed === true,
    threadView: o.threadView === "main" ? "main" : "panel",
  };
}

function writeLayout(layout: Layout): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // 개인 창·막힌 저장소 — 이번 탭에서만 유지된다
  }
}

/**
 * 탭 하나의 레이아웃 상태 — 사이드바(AppShell)와 패널(PanelTabs)이 서로 다른 나무에 있어 컴포넌트 상태가 아니라 모듈 스토어에 둔다.
 * `panelOpen` 은 저장하지 않는다(넓은 화면에 오른쪽 패널이 지금 그려져 있는가 — 사이드바가 가운데 최소 폭을 셀 때 쓴다)
 */
type State = Layout & { panelOpen: boolean };
let state: State = { ...DEFAULTS, panelOpen: false };
let loaded = false;
const listeners = new Set<() => void>();

function current(): State {
  if (!loaded) {
    loaded = true;
    state = { ...readLayout(), panelOpen: state.panelOpen };
  }
  return state;
}

function update(patch: Partial<State>, persist: boolean): void {
  const prev = current();
  const next = { ...prev, ...patch };
  const changed = (Object.keys(patch) as (keyof State)[]).some((k) => prev[k] !== next[k]);
  if (changed) {
    state = next;
    for (const l of listeners) l();
  }
  if (persist) {
    const { panelOpen: _, ...saved } = state;
    writeLayout(saved);
  }
}

export const layoutStore = {
  get: current,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /**
   * 끄는 동안 — 상태만. 범위 밖이면 범위 안으로, `COLLAPSE_AT` 아래면 접는다. 접을 때는 끌기 시작 때 너비(`start`)로 되돌려 둔다 —
   * 접히기 전에 최솟값을 지나오므로 그대로 두면 다시 펼 때 늘 최솟값이다
   */
  dragSidebar(raw: number, start: number) {
    if (raw < COLLAPSE_AT) update({ collapsed: true, sidebar: clamp(start, SIDEBAR) }, false);
    else update({ sidebar: clamp(raw, SIDEBAR), collapsed: false }, false);
  },
  dragPanel(raw: number, _start?: number) {
    update({ panel: clamp(raw, PANEL) }, false);
  },
  /** 놓을 때 저장한다 */
  commit() {
    update({}, true);
  },
  setSidebar(value: number) {
    update({ sidebar: clamp(value, SIDEBAR), collapsed: false }, true);
  },
  setPanel(value: number) {
    update({ panel: clamp(value, PANEL) }, true);
  },
  setCollapsed(collapsed: boolean) {
    update({ collapsed }, true);
  },
  setThreadView(threadView: ThreadView) {
    update({ threadView }, true);
  },
  setPanelOpen(panelOpen: boolean) {
    update({ panelOpen }, false);
  },
  /** 시험용 — 다음 읽기에서 저장소를 다시 읽는다 */
  reset() {
    loaded = false;
    state = { ...DEFAULTS, panelOpen: false };
    for (const l of listeners) l();
  },
};

export function useLayout(): State {
  return useSyncExternalStore(layoutStore.subscribe, current, current);
}

function subscribeResize(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

export function useViewportWidth(): number {
  return useSyncExternalStore(
    subscribeResize,
    () => window.innerWidth,
    () => 1280,
  );
}

/**
 * 그릴 너비 — 저장값은 두고 창에 맞춘다. 가운데가 `MAIN_MIN` 보다 좁아지면 오른쪽 패널부터 그 최솟값까지 줄이고, 그래도 모자라면
 * 사이드바를 그 최솟값까지. 둘 다 최솟값이면 가운데가 더 좁아진다(창이 아주 좁은 넓은 화면 — 768px 바로 위)
 */
export function fitWidths(
  viewport: number,
  { sidebar, panel, collapsed, panelOpen }: Pick<State, "sidebar" | "panel" | "collapsed" | "panelOpen">,
): { sidebar: number; panel: number } {
  const left = collapsed ? 0 : sidebar;
  const right = panelOpen ? Math.max(PANEL.min, Math.min(panel, viewport - left - MAIN_MIN)) : 0;
  const fitLeft = collapsed ? 0 : Math.max(SIDEBAR.min, Math.min(left, viewport - right - MAIN_MIN));
  return { sidebar: fitLeft, panel: panelOpen ? right : panel };
}

/** 넓은 화면에서 지금 그릴 두 너비 */
export function useLayoutWidths(): State & { drawn: { sidebar: number; panel: number } } {
  const layout = useLayout();
  const viewport = useViewportWidth();
  return { ...layout, drawn: fitWidths(viewport, layout) };
}

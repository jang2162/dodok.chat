import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COLLAPSE_AT,
  LAYOUT_KEY,
  PANEL,
  SIDEBAR,
  clamp,
  fitWidths,
  layoutStore,
  readLayout,
} from "./useLayoutWidths";

afterEach(() => {
  window.localStorage.clear();
  layoutStore.reset();
  vi.restoreAllMocks();
});

const saved = () => JSON.parse(window.localStorage.getItem(LAYOUT_KEY) ?? "null") as unknown;
const store = (value: unknown) => window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(value));

describe("readLayout — 기기별 저장값", () => {
  it("없으면 기본값 — 왼쪽 260, 오른쪽 384, 펼침, 패널 보기", () => {
    expect(readLayout()).toEqual({ sidebar: 260, panel: 384, collapsed: false, threadView: "panel" });
  });

  it("범위 밖이면 범위 안으로 — 왼쪽 200–420, 오른쪽 320–720", () => {
    store({ sidebar: 1000, panel: 10 });
    expect(readLayout()).toMatchObject({ sidebar: 420, panel: 320 });
    store({ sidebar: 50, panel: 9999 });
    expect(readLayout()).toMatchObject({ sidebar: 200, panel: 720 });
  });

  it("망가진 값은 그 칸만 기본값 — JSON 아님·숫자 아님·모르는 보기", () => {
    window.localStorage.setItem(LAYOUT_KEY, "{not json");
    expect(readLayout()).toEqual({ sidebar: 260, panel: 384, collapsed: false, threadView: "panel" });
    store({ sidebar: "300", panel: 500, collapsed: "yes", threadView: "split" });
    expect(readLayout()).toEqual({ sidebar: 260, panel: 500, collapsed: false, threadView: "panel" });
    store([1, 2]);
    expect(readLayout()).toMatchObject({ sidebar: 260, panel: 384 });
  });

  it("저장소가 막혀 있어도(읽기·쓰기가 던진다) 기본값으로 돌고, 바꾼 값은 이 탭에 남는다", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(layoutStore.get()).toMatchObject({ sidebar: 260, panel: 384 });
    expect(() => layoutStore.setSidebar(300)).not.toThrow();
    expect(layoutStore.get().sidebar).toBe(300);
  });
});

describe("layoutStore", () => {
  it("저장한 값을 다음에 읽는다(복원)", () => {
    store({ sidebar: 333, panel: 555, collapsed: true, threadView: "main" });
    layoutStore.reset();
    expect(layoutStore.get()).toMatchObject({
      sidebar: 333,
      panel: 555,
      collapsed: true,
      threadView: "main",
    });
  });

  it("끄는 동안은 상태만, 놓을 때(commit) 저장한다", () => {
    layoutStore.dragSidebar(300, 260);
    layoutStore.dragPanel(500);
    expect(layoutStore.get()).toMatchObject({ sidebar: 300, panel: 500 });
    expect(saved()).toBeNull();
    layoutStore.commit();
    expect(saved()).toEqual({ sidebar: 300, panel: 500, collapsed: false, threadView: "panel" });
  });

  it("끄는 값도 범위 안으로 — 넘겨 끌면 끝에서 멈춘다", () => {
    layoutStore.dragSidebar(999, 260);
    expect(layoutStore.get().sidebar).toBe(SIDEBAR.max);
    layoutStore.dragSidebar(COLLAPSE_AT + 1, 260);
    expect(layoutStore.get()).toMatchObject({ sidebar: SIDEBAR.min, collapsed: false });
    layoutStore.dragPanel(0);
    expect(layoutStore.get().panel).toBe(PANEL.min);
    layoutStore.dragPanel(5000);
    expect(layoutStore.get().panel).toBe(PANEL.max);
  });

  it("왼쪽을 최소보다 더 끌면 접힌다 — 지나온 최솟값이 아니라 끌기 시작 때 너비를 남기고, 다시 끌어 나오면 펼친다", () => {
    layoutStore.setSidebar(300);
    // 실제 끌기처럼 최솟값을 지나 접힌다
    layoutStore.dragSidebar(SIDEBAR.min, 300);
    layoutStore.dragSidebar(COLLAPSE_AT - 1, 300);
    expect(layoutStore.get()).toMatchObject({ collapsed: true, sidebar: 300 });
    layoutStore.dragSidebar(250, 300);
    expect(layoutStore.get()).toMatchObject({ collapsed: false, sidebar: 250 });
  });

  it("panelOpen 은 저장하지 않는다", () => {
    layoutStore.setPanelOpen(true);
    layoutStore.setThreadView("main");
    expect(saved()).toEqual({ sidebar: 260, panel: 384, collapsed: false, threadView: "main" });
  });
});

describe("fitWidths — 가운데 최소 420px", () => {
  const base = { sidebar: 260, panel: 384, collapsed: false, panelOpen: true };

  it("넉넉하면 저장값 그대로", () => {
    expect(fitWidths(1440, base)).toEqual({ sidebar: 260, panel: 384 });
  });

  it("모자라면 오른쪽부터 줄인다 — 1024px 이면 패널 344, 사이드바는 그대로", () => {
    expect(fitWidths(1024, base)).toEqual({ sidebar: 260, panel: 1024 - 260 - 420 });
  });

  it("패널이 최소(320)에 닿은 뒤에야 사이드바를 줄인다 — 둘 다 최소면 더 줄이지 않는다", () => {
    expect(fitWidths(960, base)).toEqual({ sidebar: 960 - 320 - 420, panel: 320 });
    expect(fitWidths(800, base)).toEqual({ sidebar: 200, panel: 320 });
  });

  it("패널이 닫혀 있으면 사이드바만 센다 · 접혀 있으면 사이드바는 0", () => {
    expect(fitWidths(900, { ...base, sidebar: 420, panelOpen: false })).toMatchObject({ sidebar: 420 });
    expect(fitWidths(1024, { ...base, collapsed: true })).toEqual({ sidebar: 0, panel: 384 });
  });

  it("clamp 는 반올림해 범위 안으로", () => {
    expect(clamp(260.6, SIDEBAR)).toBe(261);
    expect(clamp(-5, PANEL)).toBe(320);
  });
});

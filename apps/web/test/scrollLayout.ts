/**
 * jsdom 은 배치를 계산하지 않는다 — 가상 목록(TanStack Virtual) 테스트용으로 스크롤 영역 하나의 크기·스크롤을 흉내 낸다.
 * - 스크롤 영역(`[data-scroller]`): offsetWidth·offsetHeight·clientHeight 는 뷰포트, scrollHeight 는 첫 자식(전체 크기 div)의 style.height
 * - 가상 행(`[data-index]`): offsetHeight = rowHeight(함수로 주면 잴 때마다 물어본다 — 붙은 뒤에 높이가 바뀌는 길)
 * - scrollTop 은 [0, scrollHeight − clientHeight] 로 자르고, 바뀌면 브라우저처럼 다음 틱에 `scroll` 이벤트를 낸다. scrollTo 도 같다
 * 돌려주는 함수로 원래 속성을 되돌린다
 */
export function stubScrollLayout({
  width = 800,
  height = 600,
  rowHeight = 64,
}: { width?: number; height?: number; rowHeight?: number | (() => number) } = {}): () => void {
  const proto = HTMLElement.prototype;
  const keys = [
    "offsetWidth",
    "offsetHeight",
    "clientHeight",
    "scrollHeight",
    "scrollTop",
    "scrollTo",
  ] as const;
  const saved = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)]));
  const tops = new WeakMap<HTMLElement, number>();
  const rowSize = typeof rowHeight === "function" ? rowHeight : () => rowHeight;

  const isScroller = (el: HTMLElement) => el.hasAttribute("data-scroller");
  const isRow = (el: HTMLElement) => el.hasAttribute("data-index");
  const contentHeight = (el: HTMLElement) =>
    Number.parseFloat((el.firstElementChild as HTMLElement | null)?.style.height ?? "") || 0;
  const maxTop = (el: HTMLElement) => Math.max(0, contentHeight(el) - height);
  const setTop = (el: HTMLElement, value: number) => {
    const next = Math.min(Math.max(0, Math.round(value)), maxTop(el));
    if (next === (tops.get(el) ?? 0)) return;
    tops.set(el, next);
    setTimeout(() => el.dispatchEvent(new Event("scroll")), 0);
  };

  const getter = (fn: (el: HTMLElement) => number) => ({
    configurable: true,
    get(this: HTMLElement) {
      return fn(this);
    },
  });
  Object.defineProperties(proto, {
    offsetWidth: getter((el) => (isScroller(el) ? width : 0)),
    offsetHeight: getter((el) => (isScroller(el) ? height : isRow(el) ? rowSize() : 0)),
    clientHeight: getter((el) => (isScroller(el) ? height : 0)),
    scrollHeight: getter((el) => (isScroller(el) ? Math.max(contentHeight(el), height) : 0)),
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) {
        return tops.get(this) ?? 0;
      },
      set(this: HTMLElement, value: number) {
        setTop(this, value);
      },
    },
    scrollTo: {
      configurable: true,
      writable: true,
      value(this: HTMLElement, a?: ScrollToOptions | number, b?: number) {
        const top = typeof a === "number" ? b : a?.top;
        if (top !== undefined) setTop(this, top);
      },
    },
  });

  const restoreObserver = stubRowResizeObserver();
  return () => {
    restoreObserver();
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d);
      else delete (proto as unknown as Record<string, unknown>)[k];
    }
  };
}

type RowObserver = { cb: ResizeObserverCallback; targets: Set<Element> };
let rowObservers: RowObserver[] = [];

/**
 * 가상 행만 보는 ResizeObserver — 브라우저에서 행이 붙은 뒤에 다시 재어지는 길이다(본문·글꼴이 늦게 자리 잡을 때).
 * jsdom 기본 스텁은 아무것도 알리지 않아 그 길이 아예 없다. 언제 알릴지는 테스트가 `remeasureRows()` 로 정한다.
 * 행이 아닌 것(Radix 의 useSize 등)은 관찰만 받고 무시한다 — 다른 테스트의 동작을 바꾸지 않는다
 */
function stubRowResizeObserver(): () => void {
  const previous = globalThis.ResizeObserver;
  const outer = rowObservers;
  rowObservers = [];
  class RowResizeObserver {
    private readonly entry: RowObserver = { cb: () => {}, targets: new Set() };
    constructor(cb: ResizeObserverCallback) {
      this.entry.cb = cb;
      rowObservers.push(this.entry);
    }
    observe(target: Element) {
      if (target instanceof HTMLElement && target.hasAttribute("data-index")) this.entry.targets.add(target);
    }
    unobserve(target: Element) {
      this.entry.targets.delete(target);
    }
    disconnect() {
      this.entry.targets.clear();
      rowObservers = rowObservers.filter((o) => o !== this.entry);
    }
  }
  globalThis.ResizeObserver = RowResizeObserver as unknown as typeof ResizeObserver;
  return () => {
    rowObservers = outer;
    globalThis.ResizeObserver = previous;
  };
}

/** 지금 붙어 있는 가상 행을 다시 재게 한다 — ResizeObserver 알림 한 번 */
export function remeasureRows(): void {
  for (const { cb, targets } of rowObservers) {
    const entries = [...targets]
      .filter((t) => t.isConnected)
      .map((target) => ({ target }) as ResizeObserverEntry);
    if (entries.length > 0) cb(entries, {} as ResizeObserver);
  }
}

/**
 * jsdom 은 배치를 계산하지 않는다 — 가상 목록(TanStack Virtual) 테스트용으로 스크롤 영역 하나의 크기·스크롤을 흉내 낸다.
 * - 스크롤 영역(`[data-scroller]`): offsetWidth·offsetHeight·clientHeight 는 뷰포트, scrollHeight 는 첫 자식(전체 크기 div)의 style.height
 * - 가상 행(`[data-index]`): offsetHeight = rowHeight
 * - scrollTop 은 [0, scrollHeight − clientHeight] 로 자르고, 바뀌면 브라우저처럼 다음 틱에 `scroll` 이벤트를 낸다. scrollTo 도 같다
 * 돌려주는 함수로 원래 속성을 되돌린다
 */
export function stubScrollLayout({ width = 800, height = 600, rowHeight = 64 } = {}): () => void {
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
    offsetHeight: getter((el) => (isScroller(el) ? height : isRow(el) ? rowHeight : 0)),
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

  return () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d);
      else delete (proto as unknown as Record<string, unknown>)[k];
    }
  };
}

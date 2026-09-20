import { act } from "@testing-library/react";
import { vi } from "vitest";

/** 좁은 화면 쿼리(`useIsNarrow`) */
export const NARROW_QUERY = "(max-width: 767px)";

/**
 * `matchMedia` 를 폭을 바꿀 수 있는 스텁으로(afterEach 의 `vi.restoreAllMocks()` 가 되돌린다).
 * `setNarrow` 는 값을 바꾸고 구독자에게 change 를 알린다 — 창 폭이 바뀐 것처럼. `listeners()` 는 지금 구독 수
 */
export function stubMedia(initialNarrow: boolean) {
  let narrow = initialNarrow;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string): MediaQueryList =>
      ({
        get matches() {
          return query === NARROW_QUERY && narrow;
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, l: EventListenerOrEventListenerObject) => listeners.add(l),
        removeEventListener: (_type: string, l: EventListenerOrEventListenerObject) => listeners.delete(l),
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
  return {
    setNarrow(next: boolean) {
      narrow = next;
      act(() => {
        for (const l of new Set(listeners)) {
          const event = new Event("change");
          if (typeof l === "function") l(event);
          else l.handleEvent(event);
        }
      });
    },
    listeners: () => listeners.size,
  };
}

import { vi } from "vitest";

type Patch = [target: object, key: string, value: unknown];

/**
 * Tiptap·ProseMirror·@tiptap/suggestion(Floating UI) 가 jsdom 에서 요구하는 레이아웃 API 스텁 — 부르는 테스트 파일에서만 켠다
 * (공용 setup.ts 에 두지 않는다). jsdom 은 레이아웃이 없어 모두 0 크기로 답한다.
 * 돌려주는 함수가 원래대로 되돌린다(관찰자 전역은 `vi.unstubAllGlobals()`)
 */
export function stubEditorDom(): () => void {
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal("IntersectionObserver", Observer);

  const patches: Patch[] = [
    [Range.prototype, "getBoundingClientRect", () => new DOMRect(0, 0, 0, 0)],
    [Range.prototype, "getClientRects", () => []],
    [Document.prototype, "elementFromPoint", () => null],
  ];
  const saved = patches.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key));
  for (const [target, key, value] of patches) {
    Object.defineProperty(target, key, { value, configurable: true, writable: true });
  }
  return () => {
    patches.forEach(([target, key], i) => {
      const d = saved[i];
      if (d) Object.defineProperty(target, key, d);
      else delete (target as Record<string, unknown>)[key];
    });
  };
}

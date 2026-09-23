import { vi } from "vitest";

/** IndexedDB 대신 — jsdom 에는 없다. `startPersistence` 에 주입하고 저장된 문자열을 그대로 들여다본다 */
export function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: vi.fn(async (k: string) => map.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      map.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      map.delete(k);
    }),
  };
}

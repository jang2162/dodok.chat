import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { createdSockets } from "./fakeSocket";

// jsdom 에는 matchMedia 가 없다 — Toaster(theme="system")와 prefers-* 확인이 부른다. 늘 불일치(라이트·모션 허용)로 답한다
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

// jsdom 의 scrollTo 는 「Not implemented」만 찍는다 — 라우터의 스크롤 복원이 이동마다 부른다
window.scrollTo = () => {};

afterEach(() => cleanup());

// 테스트는 실제 소켓을 열지 않는다(네트워크 없음) — createWireSocket 은 가짜 소켓을 만들어 createdSockets 에 남긴다.
// createWireSocket 자체를 재는 wire.test.ts 는 vi.unmock 으로 원래 모듈을 쓴다
vi.mock("@/realtime/wire", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/realtime/wire")>();
  const { createFakeSocket, createdSockets } = await import("./fakeSocket");
  return {
    ...actual,
    createWireSocket: () => {
      const fake = createFakeSocket();
      createdSockets.push(fake);
      return fake.wire;
    },
  };
});
afterEach(() => {
  createdSockets.length = 0;
});

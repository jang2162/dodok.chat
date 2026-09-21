import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { resetNowTick } from "@/hooks/useNowTick";
import { createdSockets } from "./fakeSocket";

// findBy*·waitFor 의 기본 예산은 1초다. 루트 `pnpm test` 는 패키지 다섯을 한꺼번에 돌리고 vitest 는 저마다
// 코어−1 개의 워커를 띄우므로 코어 수의 몇 배가 동시에 돈다 — 앱 셸을 통째로 띄우는 테스트의 첫 렌더가
// 그 1초를 넘겨(웹 단독이면 수십 ms) 실행마다 다른 조합이 「Unable to find …」로 무너졌다.
// 기다리는 조건은 그대로 두고 예산만 늘린다 — 단언은 그대로이고, 없는 것은 여전히 없다고 실패한다
configure({ asyncUtilTimeout: 5000 });

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

// jsdom 에는 ResizeObserver 가 없다 — Radix Switch·Checkbox(useSize)가 부른다. 관찰만 받고 아무것도 알리지 않는다.
// 테스트가 vi.stubGlobal 로 바꿨다가 vi.unstubAllGlobals() 하면 이 값으로 돌아온다
if (typeof globalThis.ResizeObserver !== "function") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(() => {
  cleanup();
  // 공용 시계는 모듈 전역이다 — 언마운트가 못 거둔 구독자(RTL 밖 렌더)까지 비워 다음 테스트가 새 시계로 시작하게
  resetNowTick();
});

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

import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showUpdateToast, startPwa } from "./register";

vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

// jsdom 에는 navigator.serviceWorker 가 없다 — 있는 브라우저를 흉내 낼 때만 잠깐 세운다
const savedServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
afterEach(() => {
  if (savedServiceWorker) Object.defineProperty(navigator, "serviceWorker", savedServiceWorker);
  else Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("startPwa", () => {
  it("대기 중인 새 버전이 있어도 스스로 새로고침하지 않고 onNeedRefresh 로 넘긴다 [Review Focus 5]", async () => {
    Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true });
    const updateSW = vi.fn(async () => {});
    let captured: { onNeedRefresh?: () => void } = {};
    const register = vi.fn((o: { onNeedRefresh?: () => void }) => {
      captured = o;
      return updateSW;
    });
    const onNeedRefresh = vi.fn();
    startPwa({ onNeedRefresh, register: register as never });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ immediate: true }));
    captured.onNeedRefresh?.();
    expect(onNeedRefresh).toHaveBeenCalledTimes(1);
    expect(updateSW).not.toHaveBeenCalled(); // 누르기 전에는 바꾸지 않는다
    const update = onNeedRefresh.mock.calls[0]?.[0] as () => Promise<void>;
    await update();
    expect(updateSW).toHaveBeenCalledWith(true); // skipWaiting + 새로고침
  });

  it("serviceWorker 가 없는 환경에서는 아무것도 하지 않는다", () => {
    const register = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true });
    startPwa({ onNeedRefresh: vi.fn(), register: register as never });
    expect(register).not.toHaveBeenCalled();
  });
});

describe("showUpdateToast", () => {
  it("누를 때까지 사라지지 않는 토스트 하나를 띄우고, 「새로고침」이 update 를 부른다 (결정 7)", () => {
    const update = vi.fn(async () => {});
    showUpdateToast(update);
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith("새 버전이 있습니다", {
      id: "pwa-update",
      duration: Number.POSITIVE_INFINITY, // 기본 4초면 새 버전 알림을 놓친다
      action: { label: "새로고침", onClick: expect.any(Function) },
    });
    expect(update).not.toHaveBeenCalled();
    const action = vi.mocked(toast.info).mock.calls[0]?.[1]?.action as { onClick(e: unknown): void };
    action.onClick({});
    expect(update).toHaveBeenCalledTimes(1);
  });
});

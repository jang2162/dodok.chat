import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureInstallPrompt, isIos, isStandalone, useInstallPrompt } from "./install";

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  ipad13:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
};

function stubNavigator(p: { ua: string; touch?: number; standalone?: boolean }) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(p.ua);
  // jsdom 의 navigator 에는 maxTouchPoints 가 없다
  Object.defineProperty(navigator, "maxTouchPoints", { value: p.touch ?? 0, configurable: true });
  if (p.standalone !== undefined)
    Object.defineProperty(navigator, "standalone", { value: p.standalone, configurable: true });
}

function stubDisplayMode(standalone: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({ matches: standalone && q === "(display-mode: standalone)", media: q }) as MediaQueryList,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (navigator as unknown as Record<string, unknown>).standalone;
  delete (navigator as unknown as Record<string, unknown>).maxTouchPoints;
});

describe("isIos", () => {
  it("iPhone·iPadOS(맥으로 소개하지만 터치) 는 iOS, 맥·안드로이드는 아니다", () => {
    stubNavigator({ ua: UA.iphone, touch: 5 });
    expect(isIos()).toBe(true);
    stubNavigator({ ua: UA.ipad13, touch: 5 });
    expect(isIos()).toBe(true);
    stubNavigator({ ua: UA.mac, touch: 0 });
    expect(isIos()).toBe(false);
    stubNavigator({ ua: UA.android, touch: 5 });
    expect(isIos()).toBe(false);
  });
});

describe("isStandalone", () => {
  it("display-mode: standalone 이거나 navigator.standalone(iOS)", () => {
    stubDisplayMode(false);
    expect(isStandalone()).toBe(false);
    stubDisplayMode(true);
    expect(isStandalone()).toBe(true);
    stubDisplayMode(false);
    stubNavigator({ ua: UA.iphone, standalone: true });
    expect(isStandalone()).toBe(true);
  });
});

describe("useInstallPrompt", () => {
  it("beforeinstallprompt 를 받으면 설치할 수 있고, 누르면 prompt 한 번 뒤 숨는다", async () => {
    stubDisplayMode(false);
    captureInstallPrompt();
    captureInstallPrompt(); // 두 번 불러도 한 번만 건다
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.canInstall).toBe(false);

    const prompt = vi.fn(async () => {});
    const e = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    });
    act(() => void window.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true);
    expect(result.current.canInstall).toBe(true);

    await act(() => result.current.install());
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result.current.canInstall).toBe(false);
  });

  it("설치해 연 앱이면 이벤트가 있어도 버튼이 없고, appinstalled 면 사라진다", () => {
    captureInstallPrompt();
    stubDisplayMode(true);
    const e = Object.assign(new Event("beforeinstallprompt"), {
      prompt: async () => {},
      userChoice: Promise.resolve({ outcome: "dismissed" as const }),
    });
    const { result, rerender } = renderHook(() => useInstallPrompt());
    act(() => void window.dispatchEvent(e));
    expect(result.current.canInstall).toBe(false);
    stubDisplayMode(false);
    rerender();
    expect(result.current.canInstall).toBe(true);
    act(() => void window.dispatchEvent(new Event("appinstalled")));
    expect(result.current.canInstall).toBe(false);
  });
});

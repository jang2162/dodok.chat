import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach, expect, it, vi } from "vitest";
import { CH } from "../../test/fixtures";
import { createApp } from "./createApp";

type Listener = (e: MessageEvent) => void;

/** navigator.serviceWorker 의 message 리스너만 — 서비스 워커가 알림 누르기에서 보내는 것 */
function stubServiceWorkerMessages() {
  const listeners = new Set<Listener>();
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      addEventListener: (type: string, fn: Listener) => type === "message" && listeners.add(fn),
      removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
    },
  });
  return {
    post: (data: unknown) => {
      for (const fn of listeners) fn(new MessageEvent("message", { data }));
    },
  };
}

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  vi.restoreAllMocks();
});

it("[Review Focus 4] 서비스 워커의 navigate 메시지는 라우터로 옮긴다 — 같은 출처 채널 경로만", async () => {
  const sw = stubServiceWorkerMessages();
  const history = createMemoryHistory({ initialEntries: ["/agents"] });
  const app = createApp(history);

  sw.post({ type: "navigate", url: `/c/${CH}/activity` });
  await vi.waitFor(() => expect(history.location.pathname).toBe(`/c/${CH}/activity`));

  sw.post({ type: "navigate", url: "https://evil.example/c/x" });
  await vi.waitFor(() => expect(history.location.pathname).toBe("/"));

  // 다른 종류의 메시지는 무시한다
  sw.post({ type: "other", url: `/c/${CH}` });
  sw.post(null);
  await new Promise((r) => setTimeout(r, 10));
  expect(history.location.pathname).toBe("/");
  expect(app.router).toBeDefined();
});

it("서비스 워커가 없는 브라우저에서도 만들어진다", () => {
  expect(() => createApp(createMemoryHistory({ initialEntries: ["/"] }))).not.toThrow();
});

it("notify.onLocationChange 는 경로가 바뀔 때마다 부르고, 해제하면 멈춘다", async () => {
  const history = createMemoryHistory({ initialEntries: ["/agents"] });
  const app = createApp(history);
  const seen: Array<string | undefined> = [];
  const off = app.notify.onLocationChange?.(() => seen.push(app.notify.currentChannelId()));
  await app.router.navigate({
    to: "/c/$channelId/s/$conversationId",
    params: { channelId: CH, conversationId: CH },
  });
  await vi.waitFor(() => expect(seen.at(-1)).toBe(CH));
  off?.();
  const n = seen.length;
  await app.router.navigate({ to: "/agents" });
  expect(seen).toHaveLength(n);
});

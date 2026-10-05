import { describe, expect, it, vi } from "vitest";
import { NavigationRoute } from "workbox-routing";
import { CH } from "../../test/fixtures";
import {
  focusAndNavigate,
  NAVIGATION_DENYLIST,
  notificationFromPush,
  pickClient,
  safeNotificationUrl,
  urlBase64ToUint8Array,
} from "./sw-logic";

describe("safeNotificationUrl", () => {
  it("같은 출처 상대 채널 경로만", () => {
    expect(safeNotificationUrl(`/c/${CH}`)).toBe(`/c/${CH}`);
    expect(safeNotificationUrl(`/c/${CH}/activity`)).toBe(`/c/${CH}/activity`);
    // 스레드 멘션·스레드 안 릴레이 한도(스레드·검색 스펙 4.2) — 누르면 그 스레드
    expect(safeNotificationUrl(`/c/${CH}/t/${CH}`)).toBe(`/c/${CH}/t/${CH}`);
    for (const bad of [
      "https://evil.example/c/x",
      `https://evil.example/c/${CH}`,
      "//evil.example",
      `//evil.example/c/${CH}`,
      `/c/${CH}/../../x`,
      `/c/${CH}/activity/../../x`,
      `/c/${CH}?x=1`,
      `/c/${CH}#x`,
      `/c/${CH}/settings`,
      `/c/${CH}/t/nope`,
      `/c/${CH}/t/`,
      `/c/${CH}/t/${CH}/x`,
      `/c/${CH}/t/${CH}?x=1`,
      `/c/${CH}/activity/t/${CH}`,
      `/\\evil.example/c/${CH}`,
      "/c/nope",
      "javascript:alert(1)",
      3,
      undefined,
      null,
    ])
      expect(safeNotificationUrl(bad)).toBe("/");
  });
});

describe("notificationFromPush", () => {
  it("옳은 페이로드 — 승인은 다시 울린다", () => {
    expect(
      notificationFromPush({
        kind: "approval",
        channelId: CH,
        title: "dodok",
        body: "#p에 승인 요청이 있습니다",
        url: `/c/${CH}/activity`,
        tag: "approval:x",
      }),
    ).toEqual({
      title: "dodok",
      options: {
        body: "#p에 승인 요청이 있습니다",
        tag: "approval:x",
        data: { url: `/c/${CH}/activity` },
        renotify: true,
      },
    });
  });

  it("멘션은 다시 울리지 않는다", () => {
    const n = notificationFromPush({
      kind: "mention",
      channelId: CH,
      title: "dodok",
      body: "@dev가 #p에서 불렀습니다",
      url: `/c/${CH}`,
      tag: `mention:${CH}`,
    });
    expect(n.options).toEqual({
      body: "@dev가 #p에서 불렀습니다",
      tag: `mention:${CH}`,
      data: { url: `/c/${CH}` },
    });
  });

  it("페이로드 url 이 바깥이면 / 로 — 파싱은 통과해도 서비스 워커가 다시 거른다", () => {
    const n = notificationFromPush({
      kind: "mention",
      channelId: CH,
      title: "dodok",
      body: "b",
      url: "https://evil.example/c/x",
      tag: "t",
    });
    expect(n.options.data.url).toBe("/");
  });

  it("tag 가 비면 tag·renotify 를 싣지 않는다 — renotify 는 tag 없이 쓰면 showNotification 이 던진다", () => {
    const n = notificationFromPush({
      kind: "approval",
      channelId: CH,
      title: "dodok",
      body: "b",
      url: "/",
      tag: "",
    });
    expect(n.options).toEqual({ body: "b", data: { url: "/" } });
  });

  it("파싱 실패는 「dodok — 새 알림」, url /", () => {
    const fallback = { title: "dodok — 새 알림", options: { body: "", data: { url: "/" } } };
    expect(notificationFromPush("garbage")).toEqual(fallback);
    expect(notificationFromPush(undefined)).toEqual(fallback);
    expect(
      notificationFromPush({ kind: "mention", channelId: "x", title: "t", body: "b", url: "/", tag: "t" }),
    ).toEqual(fallback);
    expect(
      notificationFromPush({ kind: "other", channelId: CH, title: "t", body: "b", url: "/", tag: "t" }),
    ).toEqual(fallback);
  });
});

describe("pickClient", () => {
  const O = "http://localhost:5180";
  it("보이는 창 → 포커스 창 → 첫 창, 다른 출처는 빼고", () => {
    expect(pickClient([{ url: "http://x/", visibilityState: "visible", focused: true }], O)).toBe(-1);
    expect(pickClient([], O)).toBe(-1);
    expect(
      pickClient(
        [
          { url: `${O}/c/a`, visibilityState: "hidden", focused: false },
          { url: `${O}/c/b`, visibilityState: "visible", focused: false },
        ],
        O,
      ),
    ).toBe(1);
    expect(pickClient([{ url: `${O}/`, visibilityState: "hidden", focused: false }], O)).toBe(0);
    expect(
      pickClient(
        [
          { url: "https://evil.example/", visibilityState: "visible", focused: true },
          { url: `${O}/c/a`, visibilityState: "hidden", focused: false },
          { url: `${O}/c/b`, visibilityState: "hidden", focused: true },
        ],
        O,
      ),
    ).toBe(2);
    expect(
      pickClient(
        [
          { url: `${O}/c/a`, visibilityState: "visible", focused: false },
          { url: `${O}/c/b`, visibilityState: "visible", focused: true },
        ],
        O,
      ),
    ).toBe(1);
  });

  it("보이는 창도 포커스 창도 없으면 가장 최근 창(matchAll 순서의 첫 같은 출처 창)", () => {
    expect(
      pickClient(
        [
          { url: "https://evil.example/", visibilityState: "hidden", focused: false },
          { url: `${O}/c/a`, visibilityState: "hidden", focused: false },
          { url: `${O}/c/b`, visibilityState: "hidden", focused: false },
          { url: `${O}/c/c`, visibilityState: "hidden", focused: false },
        ],
        O,
      ),
    ).toBe(1);
  });

  it("주소가 URL 이 아니면 그 창은 뺀다", () => {
    expect(pickClient([{ url: "::", visibilityState: "visible", focused: true }], O)).toBe(-1);
  });
});

describe("focusAndNavigate", () => {
  it("창을 앞으로 가져온 뒤 그 자리로 옮긴다", async () => {
    const order: string[] = [];
    const client = {
      focus: vi.fn(async () => void order.push("focus")),
      postMessage: vi.fn(() => void order.push("navigate")),
    };
    await focusAndNavigate(client, `/c/${CH}`);
    expect(order).toEqual(["focus", "navigate"]);
    expect(client.postMessage).toHaveBeenCalledWith({ type: "navigate", url: `/c/${CH}` });
  });

  it("focus 가 거절돼도(InvalidAccessError 등) 이동은 보낸다", async () => {
    const client = {
      focus: vi.fn(() =>
        Promise.reject(new DOMException("Not allowed to focus a window", "InvalidAccessError")),
      ),
      postMessage: vi.fn(),
    };
    await expect(focusAndNavigate(client, `/c/${CH}/t/${CH}`)).resolves.toBeUndefined();
    expect(client.postMessage).toHaveBeenCalledWith({ type: "navigate", url: `/c/${CH}/t/${CH}` });
  });

  it("focus 가 곧바로 던져도 이동은 보낸다", async () => {
    const client = {
      focus: vi.fn((): Promise<unknown> => {
        throw new Error("boom");
      }),
      postMessage: vi.fn(),
    };
    await focusAndNavigate(client, "/");
    expect(client.postMessage).toHaveBeenCalledWith({ type: "navigate", url: "/" });
  });
});

describe("urlBase64ToUint8Array", () => {
  it("base64url(패딩 없음)을 바이트로", () => {
    expect([...urlBase64ToUint8Array("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
    expect([...urlBase64ToUint8Array("AA")]).toEqual([0]);
  });
});

describe("NAVIGATION_DENYLIST", () => {
  // workbox 가 실제로 쓰는 판정(pathname + search)으로 — 정규식만 따로 재면 쿼리가 붙는 탐색을 못 본다
  const route = new NavigationRoute(() => Promise.resolve(new Response()), { denylist: NAVIGATION_DENYLIST });
  const toIndex = (path: string) =>
    Boolean(
      route.match({ url: new URL(path, "https://dodok.example"), request: { mode: "navigate" } } as never),
    );

  it("서버가 내는 경로는 쿼리가 붙어도 index.html 로 떨어지지 않는다", () => {
    for (const path of [
      "/llms.txt",
      "/llms.txt?x=1",
      "/llms.txt?",
      "/api/v1/me",
      "/api/v1/me?x=1",
      "/socket.io/?EIO=4",
    ])
      expect(toIndex(path), path).toBe(false);
  });

  it("앱 경로는 index.html 로", () => {
    for (const path of [
      "/",
      `/c/${CH}`,
      "/settings/connection?tab=x",
      "/llms.txt.html",
      "/llms.txtx",
      "/apix",
    ])
      expect(toIndex(path), path).toBe(true);
  });
});

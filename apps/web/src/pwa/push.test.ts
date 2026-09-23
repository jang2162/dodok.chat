import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OTHER_KEY, VAPID_KEY, fakeSubscription, pushStub, stubPush } from "../../test/pushStubs";
import {
  disablePush,
  dropLocalPush,
  enablePush,
  type PushEnv,
  pushOnThisDevice,
  pushStateOf,
  syncPushSubscription,
} from "./push";

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });
const FLAG = "dodok.push";

let stub: ReturnType<typeof stubPush> | undefined;
/** 보낸 요청 [메서드, 경로, 본문] */
let calls: Array<[string, string, unknown]>;

function stubFetch(answer: (method: string, url: string) => Response = () => json(204)) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      calls.push([method, url, init?.body ? JSON.parse(String(init.body)) : undefined]);
      if (method === "GET" && url === "/api/v1/push/vapid-public-key")
        return json(200, { publicKey: VAPID_KEY });
      return answer(method, url);
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  stubFetch();
});
afterEach(() => {
  stub?.restore();
  stub = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("pushStateOf — 스펙 6장 표", () => {
  const desktop: PushEnv = { ios: false, standalone: false, supported: true };
  it("다섯 상태", () => {
    expect(pushStateOf({ ...desktop, supported: false }, "unsupported", false)).toBe("unsupported");
    expect(pushStateOf({ ...desktop, supported: false }, "default", false)).toBe("unsupported");
    expect(pushStateOf({ ios: true, standalone: false, supported: false }, "unsupported", false)).toBe(
      "install-needed",
    );
    // iOS 라도 설치한 앱(16.4+)이면 데스크톱과 같다
    expect(pushStateOf({ ios: true, standalone: true, supported: true }, "default", false)).toBe("off");
    // 설치했지만 너무 옛 iOS 라 푸시가 없으면 미지원
    expect(pushStateOf({ ios: true, standalone: true, supported: false }, "unsupported", false)).toBe(
      "unsupported",
    );
    expect(pushStateOf(desktop, "denied", false)).toBe("denied");
    expect(pushStateOf(desktop, "denied", true)).toBe("denied");
    expect(pushStateOf(desktop, "default", false)).toBe("off");
    expect(pushStateOf(desktop, "granted", false)).toBe("off");
    expect(pushStateOf(desktop, "granted", true)).toBe("on");
  });
});

describe("pushOnThisDevice", () => {
  it("플래그가 있을 때만, 저장소가 던지면 false", () => {
    expect(pushOnThisDevice()).toBe(false);
    localStorage.setItem(FLAG, "u1");
    expect(pushOnThisDevice()).toBe(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(pushOnThisDevice()).toBe(false);
  });
});

describe("enablePush", () => {
  it("권한 → 공개키 → 구독(userVisibleOnly·서버 키) → 등록, 플래그", async () => {
    stub = stubPush({ permission: "default" });
    stub.notification.answer("granted");

    expect(await enablePush("u1")).toEqual({ ok: true });

    expect(stub.notification.asked()).toBe(1);
    expect(pushStub.subscribed).toHaveLength(1);
    expect([...(pushStub.subscribed[0]?.applicationServerKey ?? [])]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const post = calls.find(([m]) => m === "POST");
    expect(post?.[1]).toBe("/api/v1/push/subscriptions");
    expect(post?.[2]).toMatchObject({
      endpoint: pushStub.current?.endpoint,
      keys: { p256dh: "BPk", auth: "au" },
    });
    expect(pushOnThisDevice()).toBe(true);
    expect(localStorage.getItem(FLAG)).toBe("u1");
  });

  it("권한을 거절하면 구독하지 않고 이유", async () => {
    stub = stubPush({ permission: "default" });
    stub.notification.answer("denied");
    const r = await enablePush("u1");
    expect(r.ok).toBe(false);
    expect(pushStub.subscribed).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(pushOnThisDevice()).toBe(false);
  });

  it("[스펙 7장] 등록(POST)이 실패하면 기기 구독을 해지한다 — 반쪽 상태 없음", async () => {
    stub = stubPush({ permission: "granted" });
    stubFetch((m) =>
      m === "POST" ? json(401, { code: "UNAUTHORIZED", message: "로그인이 필요합니다" }) : json(204),
    );
    const r = await enablePush("u1");
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("로그인이 필요합니다") });
    expect(pushStub.current).toBeNull();
    expect(pushOnThisDevice()).toBe(false);
  });

  it("네트워크 실패도 해지하고 이유", async () => {
    stub = stubPush({ permission: "granted" });
    stubFetch((m) => {
      if (m === "POST") throw new TypeError("Failed to fetch");
      return json(204);
    });
    const r = await enablePush("u1");
    expect(r.ok).toBe(false);
    expect(pushStub.current).toBeNull();
  });

  it("구독 만들기가 던지면 이유", async () => {
    stub = stubPush({ permission: "granted" });
    pushStub.failSubscribe = true;
    const r = await enablePush("u1");
    expect(r).toEqual({ ok: false, reason: expect.any(String) });
    expect(calls.some(([m]) => m === "POST")).toBe(false);
  });

  it("옛 키로 만든 구독이 남아 있으면 해지하고 새 키로 만든다", async () => {
    const old = fakeSubscription(OTHER_KEY);
    stub = stubPush({ permission: "granted", subscription: old });
    expect(await enablePush("u1")).toEqual({ ok: true });
    expect(old.unsubscribed).toBe(true);
    expect(pushStub.subscribed).toHaveLength(1);
  });

  it("미지원 브라우저는 묻지도 않는다", async () => {
    const r = await enablePush("u1");
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("disablePush·dropLocalPush", () => {
  it("DELETE(endpoint) → unsubscribe → 플래그 지움", async () => {
    const sub = fakeSubscription();
    stub = stubPush({ permission: "granted", subscription: sub });
    localStorage.setItem(FLAG, "u1");
    await disablePush();
    expect(calls).toEqual([["DELETE", "/api/v1/push/subscriptions", { endpoint: sub.endpoint }]]);
    expect(sub.unsubscribed).toBe(true);
    expect(pushOnThisDevice()).toBe(false);
  });

  it("DELETE 가 실패해도 기기 구독은 해지한다(스펙 6장)", async () => {
    const sub = fakeSubscription();
    stub = stubPush({ permission: "granted", subscription: sub });
    localStorage.setItem(FLAG, "u1");
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(disablePush()).resolves.toBeUndefined();
    expect(sub.unsubscribed).toBe(true);
    expect(pushOnThisDevice()).toBe(false);
  });

  it("구독·서비스 워커가 없어도 던지지 않고 플래그만 지운다", async () => {
    localStorage.setItem(FLAG, "u1");
    await expect(disablePush()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(pushOnThisDevice()).toBe(false);
  });

  it("dropLocalPush 는 서버에 묻지 않고 기기 구독만 해지한다(세션이 이미 없을 때)", async () => {
    const sub = fakeSubscription();
    stub = stubPush({ permission: "granted", subscription: sub });
    localStorage.setItem(FLAG, "u1");
    await dropLocalPush();
    expect(calls).toHaveLength(0);
    expect(sub.unsubscribed).toBe(true);
    expect(pushOnThisDevice()).toBe(false);
  });
});

describe("syncPushSubscription", () => {
  it("같은 키 구독이면 다시 등록한다(서버 DB 가 새로 만들어졌을 때)", async () => {
    const sub = fakeSubscription();
    stub = stubPush({ permission: "granted", subscription: sub });
    localStorage.setItem(FLAG, "u1");
    await syncPushSubscription("u1");
    expect(calls.filter(([m]) => m === "POST")).toEqual([
      ["POST", "/api/v1/push/subscriptions", expect.objectContaining({ endpoint: sub.endpoint })],
    ]);
    expect(sub.unsubscribed).toBe(false);
    expect(pushStub.subscribed).toHaveLength(0);
  });

  it("서버 키가 바뀌었으면 해지 후 새로 구독·등록", async () => {
    const sub = fakeSubscription(OTHER_KEY);
    stub = stubPush({ permission: "granted", subscription: sub });
    localStorage.setItem(FLAG, "u1");
    await syncPushSubscription("u1");
    expect(sub.unsubscribed).toBe(true);
    expect(pushStub.subscribed).toHaveLength(1);
    const post = calls.find(([m]) => m === "POST");
    expect(post?.[2]).toMatchObject({ endpoint: pushStub.current?.endpoint });
    expect(pushOnThisDevice()).toBe(true);
  });

  it("구독이 없는데 플래그가 있으면 플래그를 지운다", async () => {
    stub = stubPush({ permission: "granted" });
    localStorage.setItem(FLAG, "u1");
    await syncPushSubscription("u1");
    expect(pushOnThisDevice()).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("[Review Focus 1] 다른 사람이 켠 구독은 이어 쓰지 않는다 — 기기에서 해지하고 등록하지 않는다", async () => {
    const sub = fakeSubscription();
    stub = stubPush({ permission: "granted", subscription: sub });
    localStorage.setItem(FLAG, "userA");
    await syncPushSubscription("userB");
    expect(sub.unsubscribed).toBe(true);
    expect(calls.some(([m]) => m === "POST")).toBe(false);
    expect(pushOnThisDevice()).toBe(false);
  });

  it("누가 켰는지 모르는 구독(플래그 없음)도 해지한다", async () => {
    const sub = fakeSubscription();
    stub = stubPush({ permission: "granted", subscription: sub });
    await syncPushSubscription("userB");
    expect(sub.unsubscribed).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("서비스 워커가 없거나 서버가 실패해도 던지지 않는다", async () => {
    await expect(syncPushSubscription("u1")).resolves.toBeUndefined();
    const sub = fakeSubscription();
    stub = stubPush({ permission: "granted", subscription: sub });
    localStorage.setItem(FLAG, "u1");
    stubFetch(() => json(500, {}));
    vi.mocked(fetch).mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(syncPushSubscription("u1")).resolves.toBeUndefined();
    // 네트워크 실패는 구독을 건드리지 않는다 — 다음에 앱을 열면 다시
    expect(sub.unsubscribed).toBe(false);
    expect(pushOnThisDevice()).toBe(true);
  });
});

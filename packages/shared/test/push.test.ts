import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  PresenceUpdate,
  PushCapabilities,
  PushDeviceInput,
  PushDeviceRemove,
  PushPayload,
  PushSubscriptionInput,
  PushUnsubscribeInput,
} from "../src";

const ID = "01a09fc9-d204-7551-89d6-38544d07a101";
const KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";

describe("PushSubscriptionInput", () => {
  it("옳은 구독은 통과한다", () => {
    expect(PushSubscriptionInput.parse({ endpoint: ENDPOINT, keys: KEYS })).toEqual({
      endpoint: ENDPOINT,
      keys: KEYS,
    });
  });
  it("https:// 가 아닌 endpoint 는 거부한다", () => {
    for (const endpoint of ["http://push.example/x", "ftp://push.example/x", "not a url", "/relative"]) {
      expect(PushSubscriptionInput.safeParse({ endpoint, keys: KEYS }).success).toBe(false);
    }
  });
  it("endpoint 2048자까지 통과, 2049자는 거부", () => {
    const at = (n: number) => `https://push.example/${"a".repeat(n - "https://push.example/".length)}`;
    expect(at(2048)).toHaveLength(2048);
    expect(PushSubscriptionInput.safeParse({ endpoint: at(2048), keys: KEYS }).success).toBe(true);
    expect(PushSubscriptionInput.safeParse({ endpoint: at(2049), keys: KEYS }).success).toBe(false);
  });
  it("base64url 이 아닌 키는 거부한다(+ / 공백·빈 값·패딩 셋)", () => {
    for (const bad of [
      { ...KEYS, p256dh: "abc+def" },
      { ...KEYS, p256dh: "abc/def" },
      { ...KEYS, auth: "ab cd" },
      { ...KEYS, auth: "" },
      { p256dh: KEYS.p256dh },
    ]) {
      expect(PushSubscriptionInput.safeParse({ endpoint: ENDPOINT, keys: bad }).success).toBe(false);
    }
    // 끝 = 패딩은 둘까지 받는다, 셋은 거부
    expect(
      PushSubscriptionInput.safeParse({
        endpoint: ENDPOINT,
        keys: { ...KEYS, auth: "tBHItJI5svbpez7KI4CCXg===" },
      }).success,
    ).toBe(false);
    expect(
      PushSubscriptionInput.safeParse({
        endpoint: ENDPOINT,
        keys: { ...KEYS, auth: "tBHItJI5svbpez7KI4CCXg==" },
      }).success,
    ).toBe(true);
  });
  it("키 길이 상한 — p256dh 200자·auth 100자", () => {
    const ok = PushSubscriptionInput.safeParse({
      endpoint: ENDPOINT,
      keys: { p256dh: "a".repeat(200), auth: "a".repeat(100) },
    });
    expect(ok.success).toBe(true);
    expect(
      PushSubscriptionInput.safeParse({ endpoint: ENDPOINT, keys: { ...KEYS, p256dh: "a".repeat(201) } })
        .success,
    ).toBe(false);
    expect(
      PushSubscriptionInput.safeParse({ endpoint: ENDPOINT, keys: { ...KEYS, auth: "a".repeat(101) } })
        .success,
    ).toBe(false);
  });
});

describe("PushUnsubscribeInput", () => {
  it("endpoint 문자열 하나, 2048자 상한", () => {
    expect(PushUnsubscribeInput.parse({ endpoint: ENDPOINT })).toEqual({ endpoint: ENDPOINT });
    expect(PushUnsubscribeInput.safeParse({ endpoint: "x".repeat(2049) }).success).toBe(false);
    expect(PushUnsubscribeInput.safeParse({}).success).toBe(false);
  });
});

describe("PushPayload", () => {
  const ok = {
    kind: "mention",
    channelId: ID,
    title: "dodok",
    body: "@dev이 #general에서 불렀습니다",
    url: `/c/${ID}`,
    tag: `mention:${ID}`,
  } as const;
  it("옳은 페이로드는 통과한다", () => {
    expect(PushPayload.parse(ok)).toEqual(ok);
    for (const kind of ["approval", "relay_limit"] as const) {
      expect(PushPayload.safeParse({ ...ok, kind }).success).toBe(true);
    }
  });
  it("kind 는 mention·approval·relay_limit 셋뿐이다", () => {
    expect(PushPayload.shape.kind.options).toEqual(["mention", "approval", "relay_limit"]);
  });
  it("모르는 kind·uuid 아닌 channelId 는 거부한다", () => {
    expect(PushPayload.safeParse({ ...ok, kind: "message" }).success).toBe(false);
    expect(PushPayload.safeParse({ ...ok, channelId: "general" }).success).toBe(false);
  });
  it("필드 상한 — title 80·body 200·url 200·tag 80", () => {
    const limits = { title: 80, body: 200, url: 200, tag: 80 } as const;
    for (const [field, max] of Object.entries(limits)) {
      expect(PushPayload.safeParse({ ...ok, [field]: "x".repeat(max) }).success).toBe(true);
      expect(PushPayload.safeParse({ ...ok, [field]: "x".repeat(max + 1) }).success).toBe(false);
    }
  });
});

describe("PresenceUpdate", () => {
  it("channelId 없이도 통과한다", () => {
    expect(PresenceUpdate.parse({ visible: false })).toEqual({ visible: false });
    expect(PresenceUpdate.parse({ visible: true, channelId: ID })).toEqual({ visible: true, channelId: ID });
  });
  it("visible 은 불리언, channelId 는 uuid", () => {
    expect(PresenceUpdate.safeParse({ visible: "yes" }).success).toBe(false);
    expect(PresenceUpdate.safeParse({ visible: true, channelId: "general" }).success).toBe(false);
  });
});

describe("PushDeviceInput", () => {
  const IOS = { platform: "ios", token: "a".repeat(64), appId: "chat.dodok.app", environment: "sandbox" };
  it("옳은 iOS 기기는 통과하고 대문자 hex 도 받는다", () => {
    expect(PushDeviceInput.safeParse(IOS).success).toBe(true);
    expect(PushDeviceInput.safeParse({ ...IOS, token: "A".repeat(64) }).success).toBe(true);
  });
  it("iOS 토큰 63자·65자·hex 아님·environment 없음·알 수 없는 environment 는 거부한다", () => {
    for (const bad of [
      { ...IOS, token: "a".repeat(63) },
      { ...IOS, token: "a".repeat(65) },
      { ...IOS, token: `${"a".repeat(63)}g` },
      { platform: "ios", token: IOS.token, appId: IOS.appId },
      { ...IOS, environment: "dev" },
    ]) {
      expect(PushDeviceInput.safeParse(bad).success).toBe(false);
    }
  });
  it("Android 는 토큰 1~4096자, environment 는 있어도 결과에서 빠진다", () => {
    const base = { platform: "android", token: "t".repeat(4096), appId: "chat.dodok.app" };
    expect(PushDeviceInput.safeParse(base).success).toBe(true);
    expect(PushDeviceInput.safeParse({ ...base, token: "t".repeat(4097) }).success).toBe(false);
    expect(PushDeviceInput.safeParse({ ...base, token: "" }).success).toBe(false);
    expect(PushDeviceInput.parse({ ...base, token: "x", environment: "sandbox" })).toEqual({
      ...base,
      token: "x",
    });
  });
  it("appId 는 1~200자", () => {
    expect(PushDeviceInput.safeParse({ ...IOS, appId: "" }).success).toBe(false);
    expect(PushDeviceInput.safeParse({ ...IOS, appId: "a".repeat(201) }).success).toBe(false);
  });
  it("알 수 없는 platform 은 거부한다", () => {
    expect(PushDeviceInput.safeParse({ ...IOS, platform: "web" }).success).toBe(false);
  });
});

describe("PushDeviceRemove·PushCapabilities·ErrorCode", () => {
  it("PushDeviceRemove 는 token 1~4096자", () => {
    expect(PushDeviceRemove.safeParse({ token: "x" }).success).toBe(true);
    expect(PushDeviceRemove.safeParse({ token: "" }).success).toBe(false);
    expect(PushDeviceRemove.safeParse({ token: "x".repeat(4097) }).success).toBe(false);
  });
  it("PushCapabilities 는 세 불리언", () => {
    expect(PushCapabilities.safeParse({ webpush: true, ios: false, android: false }).success).toBe(true);
    expect(PushCapabilities.safeParse({ webpush: true, ios: false }).success).toBe(false);
  });
  it("ErrorCode 에 PUSH_UNAVAILABLE 이 있다", () => {
    expect(ErrorCode.safeParse("PUSH_UNAVAILABLE").success).toBe(true);
  });
});

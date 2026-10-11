/** APNs 통로 단위(네이티브 푸시 계획 태스크 4) — 가짜 APNs 는 http2 서버(test/fakes/fake-apns.ts), 밖으로는 아무것도 보내지 않는다 */
import type { PushPayload } from "@dodok/shared";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApnsCredentials } from "../src/modules/push/credentials";
import {
  APNS_JWT_TTL_MS,
  APNS_PRODUCTION_HOST,
  APNS_SANDBOX_HOST,
  apnsHostFor,
  apnsResult,
  apnsTransport,
} from "../src/modules/push/transports/apns";
import type { DeviceTarget } from "../src/modules/push/transports/types";
import { pushTopic } from "../src/modules/push/service";
import { type FakeApns, startFakeApns } from "./fakes/fake-apns";

const CHANNEL = "0198a7b2-0000-7000-8000-000000000001";
const mention: PushPayload = {
  kind: "mention",
  channelId: CHANNEL,
  title: "dodok",
  body: "@dev가 #relay에서 불렀습니다",
  url: `/c/${CHANNEL}`,
  tag: `mention:${CHANNEL}`,
};
const approval: PushPayload = {
  ...mention,
  kind: "approval",
  url: `/c/${CHANNEL}/activity`,
  tag: "approval:x",
};
const TOKEN = "ab".repeat(32);
const device = (over: Partial<DeviceTarget> = {}): DeviceTarget => ({
  kind: "device",
  id: "dev-1",
  platform: "ios",
  token: TOKEN,
  appId: "chat.dodok.app",
  environment: "production",
  ...over,
});

describe("apnsTransport", () => {
  let fake: FakeApns;
  let credentials: ApnsCredentials;
  let publicKey: ReturnType<typeof createPublicKey>;
  let clock: number;
  const warn = vi.fn();

  beforeEach(async () => {
    fake = await startFakeApns();
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    credentials = { key: pair.privateKey, keyId: "KEYID12345", teamId: "TEAMID1234" };
    publicKey = createPublicKey(pair.privateKey);
    clock = Date.UTC(2026, 9, 12, 0, 0, 0);
    warn.mockClear();
  });
  afterEach(async () => {
    await fake.close();
  });

  const make = () =>
    apnsTransport({ credentials, host: fake.host, ca: fake.ca, now: () => clock, logger: { warn } });
  const jwtOf = (i: number) => String(fake.requests[i]?.headers.authorization).replace(/^bearer /, "");

  it("요청 꼴 — 경로·헤더·본문이 스펙 「통로」 장 그대로, approval 만 우선순위 10", async () => {
    const t = make();
    try {
      expect(await t.send(device(), { payload: mention, urgency: "normal" })).toBe("ok");
      expect(await t.send(device(), { payload: approval, urgency: "high" })).toBe("ok");
    } finally {
      await t.close();
    }
    const [first, second] = fake.requests;
    expect(first?.path).toBe(`/3/device/${TOKEN}`);
    expect(first?.headers).toMatchObject({
      ":method": "POST",
      "apns-topic": "chat.dodok.app",
      "apns-push-type": "alert",
      "apns-priority": "5",
      "apns-collapse-id": pushTopic(mention.tag),
      "apns-expiration": String(Math.floor(clock / 1000) + 3600),
    });
    expect(second?.headers["apns-priority"]).toBe("10");
    expect(first?.body).toEqual({
      aps: {
        alert: { title: "dodok", body: "@dev가 #relay에서 불렀습니다" },
        sound: "default",
        "thread-id": CHANNEL,
      },
      dodok: { url: `/c/${CHANNEL}`, kind: "mention", channelId: CHANNEL },
    });
  });

  it("JWT — 헤더·클레임이 스펙대로고 서명이 공개 키로 검증된다", async () => {
    const t = make();
    try {
      await t.send(device(), { payload: mention, urgency: "normal" });
    } finally {
      await t.close();
    }
    const [h, c, s] = jwtOf(0).split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEYID12345" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({
      iss: "TEAMID1234",
      iat: Math.floor(clock / 1000),
    });
    const ok = verify(
      "sha256",
      Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s, "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("JWT 는 50분 안이면 재사용하고 50분이 되면 새로 만든다", async () => {
    const t = make();
    try {
      await t.send(device(), { payload: mention, urgency: "normal" });
      clock += APNS_JWT_TTL_MS - 1;
      await t.send(device(), { payload: mention, urgency: "normal" });
      clock += 1;
      await t.send(device(), { payload: mention, urgency: "normal" });
    } finally {
      await t.close();
    }
    expect(jwtOf(1)).toBe(jwtOf(0));
    expect(jwtOf(2)).not.toBe(jwtOf(0));
  });

  it("[Review Focus 2] 403 InvalidProviderToken 이 연달아 와도 JWT 는 50분 규칙대로만 새로 만든다 — 동시 발송도 한 번", async () => {
    fake.reply(() => ({ status: 403, reason: "InvalidProviderToken" }));
    const t = make();
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => t.send(device(), { payload: mention, urgency: "normal" })),
      );
      expect(results).toEqual(Array(6).fill("credentials"));
      await t.send(device(), { payload: mention, urgency: "normal" });
      clock += APNS_JWT_TTL_MS;
      await t.send(device(), { payload: mention, urgency: "normal" });
    } finally {
      await t.close();
    }
    const tokens = new Set(fake.requests.map((_, i) => jwtOf(i)));
    expect(fake.requests).toHaveLength(8);
    expect(tokens.size).toBe(2);
    expect(jwtOf(7)).not.toBe(jwtOf(0));
    expect(jwtOf(6)).toBe(jwtOf(0));
  });

  it.each([
    [200, undefined, "ok"],
    [410, "Unregistered", "gone"],
    [400, "BadDeviceToken", "gone"],
    [400, "DeviceTokenNotForTopic", "gone"],
    [403, "InvalidProviderToken", "credentials"],
    [403, "ExpiredProviderToken", "credentials"],
    [403, "BadCertificate", "credentials"],
    [400, "PayloadEmpty", "rejected"],
    [400, undefined, "rejected"],
    [413, "PayloadTooLarge", "rejected"],
    [429, "TooManyRequests", "retry"],
    [503, "ServiceUnavailable", "retry"],
  ] as const)("결과 표 — %s %s → %s", async (status, reason, expected) => {
    fake.reply(() => ({ status, ...(reason === undefined ? {} : { reason }) }));
    const t = make();
    try {
      expect(await t.send(device(), { payload: mention, urgency: "normal" })).toBe(expected);
    } finally {
      await t.close();
    }
    expect(apnsResult(status, reason)).toBe(expected);
  });

  it("거부(rejected·credentials)는 statusCode 와 고정된 reason 만 warn 으로 남긴다 — 토큰·JWT 는 싣지 않고, 모양이 다른 reason 은 unknown", async () => {
    const t = make();
    try {
      fake.reply(() => ({ status: 403, reason: "InvalidProviderToken" }));
      await t.send(device(), { payload: mention, urgency: "normal" });
      fake.reply(() => ({ status: 400, reason: `echo ${TOKEN}` }));
      await t.send(device(), { payload: mention, urgency: "normal" });
      fake.reply(() => ({ status: 410, reason: "Unregistered" }));
      await t.send(device(), { payload: mention, urgency: "normal" });
    } finally {
      await t.close();
    }
    expect(warn.mock.calls.map(([fields]) => fields)).toEqual([
      { transport: "apns", statusCode: 403, reason: "InvalidProviderToken" },
      { transport: "apns", statusCode: 400, reason: "unknown" },
    ]);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(jwtOf(0));
  });

  it("[Review Focus 5] 기기가 등록한 environment 의 호스트를 고른다 — sandbox·production, 안 실으면 production", () => {
    expect(apnsHostFor("sandbox")).toBe(APNS_SANDBOX_HOST);
    expect(apnsHostFor("production")).toBe(APNS_PRODUCTION_HOST);
    expect(apnsHostFor(undefined)).toBe(APNS_PRODUCTION_HOST);
    expect(APNS_SANDBOX_HOST).toBe("api.sandbox.push.apple.com");
    expect(APNS_PRODUCTION_HOST).toBe("api.push.apple.com");
  });

  it("[Review Focus 3] 서버가 GOAWAY 로 끊은 뒤 다음 발송은 새 연결로 성공한다", async () => {
    const t = make();
    try {
      expect(await t.send(device(), { payload: mention, urgency: "normal" })).toBe("ok");
      fake.goaway();
      // GOAWAY 가 클라이언트에 닿기 전·후 어느 쪽이든 같아야 한다 — 연달아 보내 둘 다 지난다
      expect(await t.send(device(), { payload: mention, urgency: "normal" })).toBe("ok");
      await new Promise((r) => setTimeout(r, 50));
      expect(await t.send(device(), { payload: mention, urgency: "normal" })).toBe("ok");
    } finally {
      await t.close();
    }
    expect(fake.requests).toHaveLength(3);
    expect(fake.connections()).toBeGreaterThanOrEqual(2);
    expect(new Set(fake.requests.map((r) => r.connection)).size).toBeGreaterThanOrEqual(2);
  });

  it("GOAWAY 뒤에 시간을 두고 보내도 끊긴 세션을 붙잡지 않는다", async () => {
    const t = make();
    try {
      await t.send(device(), { payload: mention, urgency: "normal" });
      fake.goaway();
      await new Promise((r) => setTimeout(r, 100));
      expect(await t.send(device(), { payload: mention, urgency: "normal" })).toBe("ok");
    } finally {
      await t.close();
    }
    expect(fake.requests.map((r) => r.connection)).toEqual([0, 1]);
  });

  it("iOS 기기가 아닌 대상은 던진다", async () => {
    const t = make();
    try {
      await expect(
        t.send(device({ platform: "android" }), { payload: mention, urgency: "normal" }),
      ).rejects.toThrow("apns transport cannot send");
      await expect(
        t.send(
          { kind: "web", id: "w", endpoint: "https://x.invalid", keys: { p256dh: "a", auth: "b" } },
          { payload: mention, urgency: "normal" },
        ),
      ).rejects.toThrow("apns transport cannot send");
    } finally {
      await t.close();
    }
    expect(fake.requests).toEqual([]);
  });
});

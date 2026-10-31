import type { PushPayload } from "@dodok/shared";
import { eq } from "drizzle-orm";
import pino from "pino";
import { v7 as uuid } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import type { Db } from "../src/db/client";
import { channelMembers, memberships, pushSubscriptions, users } from "../src/db/schema.sqlite";
import { createPresence } from "../src/modules/push/presence";
import {
  attachPushTriggers,
  createPushDispatcher,
  createTriggerLookups,
  deleteSubscriptionById,
  listSubscriptions,
  pushTopic,
  upsertSubscription,
} from "../src/modules/push/service";
import type {
  DeviceTarget,
  PushNotification,
  PushTransport,
  PushTransports,
  TransportResult,
  WebTarget,
} from "../src/modules/push/transports/types";
import { type PushSend, webPushSender, webPushTransport } from "../src/modules/push/transports/webpush";
import type { OpsRecordInput } from "../src/modules/ops/service";
import { listDevices, upsertDevice } from "../src/modules/push/devices";
import { deleteAutomation, insertAutomation } from "../src/modules/automations/store";
import { ServerBus } from "../src/realtime/bus";
import type { PushTarget } from "../src/modules/push/triggers";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent, seedSession, seedWorkspace } from "./helpers/seed";

const KEYS_A = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};
const KEYS_A2 = { p256dh: `${KEYS_A.p256dh.slice(0, -4)}AAAA`, auth: "AAAAAAAAAAAAAAAAAAAAAA" };
const KEYS_B = { p256dh: `${KEYS_A.p256dh.slice(0, -4)}BBBB`, auth: "BBBBBBBBBBBBBBBBBBBBBB" };
const EP_A1 = "https://fcm.googleapis.com/fcm/send/alice-1";
const EP_A2 = "https://web.push.apple.com/alice-2";
const EP_B = "https://updates.push.services.mozilla.com/bob-1";

describe("push service — listSubscriptions·deleteSubscriptionById", () => {
  let db: Db;
  let alice: string;
  let bob: string;

  const idOf = (endpoint: string) =>
    db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint))
      .get()?.id;
  const byEndpoint = <T extends { endpoint: string }>(xs: T[]) =>
    [...xs].sort((x, y) => x.endpoint.localeCompare(y.endpoint));

  beforeEach(() => {
    db = newTestDb();
    const seeded = seedWorkspace(db, { userHandle: "alice" });
    alice = seeded.userId;
    bob = uuid();
    db.insert(users)
      .values({
        id: bob,
        workspaceId: seeded.workspaceId,
        handle: "bob",
        displayName: "bob",
        authProvider: "local",
        createdAt: new Date(),
      })
      .run();
    upsertSubscription(db, seedSession(db, alice), { endpoint: EP_A1, keys: KEYS_A }, "ua-a1");
    upsertSubscription(db, seedSession(db, alice), { endpoint: EP_A2, keys: KEYS_A2 });
    upsertSubscription(db, seedSession(db, bob), { endpoint: EP_B, keys: KEYS_B }, "ua-b");
  });

  it("사용자마다 자기 구독만 { id, endpoint, keys } 로 낸다(남의 구독·user_agent 는 없다)", () => {
    expect(byEndpoint(listSubscriptions(db, alice))).toEqual(
      byEndpoint([
        { id: idOf(EP_A1), endpoint: EP_A1, keys: KEYS_A },
        { id: idOf(EP_A2), endpoint: EP_A2, keys: KEYS_A2 },
      ]),
    );
    expect(listSubscriptions(db, bob)).toEqual([{ id: idOf(EP_B), endpoint: EP_B, keys: KEYS_B }]);
    expect(listSubscriptions(db, uuid())).toEqual([]);
  });

  it("deleteSubscriptionById 는 그 행 하나만 지운다 — 같은 사용자의 다른 구독·남의 구독은 남는다", () => {
    const target = idOf(EP_A1);
    expect(target).toBeDefined();
    deleteSubscriptionById(db, target as string);

    expect(listSubscriptions(db, alice)).toEqual([{ id: idOf(EP_A2), endpoint: EP_A2, keys: KEYS_A2 }]);
    expect(listSubscriptions(db, bob)).toEqual([{ id: idOf(EP_B), endpoint: EP_B, keys: KEYS_B }]);
    expect(db.select().from(pushSubscriptions).all()).toHaveLength(2);

    // 없는 id(이미 지운 것 포함)는 아무 일도 없다
    deleteSubscriptionById(db, target as string);
    deleteSubscriptionById(db, uuid());
    expect(db.select().from(pushSubscriptions).all()).toHaveLength(2);
  });
});

const CH = "0199a000-0000-7000-8000-000000000001";
const OTHER = "0199a000-0000-7000-8000-000000000002";
/** CH 의 세션 둘 — 거르기는 세션 단위다(채널 세션 계획 판정 PS7) */
const CONV = "0199a000-0000-7000-8000-000000000011";
const CONV_B = "0199a000-0000-7000-8000-000000000012";
const BODY = "@dev가 #프로젝트에서 불렀습니다";
const mention = (channelId = CH): PushPayload => ({
  kind: "mention",
  channelId,
  title: "dodok",
  body: BODY,
  url: `/c/${channelId}/s/${CONV}`,
  tag: `mention:${CONV}`,
});

function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const raw: string[] = [];
  const logger = pino(
    { level: "debug" },
    {
      write: (line: string) => {
        raw.push(line);
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { logger, lines, raw };
}

/** pino 가 늘 붙이는 것 — 이것을 뺀 나머지가 호출부가 실은 필드다 */
const PINO_BASE = new Set(["level", "time", "pid", "hostname", "msg"]);
const fieldsOf = (line: Record<string, unknown>) =>
  Object.keys(line)
    .filter((k) => !PINO_BASE.has(k))
    .sort();

type SendCall = { endpoint: string; keys: { p256dh: string; auth: string }; body: string; opts: unknown };

describe("pushTopic — tag 에서 32자 이하 url-safe(스펙 5.4)", () => {
  it("길이 32 이하·[A-Za-z0-9_-] 만, 같은 tag 는 같은 topic, 다른 tag 는 다른 topic", () => {
    for (const tag of [`mention:${CH}`, `approval:${CH}`, `relay:${CH}`, "x", "한글:태그/+="]) {
      expect(pushTopic(tag)).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    }
    expect(pushTopic(`mention:${CH}`)).toBe(pushTopic(`mention:${CH}`));
    expect(pushTopic(`mention:${CH}`)).not.toBe(pushTopic(`mention:${OTHER}`));
  });
});

describe("createPushDispatcher — 발송·거르기·결과 분기(스펙 5.3·5.4)", () => {
  let db: Db;
  let alice: string;
  let bob: string;
  let calls: SendCall[];
  let respond: (call: SendCall) => Promise<{ statusCode: number }>;
  let cap: ReturnType<typeof captureLogger>;
  let presence: ReturnType<typeof createPresence>;

  const send: PushSend = (sub, body, opts) => {
    const call = { endpoint: sub.endpoint, keys: sub.keys, body, opts };
    calls.push(call);
    return respond(call);
  };
  const dispatcher = () =>
    createPushDispatcher({
      db,
      logger: cap.logger,
      transports: { webpush: webPushTransport(send) },
      presence,
      ops: { record: () => null },
    });
  const endpoints = (userId: string) =>
    listSubscriptions(db, userId)
      .map((s) => s.endpoint)
      .sort();

  beforeEach(() => {
    db = newTestDb();
    const seeded = seedWorkspace(db, { userHandle: "alice" });
    alice = seeded.userId;
    bob = uuid();
    db.insert(users)
      .values({
        id: bob,
        workspaceId: seeded.workspaceId,
        handle: "bob",
        displayName: "bob",
        authProvider: "local",
        createdAt: new Date(),
      })
      .run();
    upsertSubscription(db, seedSession(db, alice), { endpoint: EP_A1, keys: KEYS_A });
    upsertSubscription(db, seedSession(db, alice), { endpoint: EP_A2, keys: KEYS_A2 });
    upsertSubscription(db, seedSession(db, bob), { endpoint: EP_B, keys: KEYS_B });
    calls = [];
    respond = async () => ({ statusCode: 201 });
    cap = captureLogger();
    presence = createPresence();
  });

  it("사용자 구독 둘 → 두 번, 본문은 JSON.stringify(payload), TTL 3600·urgency normal·topic", async () => {
    await dispatcher().dispatch([{ userId: alice, conversationId: CONV, payload: mention() }]);
    expect(calls.map((c) => c.endpoint).sort()).toEqual([EP_A1, EP_A2].sort());
    for (const c of calls) {
      expect(c.body).toBe(JSON.stringify(mention()));
      expect(c.opts).toEqual({ TTL: 3600, urgency: "normal", topic: pushTopic(`mention:${CONV}`) });
    }
    expect(calls.find((c) => c.endpoint === EP_A1)?.keys).toEqual(KEYS_A);
    // 남의 구독에는 가지 않는다
    expect(calls.some((c) => c.endpoint === EP_B)).toBe(false);
  });

  it("승인은 urgency high, 릴레이 한도는 normal", async () => {
    const approval: PushPayload = {
      kind: "approval",
      channelId: CH,
      title: "dodok",
      body: "#프로젝트에 승인 요청이 있습니다",
      url: `/c/${CH}/activity`,
      tag: `approval:${OTHER}`,
    };
    const relay: PushPayload = { ...approval, kind: "relay_limit", url: `/c/${CH}`, tag: `relay:${CH}` };
    await dispatcher().dispatch([
      { userId: bob, conversationId: CONV, payload: approval },
      { userId: bob, conversationId: CONV, payload: relay },
    ]);
    expect(calls.map((c) => c.opts)).toEqual([
      { TTL: 3600, urgency: "high", topic: pushTopic(`approval:${OTHER}`) },
      { TTL: 3600, urgency: "normal", topic: pushTopic(`relay:${CH}`) },
    ]);
  });

  it("[Review Focus 3] 그 세션을 보이는 탭으로 보고 있으면 보내지 않는다 — 다른 채널·백그라운드면 보낸다", async () => {
    presence.set("s1", alice, { visible: true, channelId: CH, conversationId: CONV });
    await dispatcher().dispatch([
      { userId: alice, conversationId: CONV, payload: mention(CH) },
      { userId: bob, conversationId: CONV, payload: mention(CH) },
    ]);
    expect(calls.map((c) => c.endpoint)).toEqual([EP_B]);

    calls = [];
    await dispatcher().dispatch([{ userId: alice, conversationId: uuid(), payload: mention(OTHER) }]);
    expect(calls).toHaveLength(2);

    calls = [];
    presence.set("s1", alice, { visible: false, channelId: CH, conversationId: CONV });
    await dispatcher().dispatch([{ userId: alice, conversationId: CONV, payload: mention(CH) }]);
    expect(calls).toHaveLength(2);
  });

  it("[판정 PS7] 같은 채널의 다른 세션을 보고 있으면 보낸다 — 거르기는 채널이 아니라 세션 단위", async () => {
    presence.set("s1", alice, { visible: true, channelId: CH, conversationId: CONV });
    await dispatcher().dispatch([{ userId: alice, conversationId: CONV_B, payload: mention(CH) }]);
    expect(calls.map((c) => c.endpoint).sort()).toEqual([EP_A1, EP_A2].sort());

    // 세션이 없는 화면(새 세션 창·채널 밖)은 같은 채널이어도 아무것도 거르지 않는다
    calls = [];
    presence.set("s1", alice, { visible: true, channelId: CH });
    await dispatcher().dispatch([{ userId: alice, conversationId: CONV, payload: mention(CH) }]);
    expect(calls).toHaveLength(2);
  });

  it("[p4-c1] 거르기·성공 발송은 debug 한 줄씩 — 필드는 정해진 것만(다음 실연이 억제·발송·미도착을 가르게)", async () => {
    presence.set("s1", alice, { visible: true, channelId: CH, conversationId: CONV });
    await dispatcher().dispatch([
      { userId: alice, conversationId: CONV, payload: mention(CH) },
      { userId: bob, conversationId: CONV, payload: mention(CH) },
    ]);
    const skipped = cap.lines.filter((l) => l.msg === "push skipped — watching");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      level: 20,
      userId: alice,
      channelId: CH,
      conversationId: CONV,
      kind: "mention",
    });
    expect(fieldsOf(skipped[0] as Record<string, unknown>)).toEqual([
      "channelId",
      "conversationId",
      "kind",
      "userId",
    ]);

    const sent = cap.lines.filter((l) => l.msg === "push sent");
    expect(sent).toHaveLength(1); // bob 의 구독 하나
    expect(sent[0]).toMatchObject({
      level: 20,
      result: "ok",
      transport: "webpush",
      userId: bob,
      kind: "mention",
    });
    expect(fieldsOf(sent[0] as Record<string, unknown>)).toEqual([
      "kind",
      "result",
      "subscriptionId",
      "transport",
      "userId",
    ]);
    expect(cap.lines).toHaveLength(2);
    // 본문·endpoint·keys 는 어디에도 없다
    const all = cap.raw.join("\n");
    for (const secret of [BODY, EP_B, EP_A1, KEYS_B.p256dh, KEYS_B.auth]) expect(all).not.toContain(secret);
  });

  it("구독이 없는 사람·빈 목록은 보내지 않는다", async () => {
    await dispatcher().dispatch([{ userId: uuid(), conversationId: CONV, payload: mention() }]);
    await dispatcher().dispatch([]);
    expect(calls).toEqual([]);
  });

  it("404·410 → 그 구독만 지운다(다른 구독·남의 구독은 남는다)", async () => {
    respond = async (c) => ({ statusCode: c.endpoint === EP_A1 ? 410 : c.endpoint === EP_A2 ? 404 : 201 });
    await dispatcher().dispatch([
      { userId: alice, conversationId: CONV, payload: mention() },
      { userId: bob, conversationId: CONV, payload: mention() },
    ]);
    expect(endpoints(alice)).toEqual([]);
    expect(endpoints(bob)).toEqual([EP_B]);

    // 하나만 410
    upsertSubscription(db, seedSession(db, alice), { endpoint: EP_A1, keys: KEYS_A });
    upsertSubscription(db, seedSession(db, alice), { endpoint: EP_A2, keys: KEYS_A2 });
    respond = async (c) => ({ statusCode: c.endpoint === EP_A2 ? 410 : 201 });
    await dispatcher().dispatch([{ userId: alice, conversationId: CONV, payload: mention() }]);
    expect(endpoints(alice)).toEqual([EP_A1]);
  });

  it("400·403·413 → error 로그, 구독은 지우지 않는다(403 은 VAPID 주체·키 문제)", async () => {
    for (const statusCode of [400, 403, 413]) {
      cap = captureLogger();
      respond = async () => ({ statusCode });
      await dispatcher().dispatch([{ userId: bob, conversationId: CONV, payload: mention() }]);
      expect(endpoints(bob)).toEqual([EP_B]);
      const errors = cap.lines.filter((l) => l.level === 50);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        result: "rejected",
        transport: "webpush",
        userId: bob,
        kind: "mention",
      });
      expect(cap.lines.filter((l) => l.level === 40)).toEqual([]);
    }
  });

  it("429·500·던짐 → warn 로그, 구독은 남고 다른 구독에는 계속 보낸다", async () => {
    for (const fail of [
      async () => ({ statusCode: 429 }),
      async () => ({ statusCode: 500 }),
      async () => {
        throw new Error("socket hang up");
      },
    ]) {
      cap = captureLogger();
      calls = [];
      respond = (c) => (c.endpoint === EP_A1 ? fail() : Promise.resolve({ statusCode: 201 }));
      await expect(
        dispatcher().dispatch([{ userId: alice, conversationId: CONV, payload: mention() }]),
      ).resolves.toBeUndefined();
      expect(calls.map((c) => c.endpoint).sort()).toEqual([EP_A1, EP_A2].sort());
      expect(endpoints(alice)).toEqual([EP_A1, EP_A2].sort());
      const warns = cap.lines.filter((l) => l.level === 40);
      expect(warns).toHaveLength(1);
      expect(cap.lines.filter((l) => Number(l.level) >= 50)).toEqual([]);
    }
  });

  it("한 사용자의 발송이 던져도 다른 사용자에게는 보낸다", async () => {
    respond = async (c) => {
      if (c.endpoint.startsWith("https://fcm")) throw new Error("boom");
      return { statusCode: 201 };
    };
    await dispatcher().dispatch([
      { userId: alice, conversationId: CONV, payload: mention() },
      { userId: bob, conversationId: CONV, payload: mention() },
    ]);
    expect(calls.map((c) => c.endpoint)).toContain(EP_B);
  });

  it("[리뷰 D6] 발송 실패 로그에 구독 keys·endpoint·페이로드 본문·VAPID 비밀 키·web-push 오류 객체가 없다", async () => {
    const vapid = webpush.generateVAPIDKeys();
    const leaky = new webpush.WebPushError(
      "Received unexpected response code",
      500,
      { "x-secret-header": "HDR-SECRET" },
      "RESPONSE-BODY-SECRET",
      EP_A1,
    );
    Object.assign(leaky, { privateKey: vapid.privateKey, payload: JSON.stringify(mention()) });
    const outcomes: Array<() => Promise<{ statusCode: number }>> = [
      async () => ({ statusCode: 400 }),
      async () => ({ statusCode: 403 }),
      async () => ({ statusCode: 413 }),
      async () => ({ statusCode: 429 }),
      async () => ({ statusCode: 500 }),
      async () => {
        throw leaky;
      },
      async () => {
        throw Object.assign(new Error("x".repeat(1000)), { keys: KEYS_A, body: "THROWN-BODY-SECRET" });
      },
    ];
    for (const outcome of outcomes) {
      respond = () => outcome();
      await dispatcher().dispatch([{ userId: alice, conversationId: CONV, payload: mention() }]);
    }
    const all = cap.raw.join("\n");
    expect(cap.lines.length).toBeGreaterThanOrEqual(outcomes.length * 2);
    for (const secret of [
      KEYS_A.p256dh,
      KEYS_A.auth,
      KEYS_A2.p256dh,
      KEYS_A2.auth,
      EP_A1,
      EP_A2,
      BODY,
      "불렀습니다",
      vapid.privateKey,
      "HDR-SECRET",
      "RESPONSE-BODY-SECRET",
      "THROWN-BODY-SECRET",
      "stack",
    ]) {
      expect(all).not.toContain(secret);
    }
    // 오류 객체를 통째로 싣지 않는다 — 짧은 사유 문자열만(상한 200자)
    for (const line of cap.lines) {
      expect(line.err).toBeUndefined();
      if (line.reason !== undefined) expect(String(line.reason).length).toBeLessThanOrEqual(200);
    }
  });

  it("DB 가 닫혀 있어도 dispatch 는 던지지 않고 error 로그만 남긴다", async () => {
    db.$client.close();
    await expect(
      dispatcher().dispatch([{ userId: alice, conversationId: CONV, payload: mention() }]),
    ).resolves.toBeUndefined();
    expect(cap.lines.filter((l) => l.level === 50)).toHaveLength(1);
    // [리뷰 m1] 사용자 단위 실패 로그도 허용 필드만 — 오류 객체·페이로드는 없다
    expect(cap.lines).toHaveLength(1);
    expect(cap.lines[0]).toMatchObject({
      level: 50,
      msg: "push dispatch failed",
      userId: alice,
      kind: "mention",
    });
    expect(fieldsOf(cap.lines[0] as Record<string, unknown>)).toEqual(["kind", "reason", "userId"]);
  });

  it("[리뷰 m1] 발송 경로의 로그는 분기마다 정해진 필드만 싣는다(오류 객체·페이로드·keys·endpoint 없음)", async () => {
    const SUB = ["kind", "subscriptionId", "transport", "userId"];
    const cases: Array<{
      name: string;
      respond: () => Promise<{ statusCode: number }>;
      level: number;
      msg: string;
      fields: string[];
    }> = [
      {
        name: "410",
        respond: async () => ({ statusCode: 410 }),
        level: 30,
        msg: "push subscription gone — removed",
        fields: [...SUB, "result"],
      },
      {
        name: "403",
        respond: async () => ({ statusCode: 403 }),
        level: 50,
        msg: "push rejected",
        fields: [...SUB, "result"],
      },
      {
        name: "500",
        respond: async () => ({ statusCode: 500 }),
        level: 40,
        msg: "push send failed",
        fields: [...SUB, "result"],
      },
      {
        name: "던짐",
        respond: async () => {
          throw Object.assign(new Error("socket hang up"), {
            keys: KEYS_B,
            endpoint: EP_B,
            payload: mention(),
          });
        },
        level: 40,
        msg: "push send failed",
        fields: [...SUB, "reason"],
      },
    ];
    for (const c of cases) {
      cap = captureLogger();
      respond = c.respond;
      upsertSubscription(db, seedSession(db, bob), { endpoint: EP_B, keys: KEYS_B }); // 410 이 지운 뒤에도 다음 경우를 위해
      await dispatcher().dispatch([{ userId: bob, conversationId: CONV, payload: mention() }]);
      expect(cap.lines, c.name).toHaveLength(1);
      expect(cap.lines[0], c.name).toMatchObject({
        level: c.level,
        msg: c.msg,
        userId: bob,
        kind: "mention",
      });
      expect(fieldsOf(cap.lines[0] as Record<string, unknown>), c.name).toEqual([...c.fields].sort());
    }
  });

  it("[리뷰 m1] 사용자 단위 실패(push dispatch failed)에 오류 객체·페이로드·keys·endpoint 가 실리지 않는다", async () => {
    const leaky = Object.assign(new Error(`presence broke ${"y".repeat(1000)}`), {
      keys: KEYS_B,
      endpoint: EP_B,
      payload: mention(),
      body: "THROWN-BODY-SECRET",
    });
    const d = createPushDispatcher({
      db,
      logger: cap.logger,
      transports: { webpush: webPushTransport(send) },
      ops: { record: () => null },
      presence: {
        isWatching: () => {
          throw leaky;
        },
      },
    });
    await expect(
      d.dispatch([{ userId: bob, conversationId: CONV, payload: mention() }]),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(cap.lines).toHaveLength(1);
    const line = cap.lines[0] as Record<string, unknown>;
    expect(line).toMatchObject({ level: 50, msg: "push dispatch failed", userId: bob, kind: "mention" });
    expect(fieldsOf(line)).toEqual(["kind", "reason", "userId"]);
    expect(String(line.reason).startsWith("Error: presence broke ")).toBe(true);
    expect(String(line.reason).length).toBeLessThanOrEqual(200);
    const all = cap.raw.join("\n");
    for (const secret of [
      KEYS_B.p256dh,
      KEYS_B.auth,
      EP_B,
      BODY,
      "불렀습니다",
      "THROWN-BODY-SECRET",
      "stack",
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  it("drain — 진행 중인 발송을 기다리되 상한을 넘기면 놓는다", async () => {
    let release: (() => void) | undefined;
    respond = () =>
      new Promise((resolve) => {
        release = () => resolve({ statusCode: 201 });
      });
    const d = dispatcher();
    const pending = d.dispatch([{ userId: bob, conversationId: CONV, payload: mention() }]);
    const t0 = Date.now();
    await d.drain(50); // 걸린 발송이 있어도 상한에서 돌아온다
    expect(Date.now() - t0).toBeLessThan(1000);
    release?.();
    await pending;
    await d.drain(5_000); // 비었으면 바로
  });
});

describe("webPushTransport — 상태 코드 → 결과(스펙 「통로」 장 webpush 줄)", () => {
  const target = { kind: "web" as const, id: "s1", endpoint: "https://push.invalid/x", keys: KEYS_A };
  const n = { payload: mention(), urgency: "high" as const };

  it("발송기에 endpoint·keys, JSON 본문, TTL·urgency·topic 을 넘긴다", async () => {
    const calls: unknown[] = [];
    await webPushTransport(async (...args) => {
      calls.push(args);
      return { statusCode: 201 };
    }).send(target, n);
    expect(calls).toEqual([
      [
        { endpoint: target.endpoint, keys: KEYS_A },
        JSON.stringify(mention()),
        { TTL: 3600, urgency: "high", topic: pushTopic(`mention:${CONV}`) },
      ],
    ]);
  });

  it.each([
    [200, "ok"],
    [201, "ok"],
    [299, "ok"],
    [404, "gone"],
    [410, "gone"],
    [400, "rejected"],
    [403, "rejected"],
    [413, "rejected"],
    [401, "retry"],
    [429, "retry"],
    [500, "retry"],
    [503, "retry"],
  ] as const)("%i → %s", async (statusCode, result) => {
    await expect(webPushTransport(async () => ({ statusCode })).send(target, n)).resolves.toBe(result);
  });

  it("거부(rejected)는 statusCode 만 warn 으로 남기고 endpoint 는 싣지 않는다 — ok·gone·retry 는 남기지 않는다", async () => {
    const warn = vi.fn();
    for (const statusCode of [201, 410, 503, 403, 400])
      await webPushTransport(async () => ({ statusCode }), { warn }).send(target, n);
    expect(warn.mock.calls.map(([fields]) => fields)).toEqual([
      { transport: "webpush", statusCode: 403 },
      { transport: "webpush", statusCode: 400 },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(target.endpoint);
  });

  it("발송기가 던지면 그대로 던지고, 기기 대상은 받지 않는다", async () => {
    const boom = webPushTransport(async () => {
      throw new Error("socket hang up");
    });
    await expect(boom.send(target, n)).rejects.toThrow("socket hang up");
    const device = { kind: "device" as const, id: "d", platform: "ios" as const, token: "t", appId: "a" };
    await expect(webPushTransport(async () => ({ statusCode: 201 })).send(device, n)).rejects.toThrow();
  });
});

describe("createPushDispatcher — 기기 통로(apns·fcm)", () => {
  const IOS_TOKEN = "ab".repeat(32);
  const ANDROID_TOKEN = "fcm-registration-token-secret";
  let db: Db;
  let alice: string;
  let cap: ReturnType<typeof captureLogger>;
  let presence: ReturnType<typeof createPresence>;
  let sent: Array<{ transport: string; target: WebTarget | DeviceTarget; n: PushNotification }>;
  let results: Partial<Record<string, () => Promise<TransportResult>>>;
  let recorded: OpsRecordInput[];

  const fake = (kind: "webpush" | "apns" | "fcm"): PushTransport => ({
    kind,
    send: (target, n) => {
      sent.push({ transport: kind, target, n });
      return results[kind]?.() ?? Promise.resolve("ok");
    },
  });
  const dispatcher = (
    transports: PushTransports = { webpush: fake("webpush"), apns: fake("apns"), fcm: fake("fcm") },
  ) =>
    createPushDispatcher({
      db,
      logger: cap.logger,
      transports,
      presence,
      ops: {
        record: (input) => {
          recorded.push(input);
          return null;
        },
      },
    });
  const tokens = () =>
    listDevices(db, alice)
      .map((d) => d.token)
      .sort();

  beforeEach(() => {
    db = newTestDb();
    alice = seedWorkspace(db, { userHandle: "alice" }).userId;
    upsertSubscription(db, seedSession(db, alice), { endpoint: EP_A1, keys: KEYS_A });
    upsertDevice(
      db,
      alice,
      seedSession(db, alice).sessionId,
      { platform: "ios", token: IOS_TOKEN, appId: "chat.dodok.app", environment: "sandbox" },
      new Date(),
    );
    upsertDevice(
      db,
      alice,
      seedSession(db, alice).sessionId,
      { platform: "android", token: ANDROID_TOKEN, appId: "chat.dodok.android" },
      new Date(),
    );
    cap = captureLogger();
    presence = createPresence();
    sent = [];
    results = {};
    recorded = [];
  });

  it("웹 구독은 webpush, iOS 기기는 apns, Android 기기는 fcm 으로 — 대상에는 기기 행의 값, 승인은 urgency high", async () => {
    const approval: PushPayload = { ...mention(), kind: "approval", tag: `approval:${OTHER}` };
    await dispatcher().dispatch([{ userId: alice, conversationId: CONV, payload: approval }]);
    const by = (t: string) => sent.find((x) => x.transport === t);
    expect(sent).toHaveLength(3);
    expect(by("webpush")?.target).toMatchObject({ kind: "web", endpoint: EP_A1, keys: KEYS_A });
    expect(by("apns")?.target).toEqual({
      kind: "device",
      id: expect.any(String),
      platform: "ios",
      token: IOS_TOKEN,
      appId: "chat.dodok.app",
      environment: "sandbox",
    });
    expect(by("fcm")?.target).toEqual({
      kind: "device",
      id: expect.any(String),
      platform: "android",
      token: ANDROID_TOKEN,
      appId: "chat.dodok.android",
    });
    for (const x of sent) expect(x.n).toEqual({ payload: approval, urgency: "high" });
  });

  it("그 세션을 보고 있으면 기기에도 보내지 않는다", async () => {
    presence.set("s1", alice, { visible: true, channelId: CH, conversationId: CONV });
    await dispatcher().dispatch([{ userId: alice, conversationId: CONV, payload: mention(CH) }]);
    expect(sent).toEqual([]);
  });

  it("gone → 그 기기 행만 지운다(다른 기기·웹 구독은 남는다), info", async () => {
    results.apns = async () => "gone";
    await dispatcher().dispatch([{ userId: alice, conversationId: CONV, payload: mention() }]);
    expect(tokens()).toEqual([ANDROID_TOKEN]);
    expect(listSubscriptions(db, alice).map((x) => x.endpoint)).toEqual([EP_A1]);
    const gone = cap.lines.filter((l) => l.msg === "push device gone — removed");
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({
      level: 30,
      transport: "apns",
      result: "gone",
      userId: alice,
      kind: "mention",
    });
  });

  it("credentials → 기기는 남고 운영 사건 push_credentials_invalid(key push:<통로>), error", async () => {
    results.apns = async () => "credentials";
    results.fcm = async () => "credentials";
    await dispatcher().dispatch([{ userId: alice, conversationId: CONV, payload: mention() }]);
    expect(tokens()).toEqual([ANDROID_TOKEN, IOS_TOKEN].sort());
    expect([...recorded].sort((x, y) => x.key.localeCompare(y.key))).toEqual([
      { kind: "push_credentials_invalid", key: "push:apns", severity: "error" },
      { kind: "push_credentials_invalid", key: "push:fcm", severity: "error" },
    ]);
    const errors = cap.lines.filter((l) => l.msg === "push credentials rejected");
    expect(errors.map((l) => l.transport).sort()).toEqual(["apns", "fcm"]);
    for (const l of errors) expect(l.level).toBe(50);
  });

  it("rejected → error, retry·던짐 → warn — 기기는 남고 사건은 없다", async () => {
    for (const [outcome, level] of [
      [async () => "rejected" as const, 50],
      [async () => "retry" as const, 40],
      [
        async (): Promise<TransportResult> => {
          throw new Error("ECONNRESET");
        },
        40,
      ],
    ] as const) {
      cap = captureLogger();
      results.apns = outcome;
      await dispatcher().dispatch([{ userId: alice, conversationId: CONV, payload: mention() }]);
      expect(tokens()).toEqual([ANDROID_TOKEN, IOS_TOKEN].sort());
      const apnsLines = cap.lines.filter((l) => l.transport === "apns");
      expect(apnsLines).toHaveLength(1);
      expect(apnsLines[0]?.level).toBe(level);
    }
    expect(recorded).toEqual([]);
  });

  it("그 플랫폼 통로가 꺼져 있으면 그 기기는 건너뛰고 debug — 행은 남고 다른 통로로는 보낸다", async () => {
    await dispatcher({ webpush: fake("webpush"), fcm: fake("fcm") }).dispatch([
      { userId: alice, conversationId: CONV, payload: mention() },
    ]);
    expect(sent.map((x) => x.transport).sort()).toEqual(["fcm", "webpush"]);
    expect(tokens()).toEqual([ANDROID_TOKEN, IOS_TOKEN].sort());
    const skipped = cap.lines.filter((l) => l.msg === "push skipped — transport off");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ level: 20, userId: alice, kind: "mention" });
    expect(fieldsOf(skipped[0] as Record<string, unknown>)).toEqual(["deviceId", "kind", "userId"]);
  });

  it("로그에는 정해진 필드만 — token·endpoint·keys 키도, 토큰·endpoint 값도 없다", async () => {
    for (const r of ["ok", "gone", "rejected", "credentials", "retry"] as const) {
      results.apns = async () => r;
      results.fcm = async () => r;
      await dispatcher().dispatch([{ userId: alice, conversationId: CONV, payload: mention() }]);
      upsertDevice(
        db,
        alice,
        seedSession(db, alice).sessionId,
        { platform: "ios", token: IOS_TOKEN, appId: "chat.dodok.app", environment: "sandbox" },
        new Date(),
      );
      upsertDevice(
        db,
        alice,
        seedSession(db, alice).sessionId,
        { platform: "android", token: ANDROID_TOKEN, appId: "chat.dodok.android" },
        new Date(),
      );
    }
    const deviceLines = cap.lines.filter((l) => l.deviceId !== undefined);
    expect(deviceLines.length).toBe(10);
    for (const l of deviceLines) {
      expect(fieldsOf(l)).toEqual(["deviceId", "kind", "result", "transport", "userId"]);
    }
    for (const l of cap.lines) {
      for (const key of ["token", "endpoint", "keys", "payload", "err"]) expect(l[key]).toBeUndefined();
    }
    const all = cap.raw.join("\n");
    for (const secret of [IOS_TOKEN, IOS_TOKEN.slice(0, 16), ANDROID_TOKEN, EP_A1, KEYS_A.p256dh, BODY]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe("webPushSender — 실제 web-push 로 넘기는 모양(네트워크 없음: sendNotification 을 가로챈다)", () => {
  const vapid = { subject: "mailto:ops@example.com", ...webpush.generateVAPIDKeys() };
  const sub = { endpoint: "https://push.invalid/x", keys: KEYS_A };
  const opts = { TTL: 3600, urgency: "high" as const, topic: "t" };
  afterEach(() => vi.restoreAllMocks());

  it("vapidDetails·옵션·제한시간을 넘기고 2xx 의 statusCode 를 낸다", async () => {
    const spy = vi
      .spyOn(webpush, "sendNotification")
      .mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    await expect(webPushSender(vapid)(sub, "{}", opts)).resolves.toEqual({ statusCode: 201 });
    expect(spy).toHaveBeenCalledWith(sub, "{}", {
      ...opts,
      vapidDetails: vapid,
      timeout: expect.any(Number),
    });
  });

  it("WebPushError 는 statusCode 로 바꾼다(410·403)", async () => {
    for (const code of [410, 403]) {
      vi.spyOn(webpush, "sendNotification").mockRejectedValueOnce(
        new webpush.WebPushError("Received unexpected response code", code, {}, "", sub.endpoint),
      );
      await expect(webPushSender(vapid)(sub, "{}", opts)).resolves.toEqual({ statusCode: code });
    }
  });

  it("그 밖의 오류(네트워크)는 그대로 던진다", async () => {
    vi.spyOn(webpush, "sendNotification").mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"));
    await expect(webPushSender(vapid)(sub, "{}", opts)).rejects.toThrow("ENOTFOUND");
  });
});

describe("createTriggerLookups — DB 로 이름 풀기", () => {
  it("채널 이름·사용자 핸들·에이전트 핸들·사람 멤버(에이전트 멤버는 빼고), 없는 id 는 undefined·빈 목록", () => {
    const db = newTestDb();
    const s = seedChannelWithAgent(db, { agentHandle: "dev", channelName: "프로젝트" });
    const other = uuid();
    db.insert(users)
      .values({
        id: other,
        workspaceId: s.workspaceId,
        handle: "sam",
        displayName: "sam",
        authProvider: "local",
        createdAt: new Date(),
      })
      .run();
    db.insert(channelMembers)
      .values({
        id: uuid(),
        channelId: s.channelId,
        memberType: "user",
        memberId: other,
        joinedAt: new Date(),
      })
      .run();
    const l = createTriggerLookups(db, s.workspaceId);
    expect(l.channelName(s.channelId)).toBe("프로젝트");
    expect(l.userHandle(s.userId)).toBe("owner");
    expect(l.agentHandle(s.agentId)).toBe("dev");
    expect(l.humanMembers(s.channelId).sort()).toEqual([s.userId, other].sort());
    expect(l.channelName(uuid())).toBeUndefined();
    expect(l.userHandle(s.agentId)).toBeUndefined();
    expect(l.agentHandle(s.userId)).toBeUndefined();
    expect(l.humanMembers(uuid())).toEqual([]);
    // 다른 워크스페이스 채널은 이름을 풀지 않는다
    expect(createTriggerLookups(db, uuid()).channelName(s.channelId)).toBeUndefined();
  });

  it("automationName — 그 워크스페이스의 자동화 이름, 지웠거나 다른 워크스페이스면 undefined", () => {
    const db = newTestDb();
    const s = seedChannelWithAgent(db);
    const now = new Date();
    const automation = insertAutomation(db, {
      id: uuid(),
      workspaceId: s.workspaceId,
      name: "아침 점검",
      channelId: s.channelId,
      kind: "webhook",
      bodyMd: "x",
      enabled: true,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    expect(createTriggerLookups(db, s.workspaceId).automationName(automation.id)).toBe("아침 점검");
    expect(createTriggerLookups(db, uuid()).automationName(automation.id)).toBeUndefined();
    deleteAutomation(db, s.workspaceId, automation.id);
    expect(createTriggerLookups(db, s.workspaceId).automationName(automation.id)).toBeUndefined();
  });

  it("admins — 그 워크스페이스 membership 의 owner·admin 만(member·다른 워크스페이스·membership 없음은 빼고)", () => {
    const db = newTestDb();
    const s = seedChannelWithAgent(db);
    const other = seedWorkspace(db, { userHandle: "far" });
    const person = (workspaceId: string, handle: string, role: string | null) => {
      const id = uuid();
      db.insert(users)
        .values({
          id,
          workspaceId,
          handle,
          displayName: handle,
          authProvider: "local",
          createdAt: new Date(),
        })
        .run();
      if (role !== null) db.insert(memberships).values({ id: uuid(), workspaceId, userId: id, role }).run();
      return id;
    };
    db.insert(memberships)
      .values({ id: uuid(), workspaceId: s.workspaceId, userId: s.userId, role: "owner" })
      .run();
    const admin = person(s.workspaceId, "adm", "admin");
    person(s.workspaceId, "mem", "member");
    person(s.workspaceId, "nom", null);
    person(other.workspaceId, "farad", "admin");
    expect(createTriggerLookups(db, s.workspaceId).admins().sort()).toEqual([s.userId, admin].sort());
  });
});

describe("attachPushTriggers — 버스 배선", () => {
  const CH_ID = CH;
  const ALICE_ID = "0199a000-0000-7000-8000-00000000a11c";
  const DEV_ID = "0199a000-0000-7000-8000-000000000de0";
  const lookups = {
    channelName: () => "프로젝트",
    userHandle: () => "alice",
    agentHandle: () => "dev",
    automationName: () => undefined,
    humanMembers: () => [ALICE_ID],
    admins: () => [ALICE_ID],
    channelArchived: () => false,
    dmOwner: () => null,
    dmAgent: () => null,
  };
  const message = {
    id: uuid(),
    channelId: CH_ID,
    conversationId: CH_ID,
    seq: 1,
    kind: "normal" as const,
    authorType: "agent" as const,
    authorId: DEV_ID,
    bodyMd: "",
    mentions: { users: [ALICE_ID], agents: [] },
    attachments: [],
    interactions: [],
    reactions: [],
    createdAt: "2026-09-23T00:00:00.000Z",
  };
  const approval = {
    id: uuid(),
    providerApprovalId: "plugin:x",
    kind: "plugin" as const,
    channelId: CH_ID,
    conversationId: CH_ID,
    agentId: DEV_ID,
    title: "t",
    severity: "warning" as const,
    allowedDecisions: ["deny" as const],
    status: "pending" as const,
    expiresAt: "2026-09-23T00:02:00.000Z",
    createdAt: "2026-09-23T00:00:00.000Z",
  };

  it("message.created·approval.requested 를 발송기로 넘기고, 발송을 기다리지 않는다", () => {
    const bus = new ServerBus();
    const got: PushTarget[][] = [];
    const never = new Promise<void>(() => undefined);
    const t = attachPushTriggers(
      bus,
      {
        dispatch: (x) => {
          got.push(x);
          return never; // 끝나지 않는 발송 — emit 은 그래도 곧장 돌아온다
        },
      },
      lookups,
      captureLogger().logger,
    );
    bus.emit("message.created", { message });
    bus.emit("approval.requested", { approval });
    expect(got.map((x) => x.map((y) => [y.userId, y.payload.kind]))).toEqual([
      [[ALICE_ID, "mention"]],
      [[ALICE_ID, "approval"]],
    ]);
    t.close();
    bus.emit("message.created", { message });
    expect(got).toHaveLength(2);
  });

  it("같은 승인이 버스에 두 번 실려도(두 프레임 병합) 한 번만 보낸다", () => {
    const bus = new ServerBus();
    const got: PushTarget[][] = [];
    attachPushTriggers(bus, { dispatch: async (x) => void got.push(x) }, lookups, captureLogger().logger);
    bus.emit("approval.requested", { approval });
    bus.emit("approval.requested", { approval: { ...approval, urlPath: "/approve/x" } });
    bus.emit("approval.requested", { approval: { ...approval, id: uuid() } });
    expect(got).toHaveLength(2);
  });

  it("승인 기억은 1000개까지 — 넘으면 가장 오래된 것부터 잊는다(FIFO)", () => {
    const bus = new ServerBus();
    const got: PushTarget[][] = [];
    attachPushTriggers(bus, { dispatch: async (x) => void got.push(x) }, lookups, captureLogger().logger);
    const first = { ...approval, id: uuid() };
    const rest = Array.from({ length: 1000 }, () => ({ ...approval, id: uuid() }));
    bus.emit("approval.requested", { approval: first });
    for (const a of rest) bus.emit("approval.requested", { approval: a });
    expect(got).toHaveLength(1001);
    // 1001번째가 들어오며 first 가 밀려났다 — 다시 오면 또 보낸다
    bus.emit("approval.requested", { approval: first });
    expect(got).toHaveLength(1002);
    // first 가 다시 들어오며 rest[0] 이 밀려났고, 가장 최근 것은 아직 기억한다
    bus.emit("approval.requested", { approval: rest[999]! });
    expect(got).toHaveLength(1002);
    bus.emit("approval.requested", { approval: rest[0]! });
    expect(got).toHaveLength(1003);
  });

  it("트리거 계산이 던져도 버스로 번지지 않고 error 로그(사유만)", () => {
    const bus = new ServerBus();
    const cap = captureLogger();
    attachPushTriggers(
      bus,
      { dispatch: async () => undefined },
      {
        ...lookups,
        channelName: () => {
          throw new Error("db closed");
        },
      },
      cap.logger,
    );
    expect(() => bus.emit("message.created", { message })).not.toThrow();
    expect(cap.lines).toEqual([
      expect.objectContaining({ level: 50, event: "message.created", reason: "Error: db closed" }),
    ]);
    // [리뷰 m1] 정해진 필드만 — 오류 객체·메시지 본문은 없다
    expect(fieldsOf(cap.lines[0] as Record<string, unknown>)).toEqual(["event", "reason"]);
  });
});

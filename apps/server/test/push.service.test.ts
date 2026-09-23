import type { PushPayload } from "@dodok/shared";
import { eq } from "drizzle-orm";
import pino from "pino";
import { v7 as uuid } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import type { Db } from "../src/db/client";
import { channelMembers, pushSubscriptions, users } from "../src/db/schema.sqlite";
import { createPresence } from "../src/modules/push/presence";
import {
  attachPushTriggers,
  createPushDispatcher,
  createTriggerLookups,
  deleteSubscriptionById,
  listSubscriptions,
  type PushSend,
  pushTopic,
  upsertSubscription,
  webPushSender,
} from "../src/modules/push/service";
import { ServerBus } from "../src/realtime/bus";
import type { PushTarget } from "../src/modules/push/triggers";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent, seedWorkspace } from "./helpers/seed";

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
    upsertSubscription(db, alice, { endpoint: EP_A1, keys: KEYS_A }, "ua-a1");
    upsertSubscription(db, alice, { endpoint: EP_A2, keys: KEYS_A2 });
    upsertSubscription(db, bob, { endpoint: EP_B, keys: KEYS_B }, "ua-b");
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
const BODY = "@dev가 #프로젝트에서 불렀습니다";
const mention = (channelId = CH): PushPayload => ({
  kind: "mention",
  channelId,
  title: "dodok",
  body: BODY,
  url: `/c/${channelId}`,
  tag: `mention:${channelId}`,
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
  const dispatcher = () => createPushDispatcher({ db, logger: cap.logger, send, presence });
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
    upsertSubscription(db, alice, { endpoint: EP_A1, keys: KEYS_A });
    upsertSubscription(db, alice, { endpoint: EP_A2, keys: KEYS_A2 });
    upsertSubscription(db, bob, { endpoint: EP_B, keys: KEYS_B });
    calls = [];
    respond = async () => ({ statusCode: 201 });
    cap = captureLogger();
    presence = createPresence();
  });

  it("사용자 구독 둘 → 두 번, 본문은 JSON.stringify(payload), TTL 3600·urgency normal·topic", async () => {
    await dispatcher().dispatch([{ userId: alice, payload: mention() }]);
    expect(calls.map((c) => c.endpoint).sort()).toEqual([EP_A1, EP_A2].sort());
    for (const c of calls) {
      expect(c.body).toBe(JSON.stringify(mention()));
      expect(c.opts).toEqual({ TTL: 3600, urgency: "normal", topic: pushTopic(`mention:${CH}`) });
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
      { userId: bob, payload: approval },
      { userId: bob, payload: relay },
    ]);
    expect(calls.map((c) => c.opts)).toEqual([
      { TTL: 3600, urgency: "high", topic: pushTopic(`approval:${OTHER}`) },
      { TTL: 3600, urgency: "normal", topic: pushTopic(`relay:${CH}`) },
    ]);
  });

  it("[Review Focus 3] 그 채널을 보이는 탭으로 보고 있으면 보내지 않는다 — 다른 채널·백그라운드면 보낸다", async () => {
    presence.set("s1", alice, { visible: true, channelId: CH });
    await dispatcher().dispatch([
      { userId: alice, payload: mention(CH) },
      { userId: bob, payload: mention(CH) },
    ]);
    expect(calls.map((c) => c.endpoint)).toEqual([EP_B]);

    calls = [];
    await dispatcher().dispatch([{ userId: alice, payload: mention(OTHER) }]);
    expect(calls).toHaveLength(2);

    calls = [];
    presence.set("s1", alice, { visible: false, channelId: CH });
    await dispatcher().dispatch([{ userId: alice, payload: mention(CH) }]);
    expect(calls).toHaveLength(2);
  });

  it("[p4-c1] 거르기·성공 발송은 debug 한 줄씩 — 필드는 정해진 것만(다음 실연이 억제·발송·미도착을 가르게)", async () => {
    presence.set("s1", alice, { visible: true, channelId: CH });
    await dispatcher().dispatch([
      { userId: alice, payload: mention(CH) },
      { userId: bob, payload: mention(CH) },
    ]);
    const skipped = cap.lines.filter((l) => l.msg === "push skipped — watching");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ level: 20, userId: alice, channelId: CH, kind: "mention" });
    expect(fieldsOf(skipped[0] as Record<string, unknown>)).toEqual(["channelId", "kind", "userId"]);

    const sent = cap.lines.filter((l) => l.msg === "push sent");
    expect(sent).toHaveLength(1); // bob 의 구독 하나
    expect(sent[0]).toMatchObject({ level: 20, statusCode: 201 });
    expect(fieldsOf(sent[0] as Record<string, unknown>)).toEqual(["statusCode", "subscriptionId"]);
    expect(cap.lines).toHaveLength(2);
    // 본문·endpoint·keys 는 어디에도 없다
    const all = cap.raw.join("\n");
    for (const secret of [BODY, EP_B, EP_A1, KEYS_B.p256dh, KEYS_B.auth]) expect(all).not.toContain(secret);
  });

  it("구독이 없는 사람·빈 목록은 보내지 않는다", async () => {
    await dispatcher().dispatch([{ userId: uuid(), payload: mention() }]);
    await dispatcher().dispatch([]);
    expect(calls).toEqual([]);
  });

  it("404·410 → 그 구독만 지운다(다른 구독·남의 구독은 남는다)", async () => {
    respond = async (c) => ({ statusCode: c.endpoint === EP_A1 ? 410 : c.endpoint === EP_A2 ? 404 : 201 });
    await dispatcher().dispatch([
      { userId: alice, payload: mention() },
      { userId: bob, payload: mention() },
    ]);
    expect(endpoints(alice)).toEqual([]);
    expect(endpoints(bob)).toEqual([EP_B]);

    // 하나만 410
    upsertSubscription(db, alice, { endpoint: EP_A1, keys: KEYS_A });
    upsertSubscription(db, alice, { endpoint: EP_A2, keys: KEYS_A2 });
    respond = async (c) => ({ statusCode: c.endpoint === EP_A2 ? 410 : 201 });
    await dispatcher().dispatch([{ userId: alice, payload: mention() }]);
    expect(endpoints(alice)).toEqual([EP_A1]);
  });

  it("400·403·413 → error 로그, 구독은 지우지 않는다(403 은 VAPID 주체·키 문제)", async () => {
    for (const statusCode of [400, 403, 413]) {
      cap = captureLogger();
      respond = async () => ({ statusCode });
      await dispatcher().dispatch([{ userId: bob, payload: mention() }]);
      expect(endpoints(bob)).toEqual([EP_B]);
      const errors = cap.lines.filter((l) => l.level === 50);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ statusCode, userId: bob, kind: "mention" });
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
      await expect(dispatcher().dispatch([{ userId: alice, payload: mention() }])).resolves.toBeUndefined();
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
      { userId: alice, payload: mention() },
      { userId: bob, payload: mention() },
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
      await dispatcher().dispatch([{ userId: alice, payload: mention() }]);
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
    await expect(dispatcher().dispatch([{ userId: alice, payload: mention() }])).resolves.toBeUndefined();
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
    const SUB = ["kind", "subscriptionId", "userId"];
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
        fields: [...SUB, "statusCode"],
      },
      {
        name: "403",
        respond: async () => ({ statusCode: 403 }),
        level: 50,
        msg: "push rejected",
        fields: [...SUB, "statusCode"],
      },
      {
        name: "500",
        respond: async () => ({ statusCode: 500 }),
        level: 40,
        msg: "push send failed",
        fields: [...SUB, "statusCode"],
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
      upsertSubscription(db, bob, { endpoint: EP_B, keys: KEYS_B }); // 410 이 지운 뒤에도 다음 경우를 위해
      await dispatcher().dispatch([{ userId: bob, payload: mention() }]);
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
      send,
      presence: {
        isWatching: () => {
          throw leaky;
        },
      },
    });
    await expect(d.dispatch([{ userId: bob, payload: mention() }])).resolves.toBeUndefined();
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
    const pending = d.dispatch([{ userId: bob, payload: mention() }]);
    const t0 = Date.now();
    await d.drain(50); // 걸린 발송이 있어도 상한에서 돌아온다
    expect(Date.now() - t0).toBeLessThan(1000);
    release?.();
    await pending;
    await d.drain(5_000); // 비었으면 바로
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
});

describe("attachPushTriggers — 버스 배선", () => {
  const CH_ID = CH;
  const ALICE_ID = "0199a000-0000-7000-8000-00000000a11c";
  const DEV_ID = "0199a000-0000-7000-8000-000000000de0";
  const lookups = {
    channelName: () => "프로젝트",
    userHandle: () => "alice",
    agentHandle: () => "dev",
    humanMembers: () => [ALICE_ID],
  };
  const message = {
    id: uuid(),
    channelId: CH_ID,
    seq: 1,
    kind: "normal" as const,
    authorType: "agent" as const,
    authorId: DEV_ID,
    bodyMd: "",
    mentions: { users: [ALICE_ID], agents: [] },
    attachments: [],
    interactions: [],
    createdAt: "2026-09-23T00:00:00.000Z",
  };
  const approval = {
    id: uuid(),
    providerApprovalId: "plugin:x",
    kind: "plugin" as const,
    channelId: CH_ID,
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

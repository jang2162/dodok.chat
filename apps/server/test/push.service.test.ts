import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { pushSubscriptions, users } from "../src/db/schema.sqlite";
import { deleteSubscriptionById, listSubscriptions, upsertSubscription } from "../src/modules/push/service";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

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

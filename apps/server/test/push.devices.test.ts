import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { session as authSession } from "../src/db/auth-schema";
import { pushDevices } from "../src/db/schema.sqlite";
import { deleteDeviceById, listDevices, removeDevice, upsertDevice } from "../src/modules/push/devices";
import { sweepExpiredSessions } from "../src/realtime/socket";
import { bootTestApp, userWithRole } from "./helpers/app";

const TOKEN = "ab".repeat(32);
const IOS = { platform: "ios", token: TOKEN, appId: "chat.dodok.app", environment: "sandbox" } as const;
const ANDROID = { platform: "android", token: "fcm-token-1", appId: "chat.dodok.android" } as const;

describe("푸시 기기 저장소", () => {
  let app: App;
  let a: { id: string; sessionId: string };
  let b: { id: string; sessionId: string };

  const newSession = async (userId: string) => {
    const ctx = await app.auth.$context;
    return (await ctx.internalAdapter.createSession(userId)).id;
  };
  const rows = () => app.db.select().from(pushDevices).all();
  const rowOf = (token: string) => rows().find((r) => r.token === token);

  beforeAll(async () => {
    app = await bootTestApp();
    const ua = await userWithRole(app, "dev-a", "member");
    const ub = await userWithRole(app, "dev-b", "member");
    a = { id: ua.id, sessionId: await newSession(ua.id) };
    b = { id: ub.id, sessionId: await newSession(ub.id) };
  });
  afterAll(async () => {
    await app.close();
  });

  it("새 등록은 행을 만든다(iOS environment 보존, Android 는 null)", () => {
    const now = new Date(1_000_000);
    const ios = upsertDevice(app.db, a.id, a.sessionId, IOS, now);
    expect(ios).toMatchObject({
      userId: a.id,
      sessionId: a.sessionId,
      platform: "ios",
      token: TOKEN,
      appId: IOS.appId,
      environment: "sandbox",
      createdAt: now,
      lastSeenAt: now,
    });
    const android = upsertDevice(app.db, a.id, a.sessionId, ANDROID, now);
    expect(android.environment).toBeNull();
    expect(rows()).toHaveLength(2);
  });

  it("같은 사용자가 같은 토큰을 다시 등록하면 last_seen_at 만 바뀐다(id·created_at 유지)", () => {
    const first = rowOf(TOKEN);
    const later = new Date(2_000_000);
    const again = upsertDevice(app.db, a.id, a.sessionId, IOS, later);
    expect(again).toMatchObject({ id: first?.id, createdAt: first?.createdAt, lastSeenAt: later });
    expect(rows().filter((r) => r.token === TOKEN)).toHaveLength(1);
  });

  it("[Review Focus 1] 같은 토큰을 다른 사용자·세션이 등록하면 행이 옮겨 가고 옛 사용자 목록은 비는다", () => {
    const first = rowOf(TOKEN);
    const moved = upsertDevice(
      app.db,
      b.id,
      b.sessionId,
      { ...IOS, environment: "production", appId: "chat.dodok.app.beta" },
      new Date(3_000_000),
    );
    expect(moved).toMatchObject({
      id: first?.id,
      userId: b.id,
      sessionId: b.sessionId,
      environment: "production",
      appId: "chat.dodok.app.beta",
    });
    expect(rows().filter((r) => r.token === TOKEN)).toHaveLength(1);
    expect(listDevices(app.db, a.id).map((d) => d.token)).not.toContain(TOKEN);
    expect(listDevices(app.db, b.id).map((d) => d.token)).toEqual([TOKEN]);
  });

  it("removeDevice 는 남의 행을 지우지 않고, 자기 행은 지우고, 없는 토큰은 조용하다", () => {
    removeDevice(app.db, a.id, TOKEN); // 지금은 b 의 행
    expect(rowOf(TOKEN)).toBeDefined();
    removeDevice(app.db, a.id, "없는-토큰");
    removeDevice(app.db, b.id, TOKEN);
    expect(rowOf(TOKEN)).toBeUndefined();
  });

  it("세션을 지우면 그 세션의 기기가 cascade 로 지워진다", async () => {
    const sid = await newSession(a.id);
    upsertDevice(app.db, a.id, sid, { ...ANDROID, token: "cascade-token" }, new Date());
    app.db.delete(authSession).where(eq(authSession.id, sid)).run();
    expect(rowOf("cascade-token")).toBeUndefined();
  });

  it("만료된 세션의 기기는 청소 전에도 listDevices 에서 빠지고, 청소가 행을 지운다", async () => {
    const live = await newSession(a.id);
    const stale = await newSession(a.id);
    upsertDevice(app.db, a.id, live, { ...ANDROID, token: "live-token" }, new Date());
    upsertDevice(app.db, a.id, stale, { ...ANDROID, token: "stale-token" }, new Date());
    app.db
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSession.id, stale))
      .run();
    const tokens = listDevices(app.db, a.id).map((d) => d.token);
    expect(tokens).toContain("live-token");
    expect(tokens).not.toContain("stale-token");
    expect(rowOf("stale-token")).toBeDefined();
    sweepExpiredSessions(app.io, app.db);
    expect(rowOf("stale-token")).toBeUndefined();
    expect(rowOf("live-token")).toBeDefined();
  });

  it("deleteDeviceById 는 그 행 하나만 지운다", () => {
    const x = upsertDevice(app.db, a.id, a.sessionId, { ...ANDROID, token: "del-x" }, new Date());
    upsertDevice(app.db, a.id, a.sessionId, { ...ANDROID, token: "del-y" }, new Date());
    deleteDeviceById(app.db, x.id);
    expect(rowOf("del-x")).toBeUndefined();
    expect(rowOf("del-y")).toBeDefined();
  });
});

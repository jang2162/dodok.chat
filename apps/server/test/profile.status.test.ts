import type { MyStatus } from "@dodok/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { listPeople } from "../src/modules/members/people";
import {
  dndState,
  expireStatuses,
  readMyStatus,
  startStatusExpiry,
  updateMyStatus,
} from "../src/modules/profile/status";
import { ServerBus } from "../src/realtime/bus";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { recordBus } from "./helpers/control";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

// 사람의 상태·상태 메시지(프로필 스펙 3.2·3.3) — 수동 모드는 본인에게만, 상태 메시지는 사람 목록에

const T0 = new Date("2026-11-02T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const HOUR = 3_600_000;

function setup() {
  const db = newTestDb();
  const { workspaceId, userId } = seedWorkspace(db);
  return { db, workspaceId, userId };
}

describe("status 저장 — readMyStatus·updateMyStatus·dndState", () => {
  it("처음 사람은 auto·메시지 없음·방해 금지 중 승인 받기", () => {
    const { db, userId } = setup();
    expect(readMyStatus(db, userId, T0)).toEqual({
      mode: "auto",
      modeUntil: null,
      message: null,
      dndAllowApprovals: true,
    } satisfies MyStatus);
  });

  it("만료가 지난 수동 모드·상태 메시지·방해 금지는 타이머가 돌기 전에도 없는 것으로 읽는다", () => {
    const { db, userId } = setup();
    updateMyStatus(
      db,
      userId,
      {
        mode: "dnd",
        modeUntil: at(HOUR).toISOString(),
        message: { emoji: "🍱", text: "점심", until: at(HOUR).toISOString() },
      },
      T0,
    );
    expect(dndState(db, userId, at(HOUR - 1)).active).toBe(true);
    const later = at(HOUR + 1);
    expect(readMyStatus(db, userId, later)).toMatchObject({ mode: "auto", modeUntil: null, message: null });
    expect(dndState(db, userId, later)).toEqual({ active: false, allowApprovals: true });
  });

  it("과거 만료는 VALIDATION — 모드와 상태 메시지 둘 다", () => {
    const { db, userId } = setup();
    const past = at(-1).toISOString();
    expect(() => updateMyStatus(db, userId, { mode: "busy", modeUntil: past }, T0)).toThrow(
      expect.objectContaining({ status: 400, body: expect.objectContaining({ code: "VALIDATION" }) }),
    );
    expect(() =>
      updateMyStatus(db, userId, { message: { emoji: null, text: "x", until: past } }, T0),
    ).toThrow(expect.objectContaining({ status: 400 }));
    expect(readMyStatus(db, userId, T0).mode).toBe("auto");
  });

  it("바뀐 것을 가른다 — 메시지만이면 messageChanged, 모드만이면 modeChanged, 같은 값은 둘 다 false", () => {
    const { db, userId } = setup();
    const msg = updateMyStatus(db, userId, { message: { emoji: null, text: "회의", until: null } }, T0);
    expect([msg.messageChanged, msg.modeChanged]).toEqual([true, false]);
    const mode = updateMyStatus(db, userId, { mode: "busy", modeUntil: null }, T0);
    expect([mode.messageChanged, mode.modeChanged]).toEqual([false, true]);
    const same = updateMyStatus(db, userId, { mode: "busy", modeUntil: null }, T0);
    expect([same.messageChanged, same.modeChanged]).toEqual([false, false]);
    const option = updateMyStatus(db, userId, { dndAllowApprovals: false }, T0);
    expect(option.status.dndAllowApprovals).toBe(false);
    expect([option.messageChanged, option.modeChanged]).toEqual([false, false]);
  });

  it("auto 로 돌아가면 남은 만료를 지운다", () => {
    const { db, userId } = setup();
    updateMyStatus(db, userId, { mode: "away", modeUntil: at(HOUR).toISOString() }, T0);
    updateMyStatus(db, userId, { mode: "auto" }, T0);
    expect(readMyStatus(db, userId, T0)).toMatchObject({ mode: "auto", modeUntil: null });
  });
});

describe("expireStatuses·startStatusExpiry", () => {
  it("지난 값을 DB 에서 지우고 바뀐 사람을 돌려준다 — 메시지·모드를 따로", () => {
    const { db, workspaceId, userId } = setup();
    const other = seedWorkspace(db, { userHandle: "other" }).userId;
    updateMyStatus(db, userId, { message: { emoji: null, text: "a", until: at(HOUR).toISOString() } }, T0);
    updateMyStatus(db, other, { mode: "away", modeUntil: at(HOUR).toISOString() }, T0);
    expect(expireStatuses(db, at(HOUR - 1))).toEqual({ messageUserIds: [], modeUserIds: [] });
    expect(expireStatuses(db, at(HOUR))).toEqual({ messageUserIds: [userId], modeUserIds: [other] });
    expect(expireStatuses(db, at(HOUR))).toEqual({ messageUserIds: [], modeUserIds: [] });
    expect(listPeople(db, workspaceId, at(HOUR)).find((p) => p.id === userId)?.statusMessage).toBeNull();
  });

  it("타이머 한 번 — 메시지가 지면 people.changed 한 번, 사람마다 me.status, 모드가 지면 onModeChanged", () => {
    const { db, workspaceId, userId } = setup();
    const bus = new ServerBus();
    const seen: string[] = [];
    bus.on("people.changed", () => seen.push("people"));
    bus.on("me.status", (p) => seen.push(`me:${p.userId}:${p.status.mode}`));
    updateMyStatus(
      db,
      userId,
      {
        mode: "busy",
        modeUntil: at(HOUR).toISOString(),
        message: { emoji: null, text: "a", until: at(HOUR).toISOString() },
      },
      T0,
    );
    const modeChanged: string[] = [];
    let clock = at(HOUR + 1);
    const expiry = startStatusExpiry({
      db,
      bus,
      workspaceId,
      now: () => clock,
      onModeChanged: (id) => modeChanged.push(id),
    });
    try {
      expiry.tick();
      expect(seen).toEqual(["people", `me:${userId}:auto`]);
      expect(modeChanged).toEqual([userId]);
      clock = at(HOUR + 2);
      expiry.tick();
      expect(seen).toHaveLength(2);
    } finally {
      expiry.close();
    }
  });
});

describe("PUT /api/v1/me/status", () => {
  let app: App;
  let headers: { authorization: string };

  beforeAll(async () => {
    app = await bootTestApp();
    ({ headers } = await login(app));
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await app.fastify.inject({
      method: "PUT",
      url: "/api/v1/me/status",
      headers,
      payload: { mode: "auto", message: null },
    });
  });

  const put = (payload: object, h = headers) =>
    app.fastify.inject({ method: "PUT", url: "/api/v1/me/status", headers: h, payload });

  it("busy + 1시간 → 200, /auth/me 의 status 에 실린다", async () => {
    const until = new Date(Date.now() + HOUR).toISOString();
    const res = await put({ mode: "busy", modeUntil: until });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toMatchObject({ mode: "busy", modeUntil: until });
    const me = await app.fastify.inject({ method: "GET", url: "/api/v1/auth/me", headers });
    expect(me.json().status).toMatchObject({ mode: "busy", modeUntil: until, dndAllowApprovals: true });
  });

  it("과거 modeUntil → 400 VALIDATION", async () => {
    const res = await put({ mode: "busy", modeUntil: new Date(Date.now() - 1000).toISOString() });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION");
  });

  it("auto 에 만료 → 400 VALIDATION(스키마)", async () => {
    const res = await put({ mode: "auto", modeUntil: new Date(Date.now() + HOUR).toISOString() });
    expect(res.statusCode).toBe(400);
  });

  it("상태 메시지만 바꾸면 people.changed 한 번, 모드만 바꾸면 people.changed 없음 — 둘 다 me.status", async () => {
    const rec = recordBus(app, ["people.changed", "me.status"]);
    try {
      await put({ message: { emoji: "🌴", text: "휴가", until: null } });
      expect(rec.seen).toEqual(["me.status", "people.changed"]);
      rec.seen.length = 0;
      await put({ mode: "away", modeUntil: null });
      expect(rec.seen).toEqual(["me.status"]);
    } finally {
      rec.stop();
    }
    const people = await app.fastify.inject({ method: "GET", url: "/api/v1/people", headers });
    const me = (people.json().people as Array<{ id: string; statusMessage: unknown }>).find(
      (p) => p.id === app.ownerUserId,
    );
    expect(me?.statusMessage).toEqual({ emoji: "🌴", text: "휴가", until: null });
  });

  it("member 도 자기 상태를 바꾼다", async () => {
    const mia = await userWithRole(app, "mia", "member");
    const res = await put({ mode: "dnd", modeUntil: null }, { authorization: `Bearer ${mia.token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status.mode).toBe("dnd");
  });
});

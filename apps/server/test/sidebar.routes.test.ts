import type { SidebarLayout } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { channels } from "../src/db/schema.sqlite";
import { getSidebarLayout, saveSidebarLayout } from "../src/modules/sidebar/store";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { connectWire, recordEvents, waitFor, type WireClient } from "./helpers/wire";
import { newChannel } from "./helpers/control";
import { newTestDb } from "./helpers/db";
import { createDirectChannelForTest, seedWorkspace } from "./helpers/seed";

// 사이드바 개인 섹션(사이드바 섹션 스펙 B4·B7) — 사람마다 배치 한 벌, 본인만 읽고 쓴다

const layoutOf = (items: string[][]): SidebarLayout => ({
  sections: items.map((ids, i) => ({ id: uuid(), name: `섹션 ${i + 1}`, collapsed: false, items: ids })),
});

describe("store — getSidebarLayout·saveSidebarLayout", () => {
  it("행이 없으면 빈 배치, 저장하면 그대로 읽는다 — DB 에 없는 채널 id 만 걷는다", () => {
    const db = newTestDb();
    const { workspaceId, userId } = seedWorkspace(db);
    expect(getSidebarLayout(db, userId)).toEqual({ sections: [] });
    const real = createDirectChannelForTest(db, { workspaceId, createdBy: userId, userIds: [] }).id;
    const gone = uuid();
    const saved = saveSidebarLayout(db, userId, layoutOf([[gone, real]]));
    expect(saved.sections[0]?.items).toEqual([real]);
    expect(getSidebarLayout(db, userId)).toEqual(saved);
  });
});

describe("GET·PUT /api/v1/me/sidebar", () => {
  let app: App;
  let headers: { authorization: string };
  let token: string;
  const sockets: WireClient[] = [];

  beforeAll(async () => {
    app = await bootTestApp();
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    ({ headers, token } = await login(app));
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await app.close();
  });
  beforeEach(async () => {
    await put({ sections: [] });
  });

  const get = (h = headers) => app.fastify.inject({ method: "GET", url: "/api/v1/me/sidebar", headers: h });
  const put = (payload: object, h = headers) =>
    app.fastify.inject({ method: "PUT", url: "/api/v1/me/sidebar", headers: h, payload });

  it("처음 GET 은 빈 배치, PUT 뒤 GET 은 같은 값", async () => {
    expect((await get()).json()).toEqual({ sections: [] });
    const a = newChannel(app).id;
    const b = newChannel(app).id;
    const layout = layoutOf([[a], [b]]);
    const res = await put(layout);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(layout);
    expect((await get()).json()).toEqual(layout);
  });

  it("PUT 은 그 사람의 user 룸에만 me.sidebar 하나 — 본인의 다른 탭은 받고, 다른 사람은 받지 않는다", async () => {
    const other = await userWithRole(app, "noa-sidebar", "member");
    const mine = await connectWire(app, token);
    const theirs = await connectWire(app, other.token);
    sockets.push(mine, theirs);
    const mineSeen = recordEvents(mine, ["me.sidebar"]);
    const theirsSeen = recordEvents(theirs, ["me.sidebar"]);
    const seen: Array<{ userId: string; layout: SidebarLayout }> = [];
    const off = app.bus.on("me.sidebar", (p) => seen.push(p));
    try {
      const layout = layoutOf([[newChannel(app).id]]);
      const arrived = waitFor(mine, "me.sidebar");
      await put(layout);
      expect(await arrived).toEqual({ layout });
      expect(seen).toEqual([{ userId: app.ownerUserId, layout }]);
      // 다른 사람의 소켓 — 같은 서버를 한 번 더 돌고 본다
      await put(layout, { authorization: `Bearer ${other.token}` });
      await waitFor(theirs, "me.sidebar");
      expect(mineSeen).toHaveLength(1);
      expect(theirsSeen).toHaveLength(1);
    } finally {
      off();
    }
  });

  it("다른 사람의 배치와 섞이지 않는다 — 각자 자기 것만 읽는다", async () => {
    const mia = await userWithRole(app, "mia-sidebar", "member");
    const miaHeaders = { authorization: `Bearer ${mia.token}` };
    const mine = layoutOf([[newChannel(app).id]]);
    await put(mine);
    expect((await get(miaHeaders)).json()).toEqual({ sections: [] });
    const hers = layoutOf([[newChannel(app, { members: [mia.id] }).id]]);
    expect((await put(hers, miaHeaders)).statusCode).toBe(200);
    expect((await get(miaHeaders)).json()).toEqual(hers);
    expect((await get()).json()).toEqual(mine);
  });

  it("지금 읽을 수 없는 채널(남의 DM·보관 채널) id 는 200 이고 지우지 않는다 — 되살리면 원래 섹션 자리로(B7)", async () => {
    const other = await userWithRole(app, "kai-sidebar", "member");
    const third = await userWithRole(app, "lee-sidebar", "member");
    const othersDm = createDirectChannelForTest(app.db, {
      workspaceId: app.workspaceId,
      createdBy: other.id,
      userIds: [third.id],
    }).id;
    const archived = newChannel(app).id;
    const kept = newChannel(app).id;
    const layout = layoutOf([[kept, archived, othersDm]]);
    expect((await put(layout)).statusCode).toBe(200);
    app.db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archived)).run();
    // 보관 중에 다른 항목을 옮기는 PUT — 보관 채널 id 가 그 자리에 남는다
    const moved = { sections: [{ ...layout.sections[0]!, items: [archived, othersDm, kept] }] };
    const res = await put(moved);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(moved);
    expect((await get()).json().sections[0].items).toEqual([archived, othersDm, kept]);
  });

  it("DB 에 없는 채널 id 는 걷어 저장하고, 응답·wire 도 걷은 배치", async () => {
    const real = newChannel(app).id;
    const seen: SidebarLayout[] = [];
    const off = app.bus.on("me.sidebar", (p) => seen.push(p.layout));
    try {
      const res = await put(layoutOf([[uuid(), real]]));
      expect(res.json().sections[0].items).toEqual([real]);
      expect(seen[0]?.sections[0]?.items).toEqual([real]);
    } finally {
      off();
    }
  });

  it("상한 위반은 400 VALIDATION — 51개 섹션·41자 이름·두 섹션에 같은 채널", async () => {
    const c = newChannel(app).id;
    for (const bad of [
      layoutOf(Array.from({ length: 51 }, () => [])),
      { sections: [{ id: uuid(), name: "가".repeat(41), collapsed: false, items: [] }] },
      layoutOf([[c], [c]]),
    ]) {
      const res = await put(bad);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("VALIDATION");
    }
  });

  it("로그인 없으면 401", async () => {
    expect((await get({ authorization: "" })).statusCode).toBe(401);
    expect((await put({ sections: [] }, { authorization: "" })).statusCode).toBe(401);
  });
});

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { users } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { sweepAvatars } from "../src/modules/profile/avatars";
import { avatarsDirOf, bootTestApp, login, userWithRole } from "./helpers/app";
import { recordBus } from "./helpers/control";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { makePng } from "./helpers/png";

// 아바타(프로필 스펙 3.6) — 브라우저가 정사각형으로 만들어 올리고 서버는 형식·크기·가로세로만 본다

const GIF_1X1 = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const URL_RE = /^\/api\/v1\/avatars\/[0-9a-f]{64}\.png$/;

describe("아바타 REST", () => {
  let app: App;
  let owner: { authorization: string };
  let mia: { id: string; headers: { authorization: string } };
  let clock = 0;

  beforeAll(async () => {
    app = await bootTestApp({}, { limitClock: () => clock });
    ({ headers: owner } = await login(app));
    const m = await userWithRole(app, "mia", "member");
    mia = { id: m.id, headers: { authorization: `Bearer ${m.token}` } };
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    clock += 60_000; // 앞 시험의 업로드가 분당 상한을 채우지 않게
  });

  const put = (url: string, headers: { authorization: string }, body: Buffer, type = "image/png") =>
    app.fastify.inject({ method: "PUT", url, headers: { ...headers, "content-type": type }, payload: body });
  const del = (url: string, headers: { authorization: string }) =>
    app.fastify.inject({ method: "DELETE", url, headers });
  const get = (url: string, headers: { authorization: string } = owner) =>
    app.fastify.inject({ method: "GET", url, headers });

  it("256×256 png → 200, user.avatarUrl 이 내용 주소, GET 이 같은 바이트와 헤더 셋, people.changed", async () => {
    const png = makePng(256, 256, [10, 20, 30]);
    const rec = recordBus(app, ["people.changed"]);
    const res = await put("/api/v1/me/avatar", owner, png);
    rec.stop();
    expect(res.statusCode, res.body).toBe(200);
    const url = res.json().user.avatarUrl as string;
    expect(url).toMatch(URL_RE);
    expect(rec.seen).toEqual(["people.changed"]);
    const got = await get(url);
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(png)).toBe(true);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("조건을 어기면 400 VALIDATION — 문구에 어긴 조건", async () => {
    const notSquare = await put("/api/v1/me/avatar", owner, makePng(300, 200));
    expect(notSquare.statusCode).toBe(400);
    expect(notSquare.json()).toMatchObject({ code: "VALIDATION" });
    expect(notSquare.json().message).toContain("정사각형");
    const tiny = await put("/api/v1/me/avatar", owner, makePng(32, 32));
    expect(tiny.statusCode).toBe(400);
    expect(tiny.json().message).toContain("64");
    const huge = await put(
      "/api/v1/me/avatar",
      owner,
      Buffer.concat([makePng(256, 256), Buffer.alloc(262_145)]).subarray(0, 262_145),
    );
    expect(huge.statusCode).toBe(400);
    expect(huge.json()).toMatchObject({ code: "VALIDATION" });
    const gif = await put("/api/v1/me/avatar", owner, GIF_1X1, "image/gif");
    expect(gif.statusCode).toBe(400);
    expect(gif.json().message).toContain("형식");
  });

  it("[Review Focus 4] 두 사람이 같은 그림 → 한 사람이 바꿔도 다른 사람의 파일은 남는다", async () => {
    const shared = makePng(128, 128, [200, 0, 0]);
    const a = await put("/api/v1/me/avatar", owner, shared);
    const b = await put("/api/v1/me/avatar", mia.headers, shared);
    expect(a.json().user.avatarUrl).toBe(b.json().user.avatarUrl);
    const url = a.json().user.avatarUrl as string;
    const changed = await put("/api/v1/me/avatar", owner, makePng(128, 128, [0, 200, 0]));
    expect(changed.statusCode).toBe(200);
    expect((await get(url)).statusCode).toBe(200);
  });

  it("한 사람만 쓰던 그림을 DELETE → 파일 GET 404, avatarUrl 없음", async () => {
    const res = await put("/api/v1/me/avatar", mia.headers, makePng(96, 96, [1, 2, 3]));
    const url = res.json().user.avatarUrl as string;
    const removed = await del("/api/v1/me/avatar", mia.headers);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().user.avatarUrl).toBeUndefined();
    expect((await get(url)).statusCode).toBe(404);
  });

  it("에이전트 아바타 — admin 이상 PUT·DELETE, agents.changed, 응답에 agent", async () => {
    const agent = createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId: "avatarbot",
      handle: "avatarbot",
      name: "A",
      gatewayId: FAKE_GATEWAY_ID,
    });
    const rec = recordBus(app, ["agents.changed"]);
    const res = await put(`/api/v1/agents/${agent.id}/avatar`, owner, makePng(256, 256, [9, 9, 9]));
    expect(res.statusCode, res.body).toBe(200);
    const url = res.json().agent.avatarUrl as string;
    expect(url).toMatch(URL_RE);
    const removed = await del(`/api/v1/agents/${agent.id}/avatar`, owner);
    rec.stop();
    expect(removed.json().agent.avatarUrl).toBeUndefined();
    expect(rec.seen).toEqual(["agents.changed", "agents.changed"]);
    expect((await get(url)).statusCode).toBe(404);
    const forbidden = await put(`/api/v1/agents/${agent.id}/avatar`, mia.headers, makePng(64, 64));
    expect(forbidden.statusCode).toBe(403);
  });

  it("없는 에이전트에 PUT → 404, 디스크에 파일을 남기지 않는다", async () => {
    const dir = avatarsDirOf(app);
    if (!dir) throw new Error("아바타 디렉터리가 없다");
    const before = existsSync(dir) ? readdirSync(dir) : [];
    const res = await put(
      "/api/v1/agents/00000000-0000-4000-8000-0000000000aa/avatar",
      owner,
      makePng(96, 96, [1, 2, 3]),
    );
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual(before);
  });

  it("없는 파일·이름 모양이 아닌 경로는 404", async () => {
    expect((await get(`/api/v1/avatars/${"0".repeat(64)}.png`)).statusCode).toBe(404);
    expect((await get("/api/v1/avatars/..%2Fdodok.sqlite")).statusCode).toBe(404);
  });

  it("분당 11번째 업로드 → 429", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++)
      codes.push((await put("/api/v1/me/avatar", mia.headers, makePng(64, 64, [i, 0, 0]))).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it("부팅 청소 — 어느 행도 안 가리키는 파일은 지우고 가리키는 파일은 남긴다", async () => {
    const dir = avatarsDirOf(app);
    if (!dir) throw new Error("아바타 디렉터리가 없다");
    const kept = await put("/api/v1/me/avatar", owner, makePng(80, 80, [5, 5, 5]));
    const keptFile = (kept.json().user.avatarUrl as string).split("/").pop() as string;
    const orphan = `${"f".repeat(64)}.png`;
    writeFileSync(join(dir, orphan), makePng(80, 80));
    expect(await sweepAvatars(app.db, dir)).toBe(1);
    expect(existsSync(join(dir, orphan))).toBe(false);
    expect(readdirSync(dir)).toContain(keptFile);
    const owned = app.db
      .select({ url: users.avatarUrl })
      .from(users)
      .where(eq(users.id, app.ownerUserId))
      .get();
    expect(owned?.url).toBe(kept.json().user.avatarUrl);
  });
});

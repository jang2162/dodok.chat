import { eq } from "drizzle-orm";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { isLocalVapidSubject, loadConfig } from "../src/config";
import { pushSubscriptions, users } from "../src/db/schema.sqlite";
import { listSubscriptions } from "../src/modules/push/service";
import { bootTestApp, login } from "./helpers/app";
import { testEnv } from "./helpers/env";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-1";
const KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};
const KEYS2 = { p256dh: `${KEYS.p256dh.slice(0, -4)}AAAA`, auth: "AAAAAAAAAAAAAAAAAAAAAA" };

function captureLogger() {
  const lines: Array<{ level: number; msg?: string } & Record<string, unknown>> = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
  return { logger, lines };
}

/** 두 번째 사용자 — 가입이 막혀 있어 bootstrapOwner 처럼 Better Auth 내부 어댑터로 만들고 세션을 바로 낸다 */
async function secondUser(
  app: App,
  handle: string,
): Promise<{ id: string; headers: { authorization: string } }> {
  const ctx = await app.auth.$context;
  const id = uuid();
  await ctx.internalAdapter.createUser(
    { id, email: `${handle}@dodok.local`, name: handle, emailVerified: true },
    { method: "email-password" },
  );
  app.db
    .insert(users)
    .values({
      id,
      workspaceId: app.workspaceId,
      handle,
      displayName: handle,
      authProvider: "local",
      createdAt: new Date(),
    })
    .run();
  const session = await ctx.internalAdapter.createSession(id);
  return { id, headers: { authorization: `Bearer ${session.token}` } };
}

describe("푸시 경로 /api/v1/push", () => {
  let app: App;
  let a: { id: string; headers: { authorization: string } };
  let b: { id: string; headers: { authorization: string } };

  beforeAll(async () => {
    app = await bootTestApp();
    a = { id: app.ownerUserId, headers: (await login(app)).headers };
    b = await secondUser(app, "bee");
  });
  afterAll(async () => {
    await app.close();
  });

  const call = (
    who: { headers: { authorization: string } } | undefined,
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: object,
  ) =>
    app.fastify.inject({
      method,
      url: `/api/v1/push${url}`,
      headers: { ...who?.headers, "user-agent": "vitest-agent/1.0" },
      ...(payload === undefined ? {} : { payload }),
    });
  const rows = () => app.db.select().from(pushSubscriptions).all();

  it("GET /vapid-public-key → { publicKey }(설정의 공개키), 로그인 없으면 401", async () => {
    const res = await call(a, "GET", "/vapid-public-key");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ publicKey: testEnv.VAPID_PUBLIC_KEY });
    expect((await call(undefined, "GET", "/vapid-public-key")).statusCode).toBe(401);
  });

  it("로그인 없이 등록·해지하면 401", async () => {
    expect(
      (await call(undefined, "POST", "/subscriptions", { endpoint: ENDPOINT, keys: KEYS })).statusCode,
    ).toBe(401);
    expect((await call(undefined, "DELETE", "/subscriptions", { endpoint: ENDPOINT })).statusCode).toBe(401);
    expect(rows()).toEqual([]);
  });

  it("POST /subscriptions → 204, 행 하나(user_agent 저장). 같은 endpoint 다시 → 행 하나, keys 갱신", async () => {
    const res = await call(a, "POST", "/subscriptions", { endpoint: ENDPOINT, keys: KEYS });
    expect(res.statusCode).toBe(204);
    expect(rows()).toEqual([
      expect.objectContaining({
        userId: a.id,
        endpoint: ENDPOINT,
        keys: KEYS,
        userAgent: "vitest-agent/1.0",
      }),
    ]);
    const firstId = rows()[0]?.id;

    expect((await call(a, "POST", "/subscriptions", { endpoint: ENDPOINT, keys: KEYS2 })).statusCode).toBe(
      204,
    );
    expect(rows()).toEqual([expect.objectContaining({ id: firstId, userId: a.id, keys: KEYS2 })]);
  });

  it("[Review Focus 1] A 가 등록한 endpoint 를 B 가 등록하면 행 하나, user_id = B", async () => {
    expect((await call(a, "POST", "/subscriptions", { endpoint: ENDPOINT, keys: KEYS })).statusCode).toBe(
      204,
    );
    expect((await call(b, "POST", "/subscriptions", { endpoint: ENDPOINT, keys: KEYS2 })).statusCode).toBe(
      204,
    );
    const all = rows().filter((r) => r.endpoint === ENDPOINT);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ userId: b.id, keys: KEYS2 });

    // A 의 발송 목록에는 그 endpoint 가 없고 B 의 목록에만 있다 — A 에게 B 의 알림이 가지 않는다
    expect(listSubscriptions(app.db, a.id).map((s) => s.endpoint)).not.toContain(ENDPOINT);
    expect(listSubscriptions(app.db, b.id)).toContainEqual(
      expect.objectContaining({ endpoint: ENDPOINT, keys: KEYS2 }),
    );

    // A 는 이제 소유자가 아니다 — A 가 DELETE 해도 204 이고 B 의 행이 남는다
    expect((await call(a, "DELETE", "/subscriptions", { endpoint: ENDPOINT })).statusCode).toBe(204);
    expect(rows().filter((r) => r.endpoint === ENDPOINT)).toEqual([
      expect.objectContaining({ userId: b.id, keys: KEYS2 }),
    ]);
    expect(listSubscriptions(app.db, b.id)).toContainEqual(
      expect.objectContaining({ endpoint: ENDPOINT, keys: KEYS2 }),
    );
  });

  it("DELETE /subscriptions — 자기 것만 지운다. 남의 endpoint·없는 endpoint 도 204", async () => {
    const other = "https://web.push.apple.com/device-a";
    expect((await call(a, "POST", "/subscriptions", { endpoint: other, keys: KEYS })).statusCode).toBe(204);

    // B 가 A 의 endpoint 를 지우려 한다 → 204 이지만 A 의 행은 남는다
    expect((await call(b, "DELETE", "/subscriptions", { endpoint: other })).statusCode).toBe(204);
    expect(
      app.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, other)).get(),
    ).toMatchObject({ userId: a.id });

    // A 가 지운다 → 행 없음. 다시 지워도 204(멱등)
    expect((await call(a, "DELETE", "/subscriptions", { endpoint: other })).statusCode).toBe(204);
    expect(
      app.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, other)).get(),
    ).toBeUndefined();
    expect((await call(a, "DELETE", "/subscriptions", { endpoint: other })).statusCode).toBe(204);
    expect(
      (await call(a, "DELETE", "/subscriptions", { endpoint: "https://nope.example/x" })).statusCode,
    ).toBe(204);
  });

  it("잘못된 입력은 400 VALIDATION, 행을 만들지 않는다", async () => {
    const before = rows().length;
    for (const payload of [
      { endpoint: "http://push.example/x", keys: KEYS },
      { endpoint: `https://push.example/${"a".repeat(2048)}`, keys: KEYS },
      { endpoint: ENDPOINT, keys: { ...KEYS, auth: "a+b/c" } },
      { endpoint: ENDPOINT },
      {},
    ]) {
      const res = await call(a, "POST", "/subscriptions", payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION" });
    }
    expect((await call(a, "DELETE", "/subscriptions", {})).statusCode).toBe(400);
    expect((await call(a, "DELETE", "/subscriptions", { endpoint: "x".repeat(2049) })).statusCode).toBe(400);
    expect(rows()).toHaveLength(before);
  });
});

describe("VAPID 설정", () => {
  it("VAPID_SUBJECT 기본값은 mailto:dodok@localhost, mailto:·https: 가 아니면 설정 오류", () => {
    expect(loadConfig({ ...testEnv, VAPID_SUBJECT: undefined }).vapid).toEqual({
      publicKey: testEnv.VAPID_PUBLIC_KEY,
      privateKey: testEnv.VAPID_PRIVATE_KEY,
      subject: "mailto:dodok@localhost",
    });
    expect(loadConfig({ ...testEnv, VAPID_SUBJECT: "" }).vapid.subject).toBe("mailto:dodok@localhost");
    expect(loadConfig({ ...testEnv, VAPID_SUBJECT: "https://dodok.example.com" }).vapid.subject).toBe(
      "https://dodok.example.com",
    );
    for (const bad of ["ops@example.com", "http://dodok.example.com", "mailto:"]) {
      expect(() => loadConfig({ ...testEnv, VAPID_SUBJECT: bad })).toThrow(/VAPID_SUBJECT/);
    }
  });

  it("키 환경변수가 비었으면 undefined — 앱이 DATA_DIR/vapid.json 으로 간다", () => {
    const c = loadConfig({ ...testEnv, VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: undefined });
    expect(c.vapid.publicKey).toBeUndefined();
    expect(c.vapid.privateKey).toBeUndefined();
  });

  it("키 환경변수가 없으면 앱이 DATA_DIR/vapid.json 을 만들어 그 공개키를 낸다", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "dodok-vapid-app-"));
    let app: App | undefined;
    try {
      app = await bootTestApp({ DATA_DIR: dataDir, VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "" });
      const file = join(dataDir, "vapid.json");
      expect(existsSync(file)).toBe(true);
      const { publicKey } = JSON.parse(readFileSync(file, "utf8")) as { publicKey: string };
      const { headers } = await login(app);
      const res = await app.fastify.inject({ method: "GET", url: "/api/v1/push/vapid-public-key", headers });
      expect(res.json()).toEqual({ publicKey });
    } finally {
      await app?.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("mailto 주체에 @ 가 둘이면 마지막 @ 뒤가 호스트다 — a@b@localhost 는 로컬, a@localhost@example.com 은 로컬 아님", () => {
    expect(isLocalVapidSubject("mailto:a@b@localhost")).toBe(true);
    expect(isLocalVapidSubject("mailto:a@localhost@example.com")).toBe(false);
  });

  const localWarns = (lines: ReturnType<typeof captureLogger>["lines"]) =>
    lines.filter((l) => l.level === 40 && /VAPID subject is a local placeholder/.test(l.msg ?? ""));

  it("주체의 호스트가 로컬이면 시작 때 warn 한 번(주체를 싣는다), 실제 연락처면 0번", async () => {
    for (const [subject, expected] of [
      [undefined, 1],
      ["mailto:ops@localhost", 1],
      ["mailto:me@box.local", 1],
      ["https://127.0.0.1:8443", 1],
      ["https://localhost", 1],
      ["mailto:ops@example.com", 0],
      ["https://dodok.example.com/contact", 0],
      ["mailto:localhost@example.com", 0],
    ] as const) {
      const { logger, lines } = captureLogger();
      // 빈 값 = 설정 안 함 → 기본값 mailto:dodok@localhost
      const app = await bootTestApp({ VAPID_SUBJECT: subject ?? "" }, { logger });
      await app.close();
      const warns = localWarns(lines);
      expect({ subject, count: warns.length }).toEqual({ subject, count: expected });
      if (expected === 1)
        expect(warns[0]).toMatchObject({ vapidSubject: subject ?? "mailto:dodok@localhost" });
    }
  });
});

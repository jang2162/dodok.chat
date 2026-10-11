/**
 * 네이티브 푸시 통합(네이티브 푸시 계획 태스크 4·5) — 실제 앱 + 가짜 APNs(http2, 포트 0). 밖으로는 아무것도 보내지 않는다.
 * 앱은 환경 변수(APNS_KEY_PATH·APNS_HOST·APNS_CA_PATH …)로 통로를 켠다 — 부팅 배선까지 한 번에 본다.
 * 사람이 사람을 멘션하면 받는 사람에게 멘션 푸시가 간다. 보내는 쪽은 createUserMessage → 버스 → 트리거 → 디스패처다
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import pino from "pino";
import type { Logger } from "../../src/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../../src/app";
import { opsEvents, pushDevices } from "../../src/db/schema.sqlite";
import { addMember, createChannel } from "../../src/modules/channels/service";
import { createUserMessage } from "../../src/modules/messages/service";
import { type FakeApns, startFakeApns } from "../fakes/fake-apns";
import { bootTestApp, login, userWithRole } from "../helpers/app";
import { connectWire, type WireClient } from "../helpers/wire";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const IOS_TOKEN = "ab".repeat(32);
const IOS = { platform: "ios", token: IOS_TOKEN, appId: "chat.dodok.app", environment: "sandbox" };

type Booted = {
  app: App;
  owner: { token: string; headers: { authorization: string } };
  mia: { id: string };
  channelId: string;
  mention(n?: number): void;
  deviceRows(): Array<typeof pushDevices.$inferSelect>;
};

async function bootNative(env: Record<string, string>, logger?: Logger): Promise<Booted> {
  const app = await bootTestApp(env, logger === undefined ? {} : { logger });
  const owner = await login(app);
  const mia = await userWithRole(app, "mia", "member");
  const channel = createChannel(app.db, {
    workspaceId: app.workspaceId,
    createdBy: app.ownerUserId,
    name: "native",
  });
  addMember(app.db, channel.id, { memberType: "user", memberId: mia.id }, app.logger);
  let n = 0;
  return {
    app,
    owner,
    mia,
    channelId: channel.id,
    mention: (count = 1) => {
      for (let i = 0; i < count; i++)
        createUserMessage(app.db, app.bus, {
          channelId: channel.id,
          authorId: mia.id,
          bodyMd: "@owner 봐줘",
          clientMsgId: `native-${++n}`,
        });
    },
    deviceRows: () => app.db.select().from(pushDevices).all(),
  };
}

const register = (b: Booted, body: object) =>
  b.app.fastify.inject({
    method: "POST",
    url: "/api/v1/push/devices",
    headers: b.owner.headers,
    payload: body,
  });

describe("네이티브 푸시 통합 — APNs", () => {
  let dir: string;
  let fake: FakeApns;
  let b: Booted;
  const logLines: Array<Record<string, unknown>> = [];
  const sockets: WireClient[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-push-native-"));
    fake = await startFakeApns();
    const keyPath = join(dir, "key.p8");
    writeFileSync(
      keyPath,
      generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
    );
    logLines.length = 0;
    b = await bootNative(
      {
        APNS_KEY_PATH: keyPath,
        APNS_KEY_ID: "KEYID12345",
        APNS_TEAM_ID: "TEAMID1234",
        APNS_HOST: fake.host,
        APNS_CA_PATH: fake.caPath,
      },
      pino({ level: "warn" }, { write: (line: string) => void logLines.push(JSON.parse(line)) }),
    );
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    await b.app.close();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const untilRequests = (n: number) =>
    vi.waitFor(() => expect(fake.requests.length).toBeGreaterThanOrEqual(n), {
      timeout: 5_000,
      interval: 10,
    });
  const idle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
  const events = () =>
    b.app.db.select().from(opsEvents).where(eq(opsEvents.kind, "push_credentials_invalid")).all();

  it("능력에 ios 가 켜지고, 멘션을 받으면 가짜 APNs 가 요청 하나를 받는다", async () => {
    const caps = await b.app.fastify.inject({
      method: "GET",
      url: "/api/v1/push/capabilities",
      headers: b.owner.headers,
    });
    expect(caps.json()).toEqual({ webpush: true, ios: true, android: false });
    expect((await register(b, IOS)).statusCode).toBe(200);

    b.mention();
    await untilRequests(1);
    await idle();
    expect(fake.requests).toHaveLength(1);
    const [req] = fake.requests;
    expect(req?.path).toBe(`/3/device/${IOS_TOKEN}`);
    expect(req?.headers).toMatchObject({ "apns-topic": "chat.dodok.app", "apns-push-type": "alert" });
    expect(req?.body).toMatchObject({
      aps: { alert: { title: "dodok", body: "@mia가 #native에서 불렀습니다" }, "thread-id": b.channelId },
      dodok: { url: `/c/${b.channelId}`, kind: "mention", channelId: b.channelId },
    });
  });

  it("받는 사람이 그 채널을 보는 중이면 보내지 않고, 다른 채널을 보면 보낸다", async () => {
    await register(b, IOS);
    await b.app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const socket = await connectWire(b.app, b.owner.token);
    sockets.push(socket);
    const settle = () => socket.emitWithAck("channel.subscribe", { channelId: b.channelId });
    socket.emit("presence.update", { visible: true, channelId: b.channelId });
    await settle(); // 같은 소켓의 이벤트는 순서대로 처리된다 — 응답이 오면 presence 는 반영됐다
    b.mention();
    await idle(300);
    expect(fake.requests).toEqual([]);

    socket.emit("presence.update", { visible: false, channelId: b.channelId });
    await settle();
    b.mention();
    await untilRequests(1);
  });

  it("410 → 기기 행 삭제", async () => {
    await register(b, IOS);
    fake.reply(() => ({ status: 410, reason: "Unregistered" }));
    b.mention();
    await untilRequests(1);
    await vi.waitFor(() => expect(b.deviceRows()).toEqual([]), { timeout: 5_000, interval: 10 });
  });

  it("[Review Focus 5] 400 BadDeviceToken(환경을 잘못 등록한 기기) → 기기 행 삭제, 다른 400 은 행을 둔다", async () => {
    await register(b, IOS);
    fake.reply(() => ({ status: 400, reason: "PayloadEmpty" }));
    b.mention();
    await untilRequests(1);
    await idle();
    expect(b.deviceRows()).toHaveLength(1);
    fake.reply(() => ({ status: 400, reason: "BadDeviceToken" }));
    b.mention();
    await untilRequests(2);
    await vi.waitFor(() => expect(b.deviceRows()).toEqual([]), { timeout: 5_000, interval: 10 });
  });

  it("[Review Focus 2] 403 InvalidProviderToken 멘션이 연달아 와도 기기는 남고, 사건은 한 줄로 묶이고, JWT 는 하나다", async () => {
    await register(b, IOS);
    fake.reply(() => ({ status: 403, reason: "InvalidProviderToken" }));
    b.mention(4);
    await untilRequests(4);
    await vi.waitFor(() => expect(events()[0]?.count).toBe(4), { timeout: 5_000, interval: 10 });
    expect(events()).toEqual([
      expect.objectContaining({
        kind: "push_credentials_invalid",
        key: "push:apns",
        severity: "error",
        count: 4,
      }),
    ]);
    expect(b.deviceRows()).toHaveLength(1);
    expect(new Set(fake.requests.map((r) => r.headers.authorization)).size).toBe(1);
    // app.ts 가 APNs 통로에 앱 로거를 넘긴다 — 거부 사유는 고정된 reason 만, 토큰은 없다
    expect(logLines.find((l) => l.msg === "apns refused the push")).toMatchObject({
      transport: "apns",
      statusCode: 403,
      reason: "InvalidProviderToken",
    });
    expect(JSON.stringify(logLines)).not.toContain(IOS_TOKEN);
  });
});

describe("웹 푸시 통로 — 거부 사유 로그", () => {
  it("푸시 서비스가 403 으로 거부하면 앱 로거에 통로·statusCode 가 warn 으로 남고 endpoint 는 없다", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const logger = pino({ level: "warn" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    const ENDPOINT = "https://push.invalid/refused-1";
    const keys = {
      p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
      auth: "tBHItJI5svbpez7KI4CCXg",
    };
    const app = await bootTestApp({}, { logger, pushSend: async () => ({ statusCode: 403 }) });
    try {
      const owner = await login(app);
      const mia = await userWithRole(app, "mia", "member");
      const channel = createChannel(app.db, {
        workspaceId: app.workspaceId,
        createdBy: app.ownerUserId,
        name: "web",
      });
      addMember(app.db, channel.id, { memberType: "user", memberId: mia.id }, app.logger);
      const sub = await app.fastify.inject({
        method: "POST",
        url: "/api/v1/push/subscriptions",
        headers: owner.headers,
        payload: { endpoint: ENDPOINT, keys },
      });
      expect(sub.statusCode).toBe(204);
      createUserMessage(app.db, app.bus, {
        channelId: channel.id,
        authorId: mia.id,
        bodyMd: "@owner 봐줘",
        clientMsgId: "web-1",
      });
      await vi.waitFor(
        () => expect(lines.some((l) => l.msg === "web push service refused the push")).toBe(true),
        { timeout: 5_000, interval: 10 },
      );
      expect(lines.find((l) => l.msg === "web push service refused the push")).toMatchObject({
        transport: "webpush",
        statusCode: 403,
      });
      expect(JSON.stringify(lines)).not.toContain(ENDPOINT);
    } finally {
      await app.close();
    }
  });
});

describe("네이티브 푸시 부팅 로그", () => {
  const bootLogged = async (env: Record<string, string>) => {
    const lines: Array<Record<string, unknown>> = [];
    const logger = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    const dir = mkdtempSync(join(tmpdir(), "dodok-push-boot-"));
    const app = await bootTestApp({ DATA_DIR: dir, ...env }, { logger });
    return {
      app,
      lines,
      done: () => app.close().finally(() => rmSync(dir, { recursive: true, force: true })),
    };
  };

  it("키가 없으면 「apns: off(사유)」 한 줄과 ios 꺼짐, PUSH_RELAY_URL 은 warn 후 무시", async () => {
    const { app, lines, done } = await bootLogged({ PUSH_RELAY_URL: "https://relay.invalid" });
    try {
      expect(lines.map((l) => l.msg)).toContain("push transport apns: off(no key)");
      expect(lines.find((l) => String(l.msg).startsWith("PUSH_RELAY_URL"))).toMatchObject({ level: 40 });
      const caps = await app.fastify.inject({
        method: "GET",
        url: "/api/v1/push/capabilities",
        headers: (await login(app)).headers,
      });
      expect(caps.json()).toEqual({ webpush: true, ios: false, android: false });
    } finally {
      await done();
    }
  });

  it("깨진 키여도 부팅은 막히지 않고 「off(invalid key)」, 로그에 키 원문이 없다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-push-bad-key-"));
    const keyPath = join(dir, "key.p8");
    const garbage = "SECRET-KEY-MATERIAL-ZZZ";
    writeFileSync(keyPath, `-----BEGIN PRIVATE KEY-----\n${garbage}\n-----END PRIVATE KEY-----\n`);
    const { lines, done } = await bootLogged({ APNS_KEY_PATH: keyPath, APNS_KEY_ID: "K", APNS_TEAM_ID: "T" });
    try {
      expect(lines.map((l) => l.msg)).toContain("push transport apns: off(invalid key)");
      expect(JSON.stringify(lines)).not.toContain(garbage);
    } finally {
      await done();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

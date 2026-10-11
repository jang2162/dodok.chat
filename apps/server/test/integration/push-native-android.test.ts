/**
 * 네이티브 푸시 — FCM(Android) 통합. 실제 서버(`FCM_SERVICE_ACCOUNT_PATH`·`FCM_HOST`·`FCM_TOKEN_URI` 로 통로를 켠다) +
 * 가짜 Gateway·플러그인 + 가짜 FCM(토큰·발송 엔드포인트, 포트 0). 밖으로는 아무것도 보내지 않는다. 키는 테스트가 만든다.
 * APNs 사례는 태스크 4 의 push-native.test.ts 가 맡는다
 */
import { OpsEventsPage, type Message, PushPayload } from "@dodok/shared";
import { generateKeyPairSync } from "node:crypto";
import { type IncomingMessage, type Server, createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import pino from "pino";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../src/app";
import { listDevices } from "../../src/modules/push/devices";
import type { PushTransport } from "../../src/modules/push/transports/types";
import { type Scenario, createScenario } from "../fakes/scenario";
import { login } from "../helpers/app";
import { type LiveApp, bootLiveApp } from "../helpers/live-app";
import {
  type RelayChannel,
  type WireLog,
  WAIT_MS,
  openChannelWire,
  rest,
  sendMessage,
  setupRelayChannel,
} from "../helpers/scenario-steps";
import { type WireClient } from "../helpers/wire";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const DEVICE_TOKEN = "android-device-token-0001";
const WEB_EP = "https://push.invalid/owner-web";
const WEB_KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

type FcmRequest = { path: string; authorization: string | undefined; body: string };

describe("통합 — 네이티브 푸시: FCM", () => {
  let live: LiveApp | undefined;
  let fcm: Server | undefined;
  let dir: string | undefined;
  const sockets: WireClient[] = [];
  let sends: FcmRequest[];
  let tokenRequests: number;
  /** 발송 엔드포인트의 다음 응답 */
  let sendReply: { status: number; body?: unknown };

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    await live?.close();
    await new Promise<void>((r) => (fcm ? fcm.close(() => r()) : r()));
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    live = fcm = dir = undefined;
  });

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    });

  async function boot(deps: Omit<AppDeps, "adapter"> = {}) {
    sends = [];
    tokenRequests = 0;
    sendReply = { status: 200, body: { name: "projects/p/messages/1" } };
    fcm = createServer((req, res) => {
      void readBody(req).then((body) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/token") {
          tokenRequests += 1;
          res.end(JSON.stringify({ access_token: "access-fake", expires_in: 3599 }));
          return;
        }
        sends.push({ path: req.url ?? "", authorization: req.headers.authorization, body });
        res.statusCode = sendReply.status;
        res.end(JSON.stringify(sendReply.body ?? {}));
      });
    });
    await new Promise<void>((r) => fcm?.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(fcm.address() as AddressInfo).port}`;
    dir = mkdtempSync(join(tmpdir(), "fcm-int-"));
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const saPath = join(dir, "sa.json");
    writeFileSync(
      saPath,
      JSON.stringify({
        project_id: "dodok-int",
        client_email: "sa@dodok-int.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        token_uri: "https://oauth2.googleapis.com/token", // 기본값 — 가짜로는 FCM_TOKEN_URI 가 덮는다
      }),
    );
    live = await bootLiveApp({
      deps,
      env: { FCM_SERVICE_ACCOUNT_PATH: saPath, FCM_HOST: origin, FCM_TOKEN_URI: `${origin}/token` },
    });
  }

  const registerAndroid = async (token = DEVICE_TOKEN) => {
    const res = await live?.app.fastify.inject({
      method: "POST",
      url: "/api/v1/push/devices",
      headers: live.auth.headers,
      payload: { platform: "android", token, appId: "chat.dodok" },
    });
    expect(res?.statusCode).toBe(200);
  };

  async function untilTrue(cond: () => boolean, what: string) {
    const deadline = Date.now() + WAIT_MS;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`${what}: 시간 안에 안 됨`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async function startChannel(): Promise<{ setup: RelayChannel; log: WireLog; scenario: Scenario }> {
    if (live === undefined) throw new Error("not booted");
    const setup = await setupRelayChannel(live, { maxRelayTurns: 2, allowPairs: "all" as const });
    const log = await openChannelWire(live, setup.channel.id, sockets);
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: { dev: () => ({ reply: "@owner 확인했습니다" }) },
    });
    return { setup, log, scenario };
  }

  async function devTurn(log: WireLog, setup: RelayChannel, n: number): Promise<Message> {
    await sendMessage(log.socket, setup.channel.id, "@dev 봐줘");
    return log.until(
      () => log.created.filter((m) => m.authorType === "agent" && m.authorId === setup.dev.id)[n],
      `dev 답 ${n}`,
    );
  }

  const devices = () => (live ? listDevices(live.app.db, live.app.ownerUserId) : []);

  it("서비스 계정이 있으면 능력 android 가 켜지고, 멘션은 FCM 요청 하나(스펙 꼴·토큰 교환 한 번)로 간다", async () => {
    await boot();
    const caps = await rest<{ android: boolean; ios: boolean }>(live as LiveApp, "GET", "/push/capabilities");
    expect(caps.body).toMatchObject({ android: true, ios: false });
    await registerAndroid();
    const { setup, log, scenario } = await startChannel();
    await devTurn(log, setup, 0);
    await untilTrue(() => sends.length >= 1, "FCM 발송");
    expect(sends).toHaveLength(1);
    expect(tokenRequests).toBe(1);
    const [one] = sends;
    expect(one?.path).toBe("/v1/projects/dodok-int/messages:send");
    expect(one?.authorization).toBe("Bearer access-fake");
    const msg = (
      JSON.parse(one?.body ?? "{}") as { message: { token: string; data: Record<string, string> } }
    ).message;
    expect(msg.token).toBe(DEVICE_TOKEN);
    expect(msg.data).toEqual({ url: `/c/${setup.channel.id}`, kind: "mention", channelId: setup.channel.id });
    expect(scenario.errors).toEqual([]);
  });

  it("그 채널을 보고 있으면 FCM 으로 보내지 않는다", async () => {
    await boot();
    await registerAndroid();
    const { setup, log } = await startChannel();
    log.socket.emit("presence.update", { visible: true, channelId: setup.channel.id });
    await devTurn(log, setup, 0);
    await new Promise((r) => setTimeout(r, 100)); // 보내지 않았다는 것은 잠깐 기다려 본다 — 상한은 없다
    expect(sends).toEqual([]);
    expect(tokenRequests).toBe(0);
  });

  it("UNREGISTERED → 기기 행 삭제", async () => {
    await boot();
    await registerAndroid();
    sendReply = {
      status: 400,
      body: { error: { status: "INVALID_ARGUMENT", details: [{ errorCode: "UNREGISTERED" }] } },
    };
    const { setup, log } = await startChannel();
    await devTurn(log, setup, 0);
    await untilTrue(() => devices().length === 0, "기기 삭제");
    expect(sends).toHaveLength(1);
  });

  it("401 → 운영 사건 push_credentials_invalid 하나(연달아 와도 한 줄), 기기는 남는다", async () => {
    await boot();
    await registerAndroid();
    sendReply = { status: 401, body: { error: { status: "UNAUTHENTICATED" } } };
    const { setup, log } = await startChannel();
    await devTurn(log, setup, 0);
    await devTurn(log, setup, 1);
    await untilTrue(() => sends.length >= 2, "두 번째 발송");
    const l = live as LiveApp;
    await untilTrue(
      () => l.app.ops.list({}).events.some((e) => e.kind === "push_credentials_invalid"),
      "운영 사건",
    );
    const events = OpsEventsPage.parse((await rest<unknown>(l, "GET", "/ops/events")).body).events.filter(
      (e) => e.kind === "push_credentials_invalid",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: "push:fcm", severity: "error" });
    expect(devices()).toHaveLength(1);
  });

  it("iOS·Android·웹 구독을 가진 한 사람에게 셋 다 간다", async () => {
    const apnsSent: string[] = [];
    const webSent: string[] = [];
    const apns: PushTransport = {
      kind: "apns",
      send: async (t) => {
        apnsSent.push(t.kind === "device" ? t.token : "?");
        return "ok";
      },
    };
    await boot({
      pushTransports: { apns },
      pushSend: async (sub, body) => {
        PushPayload.parse(JSON.parse(body));
        webSent.push(sub.endpoint);
        return { statusCode: 201 };
      },
    });
    const l = live as LiveApp;
    await registerAndroid();
    // 세션당 기기 1행(PN5)이라 iOS 는 같은 사람의 다른 세션(다른 기기 로그인)으로 등록한다
    const iosSession = await login(l.app);
    const ios = await l.app.fastify.inject({
      method: "POST",
      url: "/api/v1/push/devices",
      headers: iosSession.headers,
      payload: { platform: "ios", token: "a".repeat(64), appId: "chat.dodok", environment: "sandbox" },
    });
    expect(ios.statusCode).toBe(200);
    const web = await l.app.fastify.inject({
      method: "POST",
      url: "/api/v1/push/subscriptions",
      headers: l.auth.headers,
      payload: { endpoint: WEB_EP, keys: WEB_KEYS },
    });
    expect(web.statusCode).toBe(204);
    const { setup, log } = await startChannel();
    await devTurn(log, setup, 0);
    await untilTrue(
      () => sends.length >= 1 && apnsSent.length >= 1 && webSent.length >= 1,
      `세 통로 fcm=${sends.length} apns=${apnsSent.length} web=${webSent.length}`,
    );
    expect(sends).toHaveLength(1);
    expect(apnsSent).toEqual(["a".repeat(64)]);
    expect(webSent).toEqual([WEB_EP]);
  });

  it("서비스 계정이 없으면 android 는 꺼지고 기기 등록은 PUSH_UNAVAILABLE", async () => {
    await boot();
    // 같은 앱에서 파일을 못 찾게 하는 대신, 파일 없는 별도 부팅
    await live?.close();
    const lines: Array<{ msg?: string }> = [];
    const logger = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    live = await bootLiveApp({
      deps: { logger },
      env: { FCM_SERVICE_ACCOUNT_PATH: join(dir ?? "", "missing.json") },
    });
    expect(lines.map((l) => l.msg)).toContain("push transport fcm: off(no service account)");
    const caps = await rest<{ android: boolean }>(live, "GET", "/push/capabilities");
    expect(caps.body.android).toBe(false);
    const res = await live.app.fastify.inject({
      method: "POST",
      url: "/api/v1/push/devices",
      headers: live.auth.headers,
      payload: { platform: "android", token: DEVICE_TOKEN, appId: "chat.dodok" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "PUSH_UNAVAILABLE" });
  });
});

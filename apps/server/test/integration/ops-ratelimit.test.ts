/**
 * 레이트리밋 통합(운영 보강 스펙 4장) — 가짜 Gateway·플러그인 위 실제 앱. 시계는 AppDeps.limitClock 으로 주입해 창·버킷을 넘긴다.
 * 숫자는 LIMITS 그대로 쓰되, 수백 번을 되풀이해야 하는 REST·업로드·Better Auth 는 AppDeps.limits 로 줄인다.
 */
import { type OpsEventKind, WIRE_PROTOCOL } from "@dodok/shared";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messages, opsEvents, runs } from "../../src/db/schema.sqlite";
import { LIMITS } from "../../src/modules/ops/limits";
import { bootLiveApp, type LiveApp, type LiveAppOptions } from "../helpers/live-app";
import { makePng } from "../helpers/png";
import { openChannelWire, rest, setupRelayChannel } from "../helpers/scenario-steps";
import { testEnv } from "../helpers/env";
import { connectWire, openWire, type WireClient } from "../helpers/wire";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const RELAY_POLICY = { maxRelayTurns: 2, allowPairs: "all" as const };
const BRIDGE_TOKEN = testEnv.BRIDGE_TOKEN as string;

describe("레이트리밋 통합", () => {
  const sockets: WireClient[] = [];
  let live: LiveApp | undefined;
  const clock = { t: Date.parse("2026-09-25T03:00:00.000Z"), now: () => clock.t };

  async function boot(deps: LiveAppOptions["deps"] = {}): Promise<LiveApp> {
    clock.t = Date.parse("2026-09-25T03:00:00.000Z");
    live = await bootLiveApp({ deps: { limitClock: clock.now, ...deps } });
    return live;
  }

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live?.close();
    live = undefined;
  });

  const opsRows = (l: LiveApp, kind: OpsEventKind) =>
    l.app.db.select().from(opsEvents).where(eq(opsEvents.kind, kind)).all();

  it("message.send 11번 연속 — 11번째는 저장·라우팅 전에 RATE_LIMITED, 1분 뒤 같은 clientMsgId 는 한 번만 저장된다", async () => {
    const l = await boot();
    const { channel } = await setupRelayChannel(l, RELAY_POLICY);
    const { socket } = await openChannelWire(l, channel.id, sockets);
    const ids = Array.from({ length: 11 }, () => randomUUID());
    const send = (clientMsgId: string) =>
      socket.emitWithAck("message.send", { channelId: channel.id, clientMsgId, bodyMd: "@dev 안녕" });

    const acks = [];
    for (const id of ids) acks.push(await send(id));
    expect(acks.slice(0, 10).every((a) => a.ok)).toBe(true);
    expect(acks[10]).toEqual({ ok: false, error: { code: "RATE_LIMITED", message: "too many requests" } });

    const userMessages = () =>
      l.app.db
        .select({ id: messages.id, clientMsgId: messages.clientMsgId })
        .from(messages)
        .where(and(eq(messages.channelId, channel.id), eq(messages.authorType, "user")))
        .all();
    const channelRuns = () => l.app.db.select().from(runs).where(eq(runs.channelId, channel.id)).all();
    expect(userMessages()).toHaveLength(10);
    await vi.waitFor(() => expect(channelRuns()).toHaveLength(10), { timeout: 5_000 });
    const saved = new Set(userMessages().map((m) => m.id));
    expect(channelRuns().every((r) => r.triggerMessageId !== null && saved.has(r.triggerMessageId))).toBe(
      true,
    );

    // 「다시 보내기」(Review Focus 4) — 1분 뒤 막혔던 id 는 한 번 저장·라우팅되고, 이미 저장된 id 는 런을 다시 띄우지 않는다
    clock.t += 60_000;
    expect((await send(ids[10] as string)).ok).toBe(true);
    expect((await send(ids[10] as string)).ok).toBe(true);
    expect((await send(ids[0] as string)).ok).toBe(true);
    expect(userMessages()).toHaveLength(11);
    await vi.waitFor(() => expect(channelRuns()).toHaveLength(11), { timeout: 5_000 });
    await new Promise((done) => setTimeout(done, 100));
    expect(channelRuns()).toHaveLength(11);

    const rows = opsRows(l, "ratelimit");
    expect(rows.map((r) => [r.key, r.severity, r.count])).toEqual([["wire:message.send", "info", 1]]);
    expect(rows[0]?.detail).toEqual({ ipPrefix: "127.0.0.0/24" });
  });

  it("ack 없는 typing 은 버킷을 넘으면 조용히 버린다", async () => {
    const l = await boot();
    const { channel } = await setupRelayChannel(l, RELAY_POLICY);
    const sender = await openChannelWire(l, channel.id, sockets);
    const watcher = await openChannelWire(l, channel.id, sockets);
    let typed = 0;
    watcher.socket.on("typing", () => (typed += 1));
    for (let i = 0; i < LIMITS.wire.chatter.burst + 5; i++)
      sender.socket.emit("typing", { channelId: channel.id });
    // 같은 연결의 ack 왕복 — 그 앞의 typing 은 모두 처리됐다
    await sender.socket.emitWithAck("channel.unsubscribe", { channelId: randomUUID() });
    await watcher.socket.emitWithAck("channel.unsubscribe", { channelId: randomUUID() });
    expect(typed).toBe(LIMITS.wire.chatter.burst);
    expect(opsRows(l, "ratelimit").map((r) => r.key)).toEqual(["wire:typing"]);
  });

  it("브리지 — 틀린 토큰 10번이면 정상 토큰도 60초 거절, 같은 주소의 /bridge/attachments 는 429, 60초 뒤 저절로 통과", async () => {
    const l = await boot();
    // 없는 첨부 — 인증을 지나면 404, 틀리면 401, 막히면 429 로 셋이 갈린다
    const attachment = { id: randomUUID() };

    for (let i = 0; i < 5; i++) await expect(l.plugin.reconnect({ token: "wrong" })).rejects.toThrow();
    // 첨부 HTTP 실패도 같은 카운터에 쌓인다
    for (let i = 0; i < 5; i++)
      expect((await l.plugin.downloadAttachment(attachment.id, { token: "wrong" })).status).toBe(401);

    await expect(l.plugin.reconnect({ token: BRIDGE_TOKEN })).rejects.toThrow(/UNAUTHORIZED/);
    const blockedHttp = await l.plugin.downloadAttachment(attachment.id, { token: BRIDGE_TOKEN });
    expect(blockedHttp.status).toBe(429);
    expect(JSON.parse(blockedHttp.bytes.toString())).toMatchObject({ code: "RATE_LIMITED" });

    const blocked = opsRows(l, "bridge_auth_blocked");
    expect(blocked.map((r) => [r.key, r.severity, r.count])).toEqual([["bridge", "warn", 1]]);
    expect(blocked[0]?.detail).toEqual({ ipPrefix: "127.0.0.0/24" });

    clock.t += 59_999;
    await expect(l.plugin.reconnect({ token: BRIDGE_TOKEN })).rejects.toThrow(/UNAUTHORIZED/);
    clock.t += 1;
    await l.plugin.reconnect({ token: BRIDGE_TOKEN });
    expect((await l.plugin.downloadAttachment(attachment.id)).status).toBe(404);
  });

  it("REST — 사용자당 분당 상한을 넘으면 429 RATE_LIMITED, 수백 번 걸려도 사건은 라우트 패턴당 한 줄", async () => {
    const l = await boot({ limits: { restPerMin: 20 } });
    const { channel } = await setupRelayChannel(l, RELAY_POLICY); // REST 6번
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await rest(l, "GET", `/channels/${channel.id}`)).status);
    expect(statuses.every((s) => s === 200)).toBe(true);
    const limited = await rest(l, "GET", `/channels/${channel.id}`);
    expect(limited).toEqual({ status: 429, body: { code: "RATE_LIMITED", message: "요청이 너무 많습니다" } });
    for (let i = 0; i < 300; i++) await rest(l, "GET", `/channels/${randomUUID()}`);
    await rest(l, "GET", "/channels");

    const rows = opsRows(l, "ratelimit");
    expect(rows.map((r) => [r.key, r.count]).sort()).toEqual([
      ["rest:/api/v1/channels", 1],
      ["rest:/api/v1/channels/:id", 301],
    ]);
    expect(JSON.stringify(rows)).not.toContain(channel.id);

    clock.t += 60_000;
    expect((await rest(l, "GET", `/channels/${channel.id}`)).status).toBe(200);
  });

  it("첨부 업로드 — REST 상한 위에 분당 업로드 상한이 한 번 더 걸린다", async () => {
    const l = await boot({ limits: { uploadPerMin: 2 } });
    const { channel } = await setupRelayChannel(l, RELAY_POLICY);
    const upload = () =>
      l.app.fastify.inject({
        method: "POST",
        url: `/api/v1/attachments?channelId=${channel.id}`,
        headers: { ...l.auth.headers, "content-type": "image/png" },
        payload: makePng(4, 4),
      });
    expect([(await upload()).statusCode, (await upload()).statusCode]).toEqual([200, 200]);
    const limited = await upload();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "RATE_LIMITED" });
    // 업로드가 아닌 REST 는 그대로 통과한다
    expect((await rest(l, "GET", `/channels/${channel.id}`)).status).toBe(200);
    expect(opsRows(l, "ratelimit").map((r) => r.key)).toEqual(["rest:/api/v1/attachments"]);
  });

  it("Better Auth /api/auth/* — IP 당 분당 상한을 넘으면 429", async () => {
    const l = await boot({ limits: { betterAuthPerMin: 3 } });
    const hit = () => l.app.fastify.inject({ method: "GET", url: "/api/auth/ok" });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await hit()).statusCode);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await hit()).json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(opsRows(l, "ratelimit").map((r) => [r.key, r.count])).toEqual([["rest:/api/auth/*", 2]]);
  });

  it("같은 사용자의 wire 소켓 21번째는 핸드셰이크에서 RATE_LIMITED 로 거절된다", async () => {
    const l = await boot();
    for (let i = 0; i < LIMITS.socketsPerUser; i++) sockets.push(await connectWire(l.app, l.auth.token));
    const extra = openWire(l.app, { token: l.auth.token, protocol: WIRE_PROTOCOL });
    sockets.push(extra);
    const error = await new Promise<Error & { data?: unknown }>((resolve) =>
      extra.once("connect_error", resolve),
    );
    expect(error.data).toEqual({ code: "RATE_LIMITED", message: "too many connections" });
    expect(opsRows(l, "ratelimit").map((r) => r.key)).toEqual(["wire:connect"]);

    // 하나를 닫으면 다시 들어온다
    sockets.shift()?.close();
    await vi.waitFor(async () => {
      const again = await connectWire(l.app, l.auth.token);
      sockets.push(again);
    });
  });

  it("/healthz 본문 키는 정확히 ok·db 다", async () => {
    const l = await boot();
    const res = await l.app.fastify.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(["db", "ok"]);
  });
});

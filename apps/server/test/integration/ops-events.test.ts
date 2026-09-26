/**
 * 운영 사건 팬아웃 — ops.event 는 owner·admin 소켓에만 간다(스펙 6·8장, 운영 화면은 admin 이상 — 팀 스펙 「역할과 권한」).
 * 앱이 app.ops 로 사건 서비스를 내놓고, 부팅 때 30일 지난 줄을 지운다.
 */
import { OpsEvent, OpsUnacked } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../../src/app";
import { createDb } from "../../src/db/client";
import { eq } from "drizzle-orm";
import { memberships, opsEvents, workspaces } from "../../src/db/schema.sqlite";
import { bootTestApp, login, userWithRole } from "../helpers/app";
import { connectWire, recordEvents, waitFor, type WireClient } from "../helpers/wire";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

/** 같은 연결의 ack 왕복 한 번 — 그 전에 서버가 보낸 이벤트는 이미 도착했다(없는 채널 구독은 NOT_FOUND ack) */
async function roundTrip(socket: WireClient): Promise<void> {
  await socket.timeout(2_000).emitWithAck("channel.subscribe", { channelId: uuid() });
}

describe("운영 사건 통합 — ops.event 팬아웃", () => {
  let app: App | undefined;
  const sockets: WireClient[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await app?.close();
    app = undefined;
  });

  it("app.ops.record → owner·admin 소켓이 {event, unacked} 를 받고 member 소켓은 받지 않는다", async () => {
    app = await bootTestApp({}, { pluginDirs: [] });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const { token } = await login(app);
    const owner = await connectWire(app, token);
    sockets.push(owner);
    const admin = await connectWire(app, (await userWithRole(app, "ada", "admin")).token);
    sockets.push(admin);
    const member = await connectWire(app, (await userWithRole(app, "bee", "member")).token);
    sockets.push(member);
    const memberSeen = recordEvents(member, ["ops.event"]);

    const got = waitFor(owner, "ops.event");
    const gotAdmin = waitFor(admin, "ops.event");
    const recorded = app.ops.record({
      kind: "run_failed",
      key: "agent:a",
      severity: "warn",
      detail: { code: "E" },
    });
    const payload = await got;
    expect(OpsEvent.parse(payload.event)).toEqual(recorded);
    expect(OpsUnacked.parse(payload.unacked)).toEqual({ warn: 1, error: 0 });
    expect(await gotAdmin).toEqual(payload);

    await roundTrip(member);
    expect(memberSeen).toHaveLength(0);
  });

  it("역할이 바뀌면 다음 사건부터 따른다 — member→owner 는 받기 시작하고 owner→member 는 그친다", async () => {
    app = await bootTestApp({}, { pluginDirs: [] });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const bee = await userWithRole(app, "bee", "member");
    const socket = await connectWire(app, bee.token);
    sockets.push(socket);
    const seen = recordEvents(socket, ["ops.event"]);
    const setRole = (role: string) =>
      app?.db.update(memberships).set({ role }).where(eq(memberships.userId, bee.id)).run();

    app.ops.record({ kind: "run_failed", key: "before", severity: "warn" });
    await roundTrip(socket);
    expect(seen).toHaveLength(0);

    setRole("owner");
    const got = waitFor(socket, "ops.event");
    app.ops.record({ kind: "run_failed", key: "promoted", severity: "warn" });
    expect((await got).event.key).toBe("promoted");

    setRole("member");
    app.ops.record({ kind: "run_failed", key: "demoted", severity: "warn" });
    await roundTrip(socket);
    expect(seen.map((e) => (e.payload as { event: { key: string } }).event.key)).toEqual(["promoted"]);
  });
});

describe("운영 사건 통합 — 부팅 정리", () => {
  it("부팅 때 last_at 이 30일 지난 줄을 지운다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-ops-"));
    const dbPath = join(dir, "app.db");
    try {
      const db = createDb(dbPath);
      const workspaceId = uuid();
      const old = new Date(Date.now() - 31 * 24 * 3_600_000);
      db.insert(workspaces).values({ id: workspaceId, name: "w", createdAt: old }).run();
      const row = { workspaceId, kind: "ratelimit", severity: "info", detail: {}, firstAt: old } as const;
      db.insert(opsEvents)
        .values([
          { ...row, id: uuid(), key: "old", lastAt: old },
          { ...row, id: uuid(), key: "fresh", lastAt: new Date() },
        ])
        .run();
      db.$client.close();

      const booted = await bootTestApp({ DB_PATH: dbPath }, { pluginDirs: [] });
      try {
        expect(booted.workspaceId).toBe(workspaceId);
        expect(
          booted.db
            .select({ key: opsEvents.key })
            .from(opsEvents)
            .all()
            .map((r) => r.key),
        ).toEqual(["fresh"]);
      } finally {
        await booted.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

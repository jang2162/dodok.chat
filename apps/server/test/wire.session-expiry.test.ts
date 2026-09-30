import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { session as authSession } from "../src/db/auth-schema";
import { sessionAlive } from "../src/realtime/socket";
import { bootTestApp, userWithRole } from "./helpers/app";
import { connectWire, type WireClient } from "./helpers/wire";

// 만료된 세션(30일)의 wire 소켓 — 주기 청소가 만료 행을 지우고 그 세션 방을 끊는다(realtime/socket.ts disconnectSessions)

describe("세션 만료 청소", () => {
  let app: App | undefined;
  const sockets: WireClient[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    await app?.close();
    app = undefined;
  });

  const sessionOf = (a: App, userId: string) => {
    const row = a.db.select().from(authSession).where(eq(authSession.userId, userId)).get();
    if (!row) throw new Error("session not found");
    return row;
  };
  const setExpiry = (a: App, id: string, expiresAt: Date) =>
    a.db.update(authSession).set({ expiresAt }).where(eq(authSession.id, id)).run();

  it("만료된 세션의 행을 지우고 그 소켓을 끊는다 — 늘어난(아직 안 끝난) 세션은 행과 소켓이 남는다", async () => {
    app = await bootTestApp({}, { sessionSweepIntervalMs: 20 });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const expired = await userWithRole(app, "expired1", "member");
    const extended = await userWithRole(app, "extended1", "member");
    const cut = await connectWire(app, expired.token);
    const kept = await connectWire(app, extended.token);
    sockets.push(cut, kept);
    const cutRow = sessionOf(app, expired.id);
    const keptRow = sessionOf(app, extended.id);

    const reason = new Promise<string>((resolve) => cut.once("disconnect", resolve));
    // 한쪽은 끝났고, 다른 쪽은 끝날 뻔했다가 REST 호출로 늘어난 세션(Better Auth updateAge)
    setExpiry(app, cutRow.id, new Date(Date.now() - 1_000));
    setExpiry(app, keptRow.id, new Date(Date.now() + 30 * 86_400_000));
    expect(await reason).toBe("io server disconnect");

    expect(app.db.select().from(authSession).where(eq(authSession.id, cutRow.id)).get()).toBeUndefined();
    expect(app.db.select().from(authSession).where(eq(authSession.id, keptRow.id)).get()).toBeDefined();
    expect(kept.connected).toBe(true);
    const ack = await new Promise<{ ok: boolean }>((resolve) =>
      kept.emit("channel.unsubscribe", { channelId: uuidv7() }, resolve),
    );
    expect(ack.ok).toBe(true);
  });

  it("sessionAlive — 행이 있어도 만료 시각이 지났으면 false(connection 재확인)", async () => {
    app = await bootTestApp({}, { sessionSweepIntervalMs: 3600_000 });
    const u = await userWithRole(app, "alive1", "member");
    const row = sessionOf(app, u.id);
    expect(sessionAlive(app.db, row.id)).toBe(true);
    setExpiry(app, row.id, new Date(Date.now() - 1_000));
    expect(sessionAlive(app.db, row.id)).toBe(false);
    expect(sessionAlive(app.db, uuidv7())).toBe(false);
  });
});

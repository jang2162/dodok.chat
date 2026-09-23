import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { workspaces } from "../src/db/schema.sqlite";
import { bootTestApp } from "./helpers/app";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("createApp", () => {
  it("/healthz 는 인증 없이 db·adapter 상태를 낸다", async () => {
    const adapter = new FakeAdapter();
    adapter.setStatus({ provider: "openclaw", gateway: "down", bridge: "down" });
    app = await bootTestApp({}, { adapter });
    const res = await app.fastify.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      db: "ok",
      adapter: { provider: "openclaw", gateway: "down", bridge: "down" },
      workspace: expect.any(String),
    });
  });
  it("워크스페이스가 없으면 부팅 때 하나 만든다", async () => {
    app = await bootTestApp();
    const rows = app.db.select().from(workspaces).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("dodok");
    expect(rows[0]?.id).toBe(app.workspaceId);
  });
  it("Fastify 의 4xx(잘못된 JSON)는 500 이 아니라 그 상태 코드와 ApiError 로 답한다", async () => {
    app = await bootTestApp();
    const res = await app.fastify.inject({
      method: "POST",
      url: "/healthz",
      headers: { "content-type": "application/json" },
      payload: "{bad",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json()).toEqual({
      code: expect.stringMatching(/^(VALIDATION|NOT_FOUND)$/),
      message: expect.any(String),
    });
  });
  it("DATA_DIR 이 없으면 부팅 때 만든다", async () => {
    const base = mkdtempSync(join(tmpdir(), "dodok-app-"));
    const dbPath = join(base, "nested", "dodok.sqlite");
    try {
      app = await bootTestApp({ DB_PATH: dbPath });
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      await app?.close();
      app = undefined;
      rmSync(base, { recursive: true, force: true });
    }
  });
});

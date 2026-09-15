import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { workspaces } from "../src/db/schema.sqlite";
import { testEnv } from "./helpers/env";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("createApp", () => {
  it("/healthz 는 인증 없이 db·adapter 상태를 낸다", async () => {
    app = await createApp(loadConfig(testEnv), {});
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
    app = await createApp(loadConfig(testEnv), {});
    const rows = app.db.select().from(workspaces).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("dodok");
    expect(rows[0]?.id).toBe(app.workspaceId);
  });
});

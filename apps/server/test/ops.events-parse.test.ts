import pino from "pino";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { opsEvents } from "../src/db/schema.sqlite";
import { bootTestApp, login } from "./helpers/app";

// ops/status 밖의 응답도 계약 스키마로 다시 읽는다(parseStored) — 저장값이 계약을 어기면 그대로 내보내지 않고 500
describe("GET /api/v1/ops/events — 응답 스키마 파싱", () => {
  let app: App;
  let owner: { authorization: string };

  beforeAll(async () => {
    // 500 의 「internal error」 로그가 테스트 출력을 덮지 않게
    app = await bootTestApp({}, { logger: pino({ level: "silent" }) });
    owner = (await login(app)).headers;
  });
  afterAll(async () => {
    await app.close();
  });

  it("detail 에 계약 밖 값(중첩 객체)이 든 줄이 있으면 500 INTERNAL — 저장값을 그대로 내보내지 않는다", async () => {
    const at = new Date();
    // 확인한 줄로 넣는다 — unacked 캐시(서비스가 센 값)와 어긋나지 않게
    app.db
      .insert(opsEvents)
      .values({
        id: uuid(),
        workspaceId: app.workspaceId,
        kind: "run_failed",
        severity: "warn",
        key: "agent:x",
        detail: { nested: { a: 1 } } as never,
        count: 1,
        firstAt: at,
        lastAt: at,
        ackedAt: at,
      })
      .run();
    const res = await app.fastify.inject({ method: "GET", url: "/api/v1/ops/events", headers: owner });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: "INTERNAL" });
  });
});

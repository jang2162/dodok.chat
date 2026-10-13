/**
 * 개인 토큰(제어 MCP 스펙 「개인 토큰(PAT)」 절) — 발급·목록·폐기·검증. 비활성화 때 폐기는 members.deactivate.test.ts,
 * 세 역할의 REST 허용은 roles.matrix.test.ts
 */
import { PERSONAL_TOKENS_MAX, PersonalTokenIssued, PersonalTokenSummary } from "@dodok/shared";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { personalTokens } from "../src/db/schema.sqlite";
import {
  issuePersonalToken,
  listPersonalTokens,
  PERSONAL_TOKEN_LAST_USED_INTERVAL_MS,
  revokePersonalToken,
  verifyPersonalToken,
} from "../src/modules/tokens/service";
import { bootTestApp, userWithRole } from "./helpers/app";

describe("개인 토큰", () => {
  let app: App;
  let n = 0;

  beforeAll(async () => {
    app = await bootTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const someone = () => userWithRole(app, `pat${++n}`, "member");
  const rowOf = (id: string) => app.db.select().from(personalTokens).where(eq(personalTokens.id, id)).get();
  const call = (token: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
    app.fastify.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });

  describe("서비스", () => {
    it("원문은 dpt_ + base64url 32바이트, 저장은 sha256 hex 와 앞 6자뿐 — 원문은 어느 열에도 없다", async () => {
      const user = await someone();
      const issued = issuePersonalToken(app.db, user.id, "  laptop  ");
      expect(issued.raw).toMatch(/^dpt_[A-Za-z0-9_-]{43}$/);
      expect(issued.token).toMatchObject({ label: "laptop", prefix: issued.raw.slice(4, 10) });
      expect(issued.token.lastUsedAt).toBeUndefined();
      const row = rowOf(issued.token.id);
      expect(row?.hash).toBe(createHash("sha256").update(issued.raw).digest("hex"));
      expect(
        Object.values(row ?? {}).some((v) => typeof v === "string" && v.includes(issued.raw.slice(4))),
      ).toBe(false);
    });

    it("라벨이 비거나 40자를 넘으면 VALIDATION", async () => {
      const user = await someone();
      for (const label of ["   ", "x".repeat(41)])
        expect(() => issuePersonalToken(app.db, user.id, label)).toThrow(
          expect.objectContaining({ body: expect.objectContaining({ code: "VALIDATION" }) }),
        );
    });

    it(`살아 있는 토큰이 ${PERSONAL_TOKENS_MAX}개면 다음은 CONFLICT — 하나 폐기하면 다시 된다, 다른 사람은 따로 센다`, async () => {
      const user = await someone();
      const issued = Array.from({ length: PERSONAL_TOKENS_MAX }, (_, i) =>
        issuePersonalToken(app.db, user.id, `t${i}`),
      );
      expect(() => issuePersonalToken(app.db, user.id, "eleventh")).toThrow(
        expect.objectContaining({ body: expect.objectContaining({ code: "CONFLICT" }) }),
      );
      expect(listPersonalTokens(app.db, user.id)).toHaveLength(PERSONAL_TOKENS_MAX);
      issuePersonalToken(app.db, (await someone()).id, "other");
      revokePersonalToken(app.db, user.id, (issued[0] as PersonalTokenIssued).token.id);
      expect(issuePersonalToken(app.db, user.id, "again").token.label).toBe("again");
    });

    it("검증 — 맞는 원문이면 id·주인, 폐기 뒤·틀린 값·해시 그대로·접두어 없음은 undefined", async () => {
      const user = await someone();
      const { raw, token } = issuePersonalToken(app.db, user.id, "cli");
      expect(verifyPersonalToken(app.db, raw)).toEqual({ tokenId: token.id, userId: user.id });
      const hash = rowOf(token.id)?.hash ?? "";
      for (const wrong of [`${raw}x`, raw.slice(0, -1), hash, raw.slice(4), "", undefined, 42])
        expect(verifyPersonalToken(app.db, wrong)).toBeUndefined();
      revokePersonalToken(app.db, user.id, token.id);
      expect(verifyPersonalToken(app.db, raw)).toBeUndefined();
    });

    it("lastUsedAt 은 1분에 한 번까지만 쓴다", async () => {
      const user = await someone();
      const { raw, token } = issuePersonalToken(app.db, user.id, "cli");
      const t0 = new Date("2026-10-12T00:00:00.000Z");
      verifyPersonalToken(app.db, raw, t0);
      expect(rowOf(token.id)?.lastUsedAt).toEqual(t0);
      verifyPersonalToken(app.db, raw, new Date(t0.getTime() + PERSONAL_TOKEN_LAST_USED_INTERVAL_MS - 1));
      expect(rowOf(token.id)?.lastUsedAt).toEqual(t0);
      const t1 = new Date(t0.getTime() + PERSONAL_TOKEN_LAST_USED_INTERVAL_MS);
      verifyPersonalToken(app.db, raw, t1);
      expect(rowOf(token.id)?.lastUsedAt).toEqual(t1);
      expect(listPersonalTokens(app.db, user.id)[0]?.lastUsedAt).toBe(t1.toISOString());
    });

    it("폐기는 주인만 — 남의 토큰은 NOT_FOUND 이고 그대로 산다. 두 번 폐기해도 처음 시각 그대로", async () => {
      const owner = await someone();
      const stranger = await someone();
      const { raw, token } = issuePersonalToken(app.db, owner.id, "cli");
      expect(() => revokePersonalToken(app.db, stranger.id, token.id)).toThrow(
        expect.objectContaining({ body: expect.objectContaining({ code: "NOT_FOUND" }) }),
      );
      expect(verifyPersonalToken(app.db, raw)).toBeDefined();
      const first = new Date("2026-10-12T01:00:00.000Z");
      revokePersonalToken(app.db, owner.id, token.id, first);
      revokePersonalToken(app.db, owner.id, token.id, new Date("2026-10-12T02:00:00.000Z"));
      expect(rowOf(token.id)?.revokedAt).toEqual(first);
    });
  });

  describe("REST /api/v1/me/tokens", () => {
    it("발급 201 → 목록에 원문 없이 보임 → 폐기 204 → 목록에서 빠짐", async () => {
      const user = await someone();
      const created = await call(user.token, "POST", "/api/v1/me/tokens", { label: "desktop" });
      expect(created.statusCode).toBe(201);
      const issued = PersonalTokenIssued.parse(created.json());

      const listed = await call(user.token, "GET", "/api/v1/me/tokens");
      expect(listed.statusCode).toBe(200);
      expect(listed.body).not.toContain(issued.raw);
      expect(PersonalTokenSummary.array().parse(listed.json().tokens)).toEqual([issued.token]);

      expect((await call(user.token, "DELETE", `/api/v1/me/tokens/${issued.token.id}`)).statusCode).toBe(204);
      expect((await call(user.token, "GET", "/api/v1/me/tokens")).json()).toEqual({ tokens: [] });
    });

    it("목록은 자기 것만 — 다른 사람의 토큰은 보이지 않는다", async () => {
      const a = await someone();
      const b = await someone();
      issuePersonalToken(app.db, a.id, "a-only");
      expect((await call(b.token, "GET", "/api/v1/me/tokens")).json()).toEqual({ tokens: [] });
    });

    it("본문이 틀리면 400, 개인 토큰을 세션처럼 쓰면 401", async () => {
      const user = await someone();
      expect((await call(user.token, "POST", "/api/v1/me/tokens", { label: "" })).statusCode).toBe(400);
      const { raw } = issuePersonalToken(app.db, user.id, "cli");
      expect((await call(raw, "GET", "/api/v1/me/tokens")).statusCode).toBe(401);
    });
  });
});

import { BridgeTokenRecord } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { bridgeTokens } from "../src/db/schema.sqlite";
import { HttpError } from "../src/http/errors";
import {
  BRIDGE_TOKEN_LAST_USED_INTERVAL_MS,
  importEnvToken,
  isActiveBridgeToken,
  issueBridgeToken,
  listBridgeTokens,
  revokeBridgeToken,
  verifyBridgeTokenDb,
} from "../src/modules/setup/tokens";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

const ENV_TOKEN = "e".repeat(32);
const T0 = new Date("2026-09-24T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let db: Db;
let ws: string;

beforeEach(() => {
  db = newTestDb();
  ws = seedWorkspace(db).workspaceId;
});

const rows = () => db.select().from(bridgeTokens).all();

describe("issueBridgeToken", () => {
  it("원문은 dbt_ + base64url 43자, 기록은 계약 모양이고 prefix 는 dbt_ 뒤 6자", () => {
    const { token, record } = issueBridgeToken(db, ws, "  laptop  ", T0);
    expect(token).toMatch(/^dbt_[A-Za-z0-9_-]{43}$/);
    expect(BridgeTokenRecord.parse(record)).toEqual(record);
    expect(record).toMatchObject({
      label: "laptop",
      prefix: token.slice(4, 10),
      createdAt: T0.toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      connected: false,
    });
  });

  it("DB 에는 원문이 없다 — 행 전체 JSON 에 원문의 어떤 12자 조각도 없고 hash 는 sha256(원문)", () => {
    const { token } = issueBridgeToken(db, ws, "a", T0);
    const [row] = rows();
    const dump = JSON.stringify(db.$client.prepare("SELECT * FROM bridge_tokens").all());
    for (let i = 0; i + 12 <= token.length; i += 1) expect(dump).not.toContain(token.slice(i, i + 12));
    expect(row?.hash).toBe(createHash("sha256").update(token).digest("hex"));
  });

  it("발급마다 다른 원문", () => {
    const a = issueBridgeToken(db, ws, "a").token;
    const b = issueBridgeToken(db, ws, "b").token;
    expect(a).not.toBe(b);
  });

  it("라벨이 비었거나 61자면 VALIDATION 으로 거부하고 행을 만들지 않는다 — 60자는 된다", () => {
    for (const label of ["", "   ", "x".repeat(61)]) {
      let error: unknown;
      try {
        issueBridgeToken(db, ws, label);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).body.code).toBe("VALIDATION");
    }
    expect(rows()).toHaveLength(0);
    expect(issueBridgeToken(db, ws, "x".repeat(60)).record.label).toHaveLength(60);
  });

  it("라벨 env 는 대소문자·앞뒤 공백과 무관하게 VALIDATION — 이어받은 토큰의 표지다. envoy 처럼 env 를 품은 라벨은 된다", () => {
    for (const label of ["env", "ENV", " Env ", "\tenv\n"]) {
      let error: unknown;
      try {
        issueBridgeToken(db, ws, label);
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(label)).toBeInstanceOf(HttpError);
      expect((error as HttpError).body).toMatchObject({
        code: "VALIDATION",
        message: "env 는 .env 에서 이어받은 토큰에만 쓰는 라벨입니다",
      });
    }
    expect(rows()).toHaveLength(0);
    expect(issueBridgeToken(db, ws, "envoy").record.label).toBe("envoy");
    expect(issueBridgeToken(db, ws, "my env").record.label).toBe("my env");
  });
});

describe("verifyBridgeTokenDb", () => {
  it("맞으면 토큰 id, 틀림·빈 값·비문자열·폐기됨은 null", () => {
    const { token, record } = issueBridgeToken(db, ws, "a", T0);
    expect(verifyBridgeTokenDb(db, token, at(1))).toEqual({ tokenId: record.id });
    for (const bad of [`${token}x`, token.slice(0, -1), "", undefined, null, 42, { token }, [token]])
      expect(verifyBridgeTokenDb(db, bad, at(2))).toBeNull();
    expect(revokeBridgeToken(db, ws, record.id, at(3))).toBe(true);
    expect(verifyBridgeTokenDb(db, token, at(4))).toBeNull();
  });

  it("lastUsedAt 은 처음 쓸 때 채우고, 그 뒤로는 1분에 한 번만 갱신한다", () => {
    const { token, record } = issueBridgeToken(db, ws, "a", T0);
    const lastUsed = () =>
      db.select().from(bridgeTokens).where(eq(bridgeTokens.id, record.id)).get()?.lastUsedAt;
    verifyBridgeTokenDb(db, token, at(1_000));
    expect(lastUsed()).toEqual(at(1_000));
    verifyBridgeTokenDb(db, token, at(1_000 + BRIDGE_TOKEN_LAST_USED_INTERVAL_MS - 1));
    expect(lastUsed()).toEqual(at(1_000));
    verifyBridgeTokenDb(db, token, at(1_000 + BRIDGE_TOKEN_LAST_USED_INTERVAL_MS));
    expect(lastUsed()).toEqual(at(1_000 + BRIDGE_TOKEN_LAST_USED_INTERVAL_MS));
    // 틀린 토큰은 어느 행도 건드리지 않는다
    verifyBridgeTokenDb(db, "dbt_wrong", at(10 * BRIDGE_TOKEN_LAST_USED_INTERVAL_MS));
    expect(lastUsed()).toEqual(at(1_000 + BRIDGE_TOKEN_LAST_USED_INTERVAL_MS));
  });

  it("검증한 토큰의 행만 lastUsedAt 을 채운다 — 다른 행은 그대로", () => {
    const a = issueBridgeToken(db, ws, "a", T0);
    const b = issueBridgeToken(db, ws, "b", T0);
    importEnvToken(db, seedWorkspace(db, { userHandle: "o" }).workspaceId, ENV_TOKEN, T0);
    verifyBridgeTokenDb(db, a.token, at(1_000));
    const byId = new Map(rows().map((r) => [r.id, r.lastUsedAt]));
    expect(byId.get(a.record.id)).toEqual(at(1_000));
    expect(byId.get(b.record.id)).toBeNull();
    expect([...byId.values()].filter((v) => v !== null)).toHaveLength(1);
  });

  it("isActiveBridgeToken 은 같은 판정을 하지만 lastUsedAt 을 건드리지 않는다", () => {
    const { token } = issueBridgeToken(db, ws, "a", T0);
    expect(isActiveBridgeToken(db, ws, token)).toBe(true);
    expect(isActiveBridgeToken(db, ws, "nope")).toBe(false);
    expect(rows()[0]?.lastUsedAt).toBeNull();
  });
});

describe("listBridgeTokens·revokeBridgeToken", () => {
  it("폐기된 것까지 새것부터, connected 는 주어진 토큰 id 줄만, 원문·hash 는 없다", () => {
    const a = issueBridgeToken(db, ws, "a", at(0));
    const b = issueBridgeToken(db, ws, "b", at(1));
    revokeBridgeToken(db, ws, a.record.id, at(2));
    const list = listBridgeTokens(db, ws, b.record.id);
    expect(list.map((t) => [t.label, t.connected, t.revokedAt])).toEqual([
      ["b", true, null],
      ["a", false, at(2).toISOString()],
    ]);
    for (const t of list) expect(BridgeTokenRecord.strict().parse(t)).toEqual(t);
    const dump = JSON.stringify(list);
    expect(dump).not.toContain(a.token);
    expect(dump).not.toContain(rows()[0]?.hash);
    expect(listBridgeTokens(db, ws, null).every((t) => !t.connected)).toBe(true);
  });

  it("없는 id·다른 워크스페이스 id 는 false, 두 번 폐기해도 처음 revokedAt 을 지킨다", () => {
    const other = seedWorkspace(db, { userHandle: "o" }).workspaceId;
    const { record } = issueBridgeToken(db, other, "o", T0);
    expect(revokeBridgeToken(db, ws, record.id, at(1))).toBe(false);
    expect(rows()[0]?.revokedAt).toBeNull();
    expect(revokeBridgeToken(db, ws, "01999999-0000-7000-8000-000000000000", at(1))).toBe(false);
    expect(revokeBridgeToken(db, other, record.id, at(2))).toBe(true);
    expect(revokeBridgeToken(db, other, record.id, at(3))).toBe(true);
    expect(rows()[0]?.revokedAt).toEqual(at(2));
  });
});

describe("importEnvToken", () => {
  it("빈 테이블 → imported(라벨 env) — 그 값으로 검증되고 DB 에 원문은 없다", () => {
    expect(importEnvToken(db, ws, ENV_TOKEN, T0)).toBe("imported");
    const [row] = rows();
    expect(row?.label).toBe("env");
    expect(JSON.stringify(rows())).not.toContain(ENV_TOKEN);
    // prefix 는 원문이 아니라 해시에서 — .env 토큰은 짧을 수 있어 원문 조각을 DB 에 두지 않는다
    expect(row?.prefix).toBe(row?.hash.slice(0, 6));
    expect(ENV_TOKEN).not.toContain(row?.prefix);
    expect(verifyBridgeTokenDb(db, ENV_TOKEN)).toEqual({ tokenId: row?.id });
  });

  it("같은 값 다시 → skipped(행 그대로 하나)", () => {
    importEnvToken(db, ws, ENV_TOKEN, T0);
    expect(importEnvToken(db, ws, ENV_TOKEN, at(1))).toBe("skipped");
    expect(rows()).toHaveLength(1);
  });

  it("다른 값 → ignored, 이어받지 않는다 — 옛 값은 계속 통하고 새 값은 안 통한다 [Review Focus 1]", () => {
    importEnvToken(db, ws, ENV_TOKEN, T0);
    const edited = "f".repeat(32);
    expect(importEnvToken(db, ws, edited, at(1))).toBe("ignored");
    expect(rows()).toHaveLength(1);
    expect(verifyBridgeTokenDb(db, edited)).toBeNull();
    expect(verifyBridgeTokenDb(db, ENV_TOKEN)).not.toBeNull();
  });

  it("웹에서 발급한 토큰만 있거나 env 토큰을 폐기했으면 → ignored", () => {
    issueBridgeToken(db, ws, "web", T0);
    expect(importEnvToken(db, ws, ENV_TOKEN, at(1))).toBe("ignored");

    const fresh = newTestDb();
    const freshWs = seedWorkspace(fresh).workspaceId;
    importEnvToken(fresh, freshWs, ENV_TOKEN, T0);
    const id = fresh.select().from(bridgeTokens).get()?.id as string;
    revokeBridgeToken(fresh, freshWs, id, at(1));
    expect(importEnvToken(fresh, freshWs, ENV_TOKEN, at(2))).toBe("ignored");
    expect(fresh.select().from(bridgeTokens).all()).toHaveLength(1);
  });

  it("값이 없으면 아무것도 하지 않는다", () => {
    expect(importEnvToken(db, ws, undefined, T0)).toBe("skipped");
    expect(rows()).toHaveLength(0);
  });
});

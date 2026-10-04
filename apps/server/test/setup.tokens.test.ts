import { BridgeTokenRecord } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { bridgeTokens } from "../src/db/schema.sqlite";
import { HttpError } from "../src/http/errors";
import {
  BRIDGE_TOKEN_LAST_USED_INTERVAL_MS,
  issueBridgeToken as issueFor,
  listBridgeTokens as listFor,
  revokeBridgeToken as revokeFor,
  verifyBridgeTokenDb,
} from "../src/modules/setup/tokens";
import { newTestDb } from "./helpers/db";
import { insertGateway } from "./helpers/gateways";
import { seedWorkspace } from "./helpers/seed";

const GW = "0f0f0f0f-0000-4000-8000-0000000000a1";
const GW2 = "0f0f0f0f-0000-4000-8000-0000000000a2";
const T0 = new Date("2026-09-24T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let db: Db;
let ws: string;

beforeEach(() => {
  db = newTestDb();
  ws = seedWorkspace(db).workspaceId;
  insertGateway(db, ws, { id: GW, name: "사무실" });
  insertGateway(db, ws, { id: GW2, name: "집" });
});

// 대부분은 Gateway 하나(GW)로 본다 — Gateway 를 가르는 것은 아래 「Gateway 단위」
const issueBridgeToken = (d: Db, w: string, label: string, now?: Date) => issueFor(d, w, GW, label, now);
const listBridgeTokens = (d: Db, w: string, connected: string | null) =>
  listFor(d, w, GW, new Set(connected === null ? [] : [connected]));
const revokeBridgeToken = (d: Db, w: string, id: string, now?: Date) => revokeFor(d, w, GW, id, now);

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
});

describe("verifyBridgeTokenDb", () => {
  it("맞으면 토큰 id, 틀림·빈 값·비문자열·폐기됨은 null", () => {
    const { token, record } = issueBridgeToken(db, ws, "a", T0);
    expect(verifyBridgeTokenDb(db, token, at(1))).toEqual({ tokenId: record.id, gatewayId: GW });
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
    issueFor(db, ws, GW2, "c", T0);
    verifyBridgeTokenDb(db, a.token, at(1_000));
    const byId = new Map(rows().map((r) => [r.id, r.lastUsedAt]));
    expect(byId.get(a.record.id)).toEqual(at(1_000));
    expect(byId.get(b.record.id)).toBeNull();
    expect([...byId.values()].filter((v) => v !== null)).toHaveLength(1);
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
    insertGateway(db, other, { id: "0f0f0f0f-0000-4000-8000-0000000000a3", name: "남의 것" });
    const { record } = issueFor(db, other, "0f0f0f0f-0000-4000-8000-0000000000a3", "o", T0);
    expect(revokeBridgeToken(db, ws, record.id, at(1))).toBe(false);
    expect(rows()[0]?.revokedAt).toBeNull();
    expect(revokeBridgeToken(db, ws, "01999999-0000-7000-8000-000000000000", at(1))).toBe(false);
    const revokeOther = (now: Date) =>
      revokeFor(db, other, "0f0f0f0f-0000-4000-8000-0000000000a3", record.id, now);
    expect(revokeOther(at(2))).toBe(true);
    expect(revokeOther(at(3))).toBe(true);
    expect(rows()[0]?.revokedAt).toEqual(at(2));
  });
});

describe("Gateway 단위(멀티 Gateway 스펙 「바뀌는 표」 절)", () => {
  it("토큰은 발급한 Gateway 에 묶이고 검증이 그 Gateway 를 돌려준다", () => {
    const a = issueFor(db, ws, GW, "a", T0);
    const b = issueFor(db, ws, GW2, "b", T0);
    expect(verifyBridgeTokenDb(db, a.token)).toEqual({ tokenId: a.record.id, gatewayId: GW });
    expect(verifyBridgeTokenDb(db, b.token)).toEqual({ tokenId: b.record.id, gatewayId: GW2 });
  });

  it("목록은 그 Gateway 의 토큰만, 다른 Gateway 의 토큰 id 로 폐기하면 false 이고 그 토큰은 그대로 통한다", () => {
    const a = issueFor(db, ws, GW, "a", T0);
    const b = issueFor(db, ws, GW2, "b", T0);
    expect(listFor(db, ws, GW, new Set()).map((t) => t.id)).toEqual([a.record.id]);
    expect(listFor(db, ws, GW2, new Set([a.record.id, b.record.id])).map((t) => [t.id, t.connected])).toEqual(
      [[b.record.id, true]],
    );
    expect(revokeFor(db, ws, GW, b.record.id, at(1))).toBe(false);
    expect(verifyBridgeTokenDb(db, b.token)).not.toBeNull();
  });

  it("Gateway 를 지우면 그 Gateway 의 토큰 행도 지워진다(FK cascade)", () => {
    issueFor(db, ws, GW, "a", T0);
    const b = issueFor(db, ws, GW2, "b", T0);
    db.$client.prepare("DELETE FROM gateways WHERE id = ?").run(GW);
    expect(rows().map((r) => r.id)).toEqual([b.record.id]);
  });
});

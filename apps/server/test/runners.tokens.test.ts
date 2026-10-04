import { RunnerTokenRecord } from "@dodok/shared";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { bridgeTokens, runnerTokens } from "../src/db/schema.sqlite";
import { HttpError } from "../src/http/errors";
import {
  activeRunnerTokenCount,
  issueRunnerToken,
  listRunnerTokens,
  RUNNER_TOKEN_LAST_USED_INTERVAL_MS,
  revokeRunnerToken,
  verifyRunnerTokenDb,
} from "../src/modules/runners/tokens";
import { issueBridgeToken, verifyBridgeTokenDb } from "../src/modules/setup/tokens";
import { newTestDb } from "./helpers/db";
import { FAKE_GATEWAY_ID, insertGateway } from "./helpers/gateways";
import { seedWorkspace } from "./helpers/seed";

const T0 = new Date("2026-09-27T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let db: Db;
let ws: string;

beforeEach(() => {
  db = newTestDb();
  ws = seedWorkspace(db).workspaceId;
});

const rows = () => db.select().from(runnerTokens).all();

describe("issueRunnerToken", () => {
  it("원문은 drn_ + base64url 43자, 기록은 계약 모양이고 prefix 는 drn_ 뒤 6자", () => {
    const { token, record } = issueRunnerToken(db, ws, "  macbook  ", T0);
    expect(token).toMatch(/^drn_[A-Za-z0-9_-]{43}$/);
    expect(RunnerTokenRecord.parse(record)).toEqual(record);
    expect(record).toMatchObject({
      label: "macbook",
      prefix: token.slice(4, 10),
      createdAt: T0.toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      connected: false,
    });
  });

  it("DB 에는 원문이 없다 — 행 전체 JSON 에 원문의 어떤 12자 조각도 없고 hash 는 sha256(원문)", () => {
    const { token } = issueRunnerToken(db, ws, "a", T0);
    const dump = JSON.stringify(db.$client.prepare("SELECT * FROM runner_tokens").all());
    for (let i = 0; i + 12 <= token.length; i += 1) expect(dump).not.toContain(token.slice(i, i + 12));
    expect(rows()[0]?.hash).toBe(createHash("sha256").update(token).digest("hex"));
  });

  it("브리지 토큰 표에는 쓰지 않는다", () => {
    issueRunnerToken(db, ws, "a", T0);
    expect(db.select().from(bridgeTokens).all()).toEqual([]);
  });

  it("라벨이 비었거나 61자면 VALIDATION", () => {
    for (const label of ["", "   ", "x".repeat(61)]) {
      const run = () => issueRunnerToken(db, ws, label, T0);
      expect(run).toThrow(HttpError);
      try {
        run();
      } catch (err) {
        expect((err as HttpError).body.code).toBe("VALIDATION");
      }
    }
    expect(rows()).toEqual([]);
  });
});

describe("verifyRunnerTokenDb", () => {
  it("활성 토큰이면 id·라벨, 틀린 값·빈 값·문자열 아님은 null", () => {
    const { token, record } = issueRunnerToken(db, ws, "laptop", T0);
    expect(verifyRunnerTokenDb(db, token, T0)).toEqual({ tokenId: record.id, label: "laptop" });
    for (const presented of [`${token}x`, "", undefined, null, 42, { token }]) {
      expect(verifyRunnerTokenDb(db, presented, T0)).toBeNull();
    }
  });

  it("브리지 토큰으로는 러너가 못 붙고, 러너 토큰으로는 브리지가 못 붙는다", () => {
    insertGateway(db, ws);
    const bridge = issueBridgeToken(db, ws, FAKE_GATEWAY_ID, "gw", T0).token;
    const runner = issueRunnerToken(db, ws, "laptop", T0).token;
    expect(verifyRunnerTokenDb(db, bridge, T0)).toBeNull();
    expect(verifyBridgeTokenDb(db, runner, T0)).toBeNull();
  });

  it("폐기한 토큰은 null", () => {
    const { token, record } = issueRunnerToken(db, ws, "laptop", T0);
    expect(revokeRunnerToken(db, ws, record.id, at(1))).toBe(true);
    expect(verifyRunnerTokenDb(db, token, at(2))).toBeNull();
  });

  it("통과하면 lastUsedAt 을 채우고, 간격 안의 재검증은 쓰지 않는다", () => {
    const { token } = issueRunnerToken(db, ws, "laptop", T0);
    verifyRunnerTokenDb(db, token, at(10));
    expect(rows()[0]?.lastUsedAt).toEqual(at(10));
    verifyRunnerTokenDb(db, token, at(10 + RUNNER_TOKEN_LAST_USED_INTERVAL_MS - 1));
    expect(rows()[0]?.lastUsedAt).toEqual(at(10));
    verifyRunnerTokenDb(db, token, at(10 + RUNNER_TOKEN_LAST_USED_INTERVAL_MS));
    expect(rows()[0]?.lastUsedAt).toEqual(at(10 + RUNNER_TOKEN_LAST_USED_INTERVAL_MS));
  });
});

describe("listRunnerTokens·revokeRunnerToken·activeRunnerTokenCount", () => {
  it("폐기한 것까지 새것부터, connected 는 주어진 id 집합으로", () => {
    const a = issueRunnerToken(db, ws, "a", at(1)).record;
    const b = issueRunnerToken(db, ws, "b", at(2)).record;
    const c = issueRunnerToken(db, ws, "c", at(3)).record;
    revokeRunnerToken(db, ws, b.id, at(4));
    const list = listRunnerTokens(db, ws, new Set([a.id, c.id]));
    expect(list.map((r) => [r.label, r.connected, r.revokedAt])).toEqual([
      ["c", true, null],
      ["b", false, at(4).toISOString()],
      ["a", true, null],
    ]);
    expect(activeRunnerTokenCount(db, ws)).toBe(2);
  });

  it("다른 워크스페이스의 토큰은 목록·폐기·개수에서 빠진다", () => {
    const other = seedWorkspace(db, { userHandle: "other" }).workspaceId;
    const theirs = issueRunnerToken(db, other, "theirs", T0).record;
    issueRunnerToken(db, ws, "mine", T0);
    expect(listRunnerTokens(db, ws, new Set()).map((r) => r.label)).toEqual(["mine"]);
    expect(revokeRunnerToken(db, ws, theirs.id, T0)).toBe(false);
    expect(activeRunnerTokenCount(db, ws)).toBe(1);
    expect(activeRunnerTokenCount(db, other)).toBe(1);
  });

  it("이미 폐기된 행은 처음 revokedAt 을 지키고 true, 없는 id 는 false", () => {
    const { record } = issueRunnerToken(db, ws, "a", T0);
    expect(revokeRunnerToken(db, ws, record.id, at(1))).toBe(true);
    expect(revokeRunnerToken(db, ws, record.id, at(2))).toBe(true);
    expect(rows()[0]?.revokedAt).toEqual(at(1));
    expect(revokeRunnerToken(db, ws, "01a09fc9-d204-7551-89d6-38544d07a101", at(3))).toBe(false);
  });
});

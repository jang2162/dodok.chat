import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { agents } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { bindRunnerToken, boundRunnerToken, claimRunnerToken } from "../src/modules/runners/bindings";
import { issueRunnerToken, revokeRunnerToken } from "../src/modules/runners/tokens";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

let db: Db;
let ws: string;

beforeEach(() => {
  db = newTestDb();
  ws = seedWorkspace(db).workspaceId;
});

const claude = (providerAgentId: string, runnerTokenId?: string) =>
  createAgent(db, {
    workspaceId: ws,
    provider: "runner",
    providerAgentId,
    handle: providerAgentId,
    name: providerAgentId,
    ...(runnerTokenId === undefined ? {} : { runnerTokenId }),
  });

describe("에이전트↔러너 토큰 묶임 저장소", () => {
  it("claim 은 묶임 없는 등록 러너 에이전트만 묶는다 — 이미 묶인 행을 덮지 않고, 미등록·openclaw id 는 false", () => {
    const a = issueRunnerToken(db, ws, "a").record.id;
    const b = issueRunnerToken(db, ws, "b").record.id;
    claude("coder");
    claude("writer", a);
    createAgent(db, { workspaceId: ws, providerAgentId: "dev", handle: "dev", name: "Dev" });

    expect(claimRunnerToken(db, ws, "coder", a)).toBe(true);
    expect(claimRunnerToken(db, ws, "coder", b)).toBe(false);
    expect(boundRunnerToken(db, ws, "coder")).toBe(a);
    expect(claimRunnerToken(db, ws, "writer", b)).toBe(false);
    expect(boundRunnerToken(db, ws, "writer")).toBe(a);
    expect(claimRunnerToken(db, ws, "nobody", a)).toBe(false);
    expect(claimRunnerToken(db, ws, "dev", a)).toBe(false);
    expect(boundRunnerToken(db, ws, "dev")).toBeNull();
  });

  it("createAgent 는 claude 일 때만 runnerTokenId 를 싣고, 응답 Agent.runner 에 라벨을 붙인다", () => {
    const a = issueRunnerToken(db, ws, "laptop").record.id;
    expect(claude("coder", a).runner).toEqual({ tokenId: a, label: "laptop", revoked: false });
    const dev = createAgent(db, {
      workspaceId: ws,
      provider: "openclaw",
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
      runnerTokenId: a,
    });
    expect(dev.runner).toBeUndefined();
    expect(
      db
        .select({ t: agents.runnerTokenId })
        .from(agents)
        .all()
        .map((r) => r.t)
        .sort(),
    ).toEqual([a, null].sort());
  });

  it("bind 는 폐기되지 않은 토큰으로 옮긴다 — 폐기된 토큰은 CONFLICT, 다른 워크스페이스 토큰은 NOT_FOUND", () => {
    const a = issueRunnerToken(db, ws, "a").record.id;
    const b = issueRunnerToken(db, ws, "b").record.id;
    claude("coder", a);
    expect(bindRunnerToken(db, ws, b, "coder").runner).toEqual({ tokenId: b, label: "b", revoked: false });
    revokeRunnerToken(db, ws, a);
    expect(() => bindRunnerToken(db, ws, a, "coder")).toThrow(expect.objectContaining({ status: 409 }));
    const other = seedWorkspace(db, { userHandle: "other" }).workspaceId;
    const foreign = issueRunnerToken(db, other, "x").record.id;
    expect(() => bindRunnerToken(db, ws, foreign, "coder")).toThrow(expect.objectContaining({ status: 404 }));
    expect(boundRunnerToken(db, ws, "coder")).toBe(b);
  });
});

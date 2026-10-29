import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { agents } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { bindRunnerToken } from "../src/modules/runners/bindings";
import { issueRunnerToken, revokeRunnerToken } from "../src/modules/runners/tokens";
import { newTestDb } from "./helpers/db";
import { createRunnerAgentForTest, seedWorkspace } from "./helpers/seed";

let db: Db;
let ws: string;

beforeEach(() => {
  db = newTestDb();
  ws = seedWorkspace(db).workspaceId;
});

describe("에이전트↔러너 토큰 묶임 저장소", () => {
  it("러너 에이전트는 만들 때 그 프로젝트의 러너 토큰에 묶이고, 응답 Agent.runner 에 라벨을 붙인다 — OpenClaw 는 묶임이 없다", () => {
    const a = issueRunnerToken(db, ws, "laptop").record.id;
    const coder = createRunnerAgentForTest(db, { workspaceId: ws, handle: "coder", runnerTokenId: a }).agent;
    expect(coder.runner).toEqual({ tokenId: a, label: "laptop", revoked: false });
    const dev = createAgent(db, { workspaceId: ws, providerAgentId: "dev", handle: "dev", name: "Dev" });
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
    const { providerAgentId } = createRunnerAgentForTest(db, {
      workspaceId: ws,
      handle: "coder",
      runnerTokenId: a,
    }).agent;
    expect(bindRunnerToken(db, ws, b, providerAgentId).runner).toEqual({
      tokenId: b,
      label: "b",
      revoked: false,
    });
    revokeRunnerToken(db, ws, a);
    expect(() => bindRunnerToken(db, ws, a, providerAgentId)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    const other = seedWorkspace(db, { userHandle: "other" }).workspaceId;
    const foreign = issueRunnerToken(db, other, "x").record.id;
    expect(() => bindRunnerToken(db, ws, foreign, providerAgentId)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});

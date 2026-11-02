import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { agents } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { runnerAgentDefinition } from "../src/modules/runners/definition";
import { issueRunnerToken } from "../src/modules/runners/tokens";
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
    const a = issueRunnerToken(db, ws, "laptop", null).record.id;
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

  it("에이전트의 러너 토큰만 다른 러너를 가리키면 정의가 없다 — 프로젝트도 그 러너의 것이어야 한다 [태스크 3 리뷰 D1]", () => {
    const a = issueRunnerToken(db, ws, "a", null).record.id;
    const b = issueRunnerToken(db, ws, "b", null).record.id;
    const { agent } = createRunnerAgentForTest(db, {
      workspaceId: ws,
      handle: "coder",
      runnerTokenId: a,
      relPath: "proj-a",
    });
    expect(runnerAgentDefinition(db, ws, agent.providerAgentId, a)?.agent.project).toEqual({
      rootId: "src",
      relPath: "proj-a",
    });
    // 옛 「이 러너로 묶기」가 하던 것 — 에이전트 토큰만 바꾼다. b 로 가면 b 머신의 같은 이름 루트에서 돌았다
    db.update(agents).set({ runnerTokenId: b }).where(eq(agents.id, agent.id)).run();
    expect(runnerAgentDefinition(db, ws, agent.providerAgentId, b)).toBeNull();
    expect(runnerAgentDefinition(db, ws, agent.providerAgentId, a)).toBeNull();
  });
});

/**
 * 「에이전트를 맡은 연결」 규칙은 두 벌이다 — 런을 보낼 때의 TS `connectionIdOf` 와 이벤트에서 에이전트를 찾는 SQL `agentOnConnection`
 * (adapters/connection.ts). 둘이 같은 말을 하는지 에이전트 꼴마다 견준다. 다른 것은 묶임 없는 러너 에이전트 하나뿐이다.
 */
import { and, eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { agentOnConnection, connectionIdOf } from "../src/adapters/connection";
import type { AdapterProvider } from "../src/adapters/types";
import { agents, runnerTokens } from "../src/db/schema.sqlite";
import { newTestDb } from "./helpers/db";
import { insertGateway } from "./helpers/gateways";
import { seedWorkspace } from "./helpers/seed";

const G1 = "0f0f0f0f-0000-4000-8000-0000000000b1";
const G2 = "0f0f0f0f-0000-4000-8000-0000000000b2";

function seed() {
  const db = newTestDb();
  const { workspaceId } = seedWorkspace(db);
  insertGateway(db, workspaceId, { id: G1, name: "사무실" });
  insertGateway(db, workspaceId, { id: G2, name: "집" });
  const runner = uuid();
  db.insert(runnerTokens)
    .values({
      id: runner,
      workspaceId,
      label: "laptop",
      hash: "r".repeat(64),
      prefix: "rrrrrr",
      createdAt: new Date(),
    })
    .run();
  const agent = (
    handle: string,
    provider: AdapterProvider,
    providerAgentId: string,
    link: { gatewayId?: string; runnerTokenId?: string },
  ) =>
    db
      .insert(agents)
      .values({
        id: uuid(),
        workspaceId,
        provider,
        providerAgentId,
        handle,
        name: handle,
        createdAt: new Date(),
        gatewayId: link.gatewayId ?? null,
        runnerTokenId: link.runnerTokenId ?? null,
      })
      .returning()
      .get();
  // 두 Gateway 의 main, Gateway 가 지워진 main, 러너에 묶인·묶이지 않은 러너 에이전트
  const rows = [
    agent("main-office", "openclaw", "main", { gatewayId: G1 }),
    agent("main-home", "openclaw", "main", { gatewayId: G2 }),
    agent("main-orphan", "openclaw", "main", {}),
    agent("coder", "claude", "coder", { runnerTokenId: runner }),
    agent("loose", "claude", "loose", {}),
  ];
  return { db, rows, runner };
}

describe("연결 규칙 — connectionIdOf(TS) 와 agentOnConnection(SQL)", () => {
  it("에이전트 꼴마다 같은 연결을 말한다 — 묶임 없는 러너 에이전트만 SQL 이 어느 러너의 것으로도 받는다", () => {
    const { db, rows, runner } = seed();
    for (const provider of ["openclaw", "claude"] as const) {
      for (const connection of [G1, G2, runner, "unknown", ""]) {
        const bySql = db
          .select({ handle: agents.handle })
          .from(agents)
          .where(and(eq(agents.provider, provider), agentOnConnection(provider, connection)))
          .all()
          .map((r) => r.handle)
          .sort();
        const byTs = rows
          .filter((r) => r.provider === provider)
          .filter(
            (r) => connectionIdOf(r) === connection || (provider === "claude" && r.runnerTokenId === null),
          )
          .map((r) => r.handle)
          .sort();
        expect(bySql, `${provider} @ ${connection}`).toEqual(byTs);
      }
    }
  });

  it("Gateway 가 빈 OpenClaw 에이전트는 연결이 없다 — 어느 연결의 이벤트로도 찾지 않는다", () => {
    const { db, rows } = seed();
    const orphan = rows.find((r) => r.handle === "main-orphan");
    expect(orphan && connectionIdOf(orphan)).toBeNull();
    for (const connection of [G1, G2, "env", ""]) {
      const found = db
        .select({ handle: agents.handle })
        .from(agents)
        .where(and(eq(agents.provider, "openclaw"), agentOnConnection("openclaw", connection)))
        .all()
        .map((r) => r.handle);
      expect(found, connection).not.toContain("main-orphan");
    }
  });

  it("OpenClaw 는 gateway_id, 러너는 runner_token_id — 다른 쪽 열은 보지 않는다", () => {
    const { rows, runner } = seed();
    const byHandle = Object.fromEntries(rows.map((r) => [r.handle, connectionIdOf(r)]));
    expect(byHandle).toEqual({
      "main-office": G1,
      "main-home": G2,
      "main-orphan": null,
      coder: runner,
      loose: null,
    });
    expect(connectionIdOf({ provider: "openclaw", gatewayId: null, runnerTokenId: runner })).toBeNull();
    expect(connectionIdOf({ provider: "claude", gatewayId: G1, runnerTokenId: null })).toBeNull();
  });
});

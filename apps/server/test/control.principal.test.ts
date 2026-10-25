/**
 * 제어 도구 호출의 주체(제어 MCP 스펙 「주체」 장) — 채널 안 에이전트는 그 연결의 **열린 런**의 시킨 사람으로만 부른다. 끝난 런·다른
 * 연결·다른 세션 키면 주체가 없다(부르는 쪽이 NOT_FOUND). 통로 배선은 태스크 4
 */
import { v7 as uuid } from "uuid";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { runnerTokens } from "../src/db/schema.sqlite";
import { principalForBridge, principalForRunner } from "../src/modules/control/principal";
import { insertRun, updateRun } from "../src/modules/runs/store";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent } from "./helpers/seed";

describe("principalForRunner·principalForBridge", () => {
  let db: Db;
  let seed: ReturnType<typeof seedChannelWithAgent>;
  const GATEWAY = "gw-1";
  const sessionKey = () => `agent:dev:dodok:channel:${seed.conversationId}`;

  beforeEach(() => {
    db = newTestDb();
    seed = seedChannelWithAgent(db);
  });

  const run = (
    connectionId: string,
    status: "tool" | "done" = "tool",
    requestedBy: string | null = seed.userId,
  ) => {
    const queued = insertRun(db, {
      channelId: seed.channelId,
      conversationId: seed.conversationId,
      agentId: seed.agentId,
      triggerKind: "mention",
      rootMessageId: uuid(),
      relayDepth: 0,
      sessionKey: sessionKey(),
      connectionId,
      requestedBy,
      createdAt: new Date(),
    });
    return updateRun(db, queued.id, { status, ...(status === "done" ? { endedAt: new Date() } : {}) });
  };

  it("러너: 그 러너 토큰의 열린 런이면 그 런을 시킨 사람", () => {
    db.insert(runnerTokens)
      .values({
        id: "rt-1",
        workspaceId: seed.workspaceId,
        label: "r",
        hash: "h",
        prefix: "p",
        createdAt: new Date(),
      })
      .run();
    const open = run("rt-1");
    expect(principalForRunner(db, "rt-1", open.id)).toEqual({
      userId: seed.userId,
      via: "agent",
      agentId: seed.agentId,
      runId: open.id,
    });
    expect(principalForRunner(db, "rt-2", open.id)).toBeUndefined();
    expect(principalForRunner(db, "rt-1", uuid())).toBeUndefined();
    expect(principalForRunner(db, "rt-1", run("rt-1", "done").id)).toBeUndefined();
  });

  it("시킨 사람이 없는 런은 userId null(읽기만)", () => {
    const open = run(GATEWAY, "tool", null);
    expect(principalForBridge(db, GATEWAY, sessionKey(), open.id)?.userId).toBeNull();
  });

  it("플러그인: 열린 런 + 세션 키 + Gateway 가 모두 맞을 때만(Review Focus 4)", () => {
    const open = run(GATEWAY);
    // 브리지 표지 — 확인 카드 기한이 5분이 된다(러너는 표지 없음, 위 toEqual)
    expect(principalForBridge(db, GATEWAY, sessionKey(), open.id)?.bridge).toBe(true);
    expect(principalForBridge(db, GATEWAY, sessionKey(), open.id)).toMatchObject({
      runId: open.id,
      via: "agent",
    });
    expect(principalForBridge(db, "gw-other", sessionKey(), open.id)).toBeUndefined();
    expect(principalForBridge(db, GATEWAY, `${sessionKey()}:thread:${uuid()}`, open.id)).toBeUndefined();
    // 끝난 런의 늦은 호출 — 같은 세션에 다음 런이 열려 있어도 옛 runId 면 받지 않는다
    const ended = run(GATEWAY, "done");
    expect(principalForBridge(db, GATEWAY, sessionKey(), ended.id)).toBeUndefined();
  });
});

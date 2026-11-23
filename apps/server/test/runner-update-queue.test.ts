/**
 * 「업데이트 대기」(러너 봇 2부 스펙 T16, Review Focus 4) — 그 러너의 열린 런이 남아 있으면 나가지 않고, 마지막 런이 끝나면 한 번,
 * 서버 재시작(같은 DB)·러너 끊김 뒤에도 남고, 취소하면 나가지 않는다. 실제 서버의 길은 control.service.test.ts 의 러너 제어 도구 절
 */
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { runnerTokens } from "../src/db/schema.sqlite";
import { createRunnerUpdateQueue } from "../src/modules/connections/remote-updates";
import { insertRun, updateRun } from "../src/modules/runs/store";
import { newTestDb } from "./helpers/db";
import { insertRunnerToken, seedChannelWithAgent } from "./helpers/seed";

function setup() {
  const db = newTestDb();
  const seed = seedChannelWithAgent(db, { gatewayId: null });
  const tokenId = insertRunnerToken(db, seed.workspaceId);
  const otherToken = insertRunnerToken(db, seed.workspaceId, "other");
  const started: Array<{ tokenId: string; userId: string | null }> = [];
  const deferred: Array<() => void> = [];
  let connected = true;
  let changed = 0;
  const make = () =>
    createRunnerUpdateQueue({
      db,
      workspaceId: seed.workspaceId,
      logger: { info: () => {}, warn: () => {} },
      connected: () => connected,
      start: async (id, userId) => {
        started.push({ tokenId: id, userId });
      },
      onChanged: () => void (changed += 1),
      defer: (fn) => void deferred.push(fn),
    });
  const queue = make();
  /** 미룬 판정을 모두 돌리고 끝나기를 기다린다 */
  const flush = async () => {
    while (deferred.length > 0) deferred.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const openRun = (connectionId = tokenId) => {
    const run = insertRun(db, {
      channelId: seed.channelId,
      conversationId: seed.conversationId,
      agentId: seed.agentId,
      triggerKind: "mention",
      rootMessageId: uuid(),
      relayDepth: 0,
      sessionKey: `agent:dev:dodok:channel:${seed.conversationId}`,
      connectionId,
      requestedBy: seed.userId,
      createdAt: new Date(),
    });
    return updateRun(db, run.id, { status: "streaming", startedAt: new Date() });
  };
  /** 오케스트레이터 순서 그대로 — onRunEnded 를 먼저 부르고 같은 틱에 종료를 쓴다 */
  const endRun = (q: typeof queue, runId: string) => {
    q.onRunEnded(runId);
    updateRun(db, runId, { status: "done", endedAt: new Date() });
  };
  return {
    db,
    seed,
    tokenId,
    otherToken,
    queue,
    make,
    started,
    flush,
    openRun,
    endRun,
    setConnected: (v: boolean) => void (connected = v),
    changes: () => changed,
  };
}

describe("업데이트 대기(T16)", () => {
  it("런이 남아 있으면 나가지 않고, 마지막 런이 끝나면 한 번 — 다른 러너의 런은 세지 않는다", async () => {
    const h = setup();
    const a = h.openRun();
    const b = h.openRun();
    const elsewhere = h.openRun(h.otherToken);
    h.queue.enqueue(h.tokenId, h.seed.userId);
    await h.flush();
    expect(h.started).toEqual([]);
    expect(h.queue.view(h.tokenId)).toEqual({ requestedAt: expect.any(String) });

    h.endRun(h.queue, a.id);
    await h.flush();
    expect(h.started).toEqual([]);

    h.endRun(h.queue, b.id);
    await h.flush();
    expect(h.started).toEqual([{ tokenId: h.tokenId, userId: h.seed.userId }]);
    expect(h.queue.view(h.tokenId)).toBeNull();
    // 이미 비웠다 — 남은 판정·다른 러너의 런 끝이 다시 보내지 않는다
    h.endRun(h.queue, elsewhere.id);
    h.queue.onRunnersChanged();
    await h.flush();
    expect(h.started).toHaveLength(1);
    expect(h.changes()).toBeGreaterThan(0);
  });

  it("열린 런이 없으면 둔 곧바로 나간다", async () => {
    const h = setup();
    h.queue.enqueue(h.tokenId, null);
    await h.flush();
    expect(h.started).toEqual([{ tokenId: h.tokenId, userId: null }]);
  });

  it("서버 재시작(같은 DB) 뒤에도 남는다 — 새 대기열이 러너가 붙을 때 판정해 보낸다", async () => {
    const h = setup();
    const run = h.openRun();
    h.queue.enqueue(h.tokenId, h.seed.userId);
    await h.flush();
    // 재시작 — 메모리는 없고 DB 행만 남는다. 끝나지 않은 런은 부팅 정리가 닫는다
    updateRun(h.db, run.id, { status: "error", endedAt: new Date() });
    const rebooted = h.make();
    expect(rebooted.view(h.tokenId)).toEqual({ requestedAt: expect.any(String) });
    expect(h.db.select().from(runnerTokens).where(eq(runnerTokens.id, h.tokenId)).get()?.updateQueuedBy).toBe(
      h.seed.userId,
    );
    rebooted.onRunnersChanged();
    await h.flush();
    expect(h.started).toEqual([{ tokenId: h.tokenId, userId: h.seed.userId }]);
  });

  it("러너가 끊긴 사이 런이 끝났으면 나가지 않고, 다시 붙을 때 나간다", async () => {
    const h = setup();
    const run = h.openRun();
    h.queue.enqueue(h.tokenId, h.seed.userId);
    h.setConnected(false);
    h.endRun(h.queue, run.id);
    await h.flush();
    expect(h.started).toEqual([]);
    expect(h.queue.view(h.tokenId)).not.toBeNull();
    h.setConnected(true);
    h.queue.onRunnersChanged();
    await h.flush();
    expect(h.started).toHaveLength(1);
  });

  it("취소하면 나가지 않는다 — 없는 대기의 취소는 false", async () => {
    const h = setup();
    const run = h.openRun();
    h.queue.enqueue(h.tokenId, h.seed.userId);
    expect(h.queue.cancel(h.tokenId)).toBe(true);
    expect(h.queue.cancel(h.tokenId)).toBe(false);
    h.endRun(h.queue, run.id);
    h.queue.onRunnersChanged();
    await h.flush();
    expect(h.started).toEqual([]);
    expect(h.queue.view(h.tokenId)).toBeNull();
  });

  it("닫은 뒤(앱 종료)에는 미룬 판정을 돌리지 않는다 — DB 를 닫은 뒤 쿼리가 나가지 않게", async () => {
    const h = setup();
    const warned: string[] = [];
    const deferred: Array<() => void> = [];
    const queue = createRunnerUpdateQueue({
      db: h.db,
      workspaceId: h.seed.workspaceId,
      logger: { info: () => {}, warn: (_o: unknown, msg?: string) => void warned.push(msg ?? "") },
      connected: () => true,
      start: async () => {},
      onChanged: () => {},
      defer: (fn) => void deferred.push(fn),
    });
    queue.enqueue(h.tokenId, h.seed.userId);
    queue.onRunnersChanged();
    queue.close();
    h.db.$client.close();
    while (deferred.length > 0) deferred.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 닫힌 DB 에 쿼리가 나갔다면 check 가 던져 경고가 남는다
    expect(warned).toEqual([]);
  });

  it("두 번 둬도 시각은 처음 것, 보내기가 실패해도 다시 대기하지 않는다", async () => {
    const h = setup();
    h.openRun();
    h.queue.enqueue(h.tokenId, h.seed.userId);
    const first = h.queue.view(h.tokenId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.queue.enqueue(h.tokenId, h.seed.userId);
    expect(h.queue.view(h.tokenId)).toEqual(first);

    const failing = createRunnerUpdateQueue({
      db: h.db,
      workspaceId: h.seed.workspaceId,
      logger: { info: () => {}, warn: () => {} },
      connected: () => true,
      start: async () => {
        throw new Error("busy");
      },
      onChanged: () => {},
      defer: (fn) => fn(),
    });
    const other = h.otherToken;
    failing.enqueue(other, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failing.view(other)).toBeNull();
  });
});

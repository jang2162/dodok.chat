import type { Message, RelayPolicy } from "@dodok/shared";
import { eq } from "drizzle-orm";
import pino from "pino";
import { v7 as uuid } from "uuid";
import { beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { Db } from "../src/db/client";
import { opsEvents, runs } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { createChannel } from "../src/modules/channels/service";
import { createRunGate, type RunGate } from "../src/modules/ops/budget";
import { createOpsService } from "../src/modules/ops/service";
import { patchOpsSettings } from "../src/modules/ops/settings";
import type { Orchestrator } from "../src/modules/runs/orchestrator";
import { countRunsTodayInWorkspace, insertRun } from "../src/modules/runs/store";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

// 「하루」는 서버 현지 자정이다 — 현지 시각 생성자로 TZ 와 무관하게 경계를 만든다
const ROOT = uuid();
const DAY = (h: number, m = 0, s = 0) => new Date(2026, 8, 25, h, m, s);
const NEXT_DAY = (h: number, m = 0, s = 0) => new Date(2026, 8, 26, h, m, s);

let db: Db;
let workspaceId: string;
let userId: string;
let agentId: string;
let clock: Date;
let created: Message[];
let gate: RunGate;

beforeEach(() => {
  db = newTestDb();
  ({ workspaceId, userId } = seedWorkspace(db));
  agentId = createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev", name: "Dev" }).id;
  clock = DAY(12);
  const bus = new ServerBus();
  created = [];
  bus.on("message.created", (p) => void created.push(p.message));
  const logger = pino({ level: "silent" });
  const ops = createOpsService({ db, bus, logger, workspaceId, now: () => clock });
  // 오케스트레이터 대역 — 관문의 now 로 런 행만 남긴다
  const enqueue: Orchestrator["enqueueRun"] = async (plan) =>
    insertRun(db, { ...plan, sessionKey: `k:${plan.agentId}`, createdAt: clock });
  gate = createRunGate({ db, bus, ops, workspaceId, enqueue, now: () => clock });
});

function channel(relayPolicy?: z.input<typeof RelayPolicy>) {
  return createChannel(db, { workspaceId, createdBy: userId, name: `c${Math.random()}`, relayPolicy });
}

/** 관문을 거치지 않고 오늘 런 n 개를 깐다 */
function fill(channelId: string, n: number, at = clock) {
  for (let i = 0; i < n; i++) {
    insertRun(db, {
      channelId,
      conversationId: channelId,
      agentId,
      triggerKind: "mention",
      rootMessageId: ROOT,
      relayDepth: 0,
      sessionKey: "k",
      createdAt: at,
    });
  }
}

const plan = (channelId: string) => ({
  agentId,
  channelId,
  conversationId: channelId, // 채널을 만들면 id 가 같은 「이전 대화」가 생긴다
  triggerKind: "mention" as const,
  rootMessageId: ROOT,
  relayDepth: 0,
});
const limitMessages = () => created.filter((m) => m.systemMeta?.kind === "run_limit");
const events = () => db.select().from(opsEvents).where(eq(opsEvents.kind, "run_limit")).all();

describe("countRunsTodayInWorkspace", () => {
  it("현지 자정 이후 모든 채널의 런을 센다", () => {
    const a = channel();
    const b = channel();
    fill(a.id, 2);
    fill(b.id, 3);
    fill(a.id, 4, DAY(0, 0, 0));
    fill(b.id, 5, new Date(DAY(0).getTime() - 1));
    expect(countRunsTodayInWorkspace(db, clock)).toBe(9);
  });
});

describe("RunGate", () => {
  it("키 없는 설정이면 300 — 오늘 299개면 통과, 300개면 막힌다", async () => {
    const c = channel();
    fill(c.id, 299);
    expect(gate.check(c.id)).toBeNull();
    const run = await gate.enqueue(plan(c.id), {});
    expect(run).not.toBeNull();
    expect(gate.check(c.id)).toEqual({ scope: "workspace", limit: 300 });
    expect(await gate.enqueue(plan(c.id), {})).toBeNull();
    expect(db.select().from(runs).all()).toHaveLength(300);
  });

  it("워크스페이스 설정이 null 이면 1000개여도 통과", () => {
    patchOpsSettings(db, workspaceId, { dailyRunLimit: null });
    const c = channel();
    fill(c.id, 1000);
    expect(gate.check(c.id)).toBeNull();
    expect(limitMessages()).toEqual([]);
  });

  it("워크스페이스·채널 둘 다 넘으면 workspace 로 막는다", () => {
    patchOpsSettings(db, workspaceId, { dailyRunLimit: 3 });
    const c = channel({ dailyRunLimit: 2 });
    fill(c.id, 3);
    expect(gate.check(c.id)).toEqual({ scope: "workspace", limit: 3 });
  });

  it("같은 날 두 번 막히면 시스템 메시지는 scope 마다 1개, 사건은 1줄 count 2", () => {
    patchOpsSettings(db, workspaceId, { dailyRunLimit: 3 });
    const c = channel({ dailyRunLimit: 2 });
    fill(c.id, 2);
    expect(gate.check(c.id)).toEqual({ scope: "channel", limit: 2 });
    clock = DAY(13);
    expect(gate.check(c.id)).toEqual({ scope: "channel", limit: 2 });
    fill(c.id, 1);
    expect(gate.check(c.id)).toEqual({ scope: "workspace", limit: 3 });
    expect(gate.check(c.id)).toEqual({ scope: "workspace", limit: 3 });

    expect(limitMessages().map((m) => [m.channelId, m.bodyMd, m.systemMeta?.limit])).toEqual([
      [
        c.id,
        "이 채널의 오늘 런 한도(2)에 도달했습니다 — 내일 0시에 풀립니다",
        { scope: "channel", limit: 2 },
      ],
      [c.id, "오늘 런 한도(3)에 도달했습니다 — 내일 0시에 풀립니다", { scope: "workspace", limit: 3 }],
    ]);
    const rows = events();
    expect(rows.map((r) => [r.key, r.count, r.severity, r.detail])).toEqual(
      expect.arrayContaining([
        [`channel:${c.id}`, 2, "warn", { limit: 2 }],
        ["workspace", 2, "warn", { limit: 3 }],
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("23:59:59 에 막히면 다음 날 00:00:00 에 통과하고, 그날 첫 막힘에 메시지가 다시 생긴다", async () => {
    patchOpsSettings(db, workspaceId, { dailyRunLimit: 1 });
    const c = channel();
    clock = DAY(23, 59, 59);
    fill(c.id, 1);
    expect(gate.check(c.id)).toEqual({ scope: "workspace", limit: 1 });
    expect(limitMessages()).toHaveLength(1);

    clock = NEXT_DAY(0, 0, 0);
    expect(gate.check(c.id)).toBeNull();
    expect(await gate.enqueue(plan(c.id), {})).not.toBeNull();
    expect(gate.check(c.id)).toEqual({ scope: "workspace", limit: 1 });
    expect(limitMessages()).toHaveLength(2);
    expect(limitMessages()[1]?.createdAt).toBe(NEXT_DAY(0, 0, 0).toISOString());
  });

  it("채널 한도는 그 채널만 막는다 — 한도가 없는 채널 B 는 통과", () => {
    const a = channel({ dailyRunLimit: 1 });
    const b = channel();
    fill(a.id, 1);
    fill(b.id, 5);
    expect(gate.check(a.id)).toEqual({ scope: "channel", limit: 1 });
    expect(gate.check(b.id)).toBeNull();
    expect(limitMessages().map((m) => m.channelId)).toEqual([a.id]);
  });

  it("채널마다 오늘 메시지를 따로 남긴다(워크스페이스 한도)", () => {
    patchOpsSettings(db, workspaceId, { dailyRunLimit: 1 });
    const a = channel();
    const b = channel();
    fill(a.id, 1);
    gate.check(a.id);
    gate.check(b.id);
    gate.check(a.id);
    expect(limitMessages().map((m) => m.channelId)).toEqual([a.id, b.id]);
  });

  it("없는 대화 id 면 NOT_FOUND — 한도 안으로 통과시키지 않는다", () => {
    expect(() => gate.check(uuid())).toThrow(
      expect.objectContaining({ body: expect.objectContaining({ code: "NOT_FOUND" }) }),
    );
  });
});

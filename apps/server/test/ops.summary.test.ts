import { OpsRunsSummary, type RunStatus, type RunUsage } from "@dodok/shared";
import { eq } from "drizzle-orm";
import pino from "pino";
import { v7 as uuid } from "uuid";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { agents, runs } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { createChannel } from "../src/modules/channels/service";
import { createOpsService, type OpsService } from "../src/modules/ops/service";
import { runsSummary, USAGE_TRUSTED_PROVIDERS } from "../src/modules/ops/summary";
import { insertRun } from "../src/modules/runs/store";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

// 「하루」는 서버 현지 자정 — 현지 시각 생성자로 TZ 와 무관하게 경계를 만든다
const DAY = (d: number, h = 12, m = 0, s = 0, ms = 0) => new Date(2026, 8, d, h, m, s, ms);
const NOW = DAY(25, 12);
const ROOT = uuid();

let db: Db;
let workspaceId: string;
let userId: string;
let ops: OpsService;
let clock: Date;
let dev: string;
let fin: string;
let general: string;
let random: string;

beforeEach(() => {
  db = newTestDb();
  ({ workspaceId, userId } = seedWorkspace(db));
  clock = NOW;
  ops = createOpsService({
    db,
    bus: new ServerBus(),
    logger: pino({ level: "silent" }),
    workspaceId,
    now: () => clock,
  });
  dev = createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev", name: "Dev" }).id;
  fin = createAgent(db, { workspaceId, providerAgentId: "fin", handle: "fin", name: "Fin" }).id;
  general = createChannel(db, { workspaceId, createdBy: userId, name: "general" }).id;
  random = createChannel(db, { workspaceId, createdBy: userId, name: "random" }).id;
});

function run(
  channelId: string,
  agentId: string,
  createdAt: Date,
  status: RunStatus = "done",
  usage?: RunUsage,
): void {
  const { id } = insertRun(db, {
    channelId,
    conversationId: channelId,
    agentId,
    triggerKind: "mention",
    rootMessageId: ROOT,
    relayDepth: 0,
    sessionKey: `k:${agentId}`,
    createdAt,
  });
  db.update(runs)
    .set({ status, ...(usage ? { usage } : {}) })
    .where(eq(runs.id, id))
    .run();
}

/** clock 을 at 으로 옮겨 run_limit 사건을 남긴다(관문이 남기는 모양) */
function blocked(key: string, at: Date): void {
  clock = at;
  ops.record({ kind: "run_limit", key, severity: "warn", detail: { limit: 1 } });
  clock = NOW;
}

const summary = (days: 1 | 7, usageTrustedProviders?: ReadonlySet<string>) =>
  runsSummary(db, {
    days,
    now: NOW,
    ops,
    workspaceId,
    ...(usageTrustedProviders === undefined ? {} : { usageTrustedProviders }),
  });
const row = (rows: OpsRunsSummary["byChannel"], id: string) => rows.find((r) => r.id === id);

describe("runsSummary 기간", () => {
  beforeEach(() => {
    run(general, dev, DAY(25, 0, 0, 0, 0)); // 오늘 0시 정각 — 오늘
    run(general, dev, DAY(24, 23, 59, 59, 999)); // 어제 끝 — 7일에만
    run(general, dev, DAY(19, 0, 0, 0, 0)); // 6일 전 0시 정각 — 7일에만
    run(general, dev, DAY(18, 23, 59, 59, 999)); // 7일 전 끝 — 어디에도 없다
  });

  it("days=1 은 오늘 0시부터, days=7 은 6일 전 0시부터 [주입한 now]", () => {
    expect(row(summary(1).byChannel, general)?.runs).toBe(1);
    expect(row(summary(7).byChannel, general)?.runs).toBe(3);
    expect(summary(1).days).toBe(1);
    expect(summary(7).days).toBe(7);
  });

  it("run_limit 사건도 같은 기간 — lastAt 이 기간 안인 줄만", () => {
    blocked(`channel:${general}`, DAY(24, 23, 30)); // 어제 — 7일에만
    blocked(`channel:${random}`, DAY(18, 23, 0)); // 7일 전 — 어디에도 없다
    expect(row(summary(1).byChannel, general)?.blocked).toBe(0);
    expect(row(summary(7).byChannel, general)?.blocked).toBe(1);
    expect(row(summary(7).byChannel, random)).toBeUndefined();
  });
});

describe("runsSummary 합계", () => {
  beforeEach(() => {
    run(general, dev, DAY(25, 9), "done");
    run(general, dev, DAY(25, 9), "error");
    run(general, fin, DAY(25, 9), "aborted");
    run(general, fin, DAY(25, 9), "error");
    run(random, dev, DAY(25, 10), "streaming");
  });

  it("채널별·에이전트별 런·실패(error)·중지(aborted) — 이름을 싣는다", () => {
    const s = summary(1);
    expect(OpsRunsSummary.parse(s)).toEqual(s);
    expect(row(s.byChannel, general)).toEqual({
      id: general,
      name: "general",
      runs: 4,
      failed: 2,
      aborted: 1,
      blocked: 0,
    });
    expect(row(s.byChannel, random)).toMatchObject({ name: "random", runs: 1, failed: 0, aborted: 0 });
    expect(row(s.byAgent, dev)).toEqual({ id: dev, name: "Dev", runs: 3, failed: 1, aborted: 0, blocked: 0 });
    expect(row(s.byAgent, fin)).toMatchObject({ name: "Fin", runs: 2, failed: 1, aborted: 1 });
  });

  it("blocked 는 채널 한도 사건만 채널 행에 — 워크스페이스 차단은 어느 행에도 없다, 런 없이 막히기만 한 채널도 행이 있다", () => {
    const quiet = createChannel(db, { workspaceId, createdBy: userId, name: "quiet" }).id;
    blocked(`channel:${general}`, DAY(25, 11));
    blocked(`channel:${general}`, DAY(25, 11, 30)); // 같은 줄로 묶여 count 2
    blocked(`channel:${quiet}`, DAY(25, 11));
    blocked("workspace", DAY(25, 11));
    const s = summary(1);
    expect(row(s.byChannel, general)?.blocked).toBe(2);
    expect(row(s.byChannel, quiet)).toEqual({
      id: quiet,
      name: "quiet",
      runs: 0,
      failed: 0,
      aborted: 0,
      blocked: 1,
    });
    expect(s.byChannel.reduce((n, r) => n + r.blocked, 0)).toBe(3);
    expect(s.byAgent.every((r) => r.blocked === 0)).toBe(true);
  });

  it("다른 워크스페이스의 런은 세지 않는다", () => {
    const other = seedWorkspace(db, { userHandle: "other" });
    const agent = createAgent(db, {
      workspaceId: other.workspaceId,
      providerAgentId: "xx",
      handle: "xx",
      name: "X",
    });
    const ch = createChannel(db, { workspaceId: other.workspaceId, createdBy: other.userId, name: "theirs" });
    run(ch.id, agent.id, DAY(25, 9));
    const s = summary(1);
    expect(row(s.byChannel, ch.id)).toBeUndefined();
    expect(row(s.byAgent, agent.id)).toBeUndefined();
  });

  it("행은 런 수 내림차순", () => {
    expect(summary(1).byChannel.map((r) => r.name)).toEqual(["general", "random"]);
  });
});

describe("runsSummary usage", () => {
  let coder: string;
  beforeEach(() => {
    coder = createAgent(db, { workspaceId, providerAgentId: "coder", handle: "coder", name: "Coder" }).id;
    db.update(agents).set({ provider: "claude" }).where(eq(agents.id, coder)).run();
    run(general, dev, DAY(25, 9), "done", { inputTokens: 100, outputTokens: 20, costUsd: 0.25 });
    run(general, dev, DAY(25, 9), "done", { inputTokens: 5, costUsd: 0.5 });
    run(general, fin, DAY(25, 9), "done"); // usage 없음 — 0 으로 더한다
  });

  it("믿는 제공자는 claude 뿐 — OpenClaw 런만 있으면 tokens·costUsd 키가 없다", () => {
    expect([...USAGE_TRUSTED_PROVIDERS]).toEqual(["claude"]);
    const s = summary(1);
    expect(s.usageTrustedProviders).toEqual(["claude"]);
    for (const r of [...s.byChannel, ...s.byAgent]) {
      expect(r).not.toHaveProperty("tokens");
      expect(r).not.toHaveProperty("costUsd");
    }
  });

  it("믿는 제공자의 런만 입력+출력 토큰과 costUsd 를 더한다 — 채널 행도 그 런만", () => {
    run(general, coder, DAY(25, 10), "done", { inputTokens: 7, outputTokens: 3, costUsd: 0.125 });
    run(general, coder, DAY(25, 10), "error"); // usage 없음 — 0 으로 더한다
    const s = summary(1);
    expect(OpsRunsSummary.parse(s)).toEqual(s);
    // 채널 행은 믿는 런만 더한 부분합 — 더한 런 수(measuredRuns)를 함께 실어 웹이 「일부」를 가른다
    expect(row(s.byChannel, general)).toMatchObject({ runs: 5, measuredRuns: 2, tokens: 10, costUsd: 0.125 });
    expect(row(s.byAgent, coder)).toMatchObject({ runs: 2, measuredRuns: 2, tokens: 10, costUsd: 0.125 });
    for (const id of [dev, fin]) {
      expect(row(s.byAgent, id)).not.toHaveProperty("tokens");
      expect(row(s.byAgent, id)).not.toHaveProperty("costUsd");
      expect(row(s.byAgent, id)).not.toHaveProperty("measuredRuns");
    }
  });

  it("믿는 제공자 집합을 바꾸면 그 제공자로 — 비우면 어느 행에도 키가 없다", () => {
    const s = summary(1, new Set(["openclaw"]));
    expect(s.usageTrustedProviders).toEqual(["openclaw"]);
    expect(row(s.byChannel, general)).toMatchObject({ tokens: 125, costUsd: 0.75 });
    expect(row(s.byAgent, dev)).toMatchObject({ tokens: 125, costUsd: 0.75 });
    expect(row(s.byAgent, fin)).toMatchObject({ tokens: 0, costUsd: 0 });

    const none = summary(1, new Set());
    expect(none.usageTrustedProviders).toEqual([]);
    for (const r of [...none.byChannel, ...none.byAgent]) expect(r).not.toHaveProperty("tokens");
  });

  it("costEstimated — 믿는 런 가운데 구독 환산(subscription_estimate)이 하나라도 있으면 true, api 만이면 false", () => {
    const writer = createAgent(db, {
      workspaceId,
      providerAgentId: "writer",
      handle: "writer",
      name: "Writer",
    }).id;
    db.update(agents).set({ provider: "claude" }).where(eq(agents.id, writer)).run();
    run(general, coder, DAY(25, 10), "done", { inputTokens: 1, costUsd: 0.1, costKind: "api" });
    run(general, coder, DAY(25, 10), "done", {
      inputTokens: 1,
      costUsd: 0.2,
      costKind: "subscription_estimate",
    });
    run(random, writer, DAY(25, 10), "done", { inputTokens: 1, costUsd: 0.3, costKind: "api" });
    run(random, writer, DAY(25, 10), "done"); // usage 없음 — 환산 아님
    // 믿지 않는 제공자(openclaw)의 환산 런은 세지 않는다
    run(random, dev, DAY(25, 10), "done", { inputTokens: 1, costUsd: 9, costKind: "subscription_estimate" });
    const s = summary(1);
    expect(OpsRunsSummary.parse(s)).toEqual(s);
    expect(row(s.byAgent, coder)).toMatchObject({ costEstimated: true });
    expect(row(s.byAgent, coder)?.costUsd).toBeCloseTo(0.3);
    expect(row(s.byAgent, writer)).toMatchObject({ costUsd: 0.3, costEstimated: false });
    expect(row(s.byChannel, general)).toMatchObject({ costEstimated: true });
    expect(row(s.byChannel, random)).toMatchObject({
      runs: 3,
      measuredRuns: 2,
      costUsd: 0.3,
      costEstimated: false,
    });
    // 믿는 런이 없는 행에는 키가 없다
    expect(row(s.byAgent, dev)).not.toHaveProperty("costEstimated");
  });

  it("런 없이 막히기만 한 채널 행에는 믿는 런이 없으니 tokens·costUsd 키가 없다", () => {
    blocked(`channel:${random}`, DAY(25, 11));
    const r = row(summary(1, new Set(["openclaw"])).byChannel, random);
    expect(r).toMatchObject({ runs: 0, blocked: 1 });
    expect(r).not.toHaveProperty("tokens");
  });
});

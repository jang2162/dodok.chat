import { dodokSessionKey, type PresenceEntry } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client";
import { memberships, users } from "../src/db/schema.sqlite";
import { createAgent, updateAgent } from "../src/modules/agents/service";
import { createPresenceHub, openRunAgentIds } from "../src/modules/presence/hub";
import { createPresence } from "../src/modules/push/presence";
import { insertRun, updateRun } from "../src/modules/runs/store";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent, seedWorkspace } from "./helpers/seed";

// 접속 허브(프로필 스펙 3.3) — 바뀐 줄만 알리고, 재접속 유예 안에는 오프라인을 내지 않는다

const GRACE = 20_000;
const T0 = new Date("2026-11-02T10:00:00.000Z");

function addMember(db: Db, workspaceId: string, handle: string): string {
  const id = uuid();
  db.insert(users)
    .values({ id, workspaceId, handle, displayName: handle, authProvider: "local", createdAt: T0 })
    .run();
  db.insert(memberships).values({ id: uuid(), workspaceId, userId: id, role: "member" }).run();
  return id;
}

function setup() {
  const db = newTestDb();
  const { workspaceId } = seedWorkspace(db);
  const alice = addMember(db, workspaceId, "alice");
  const presence = createPresence({ onChange: (id) => hub.recomputeUser(id) });
  const emitted: PresenceEntry[][] = [];
  const connected = new Set<string>();
  const working = new Set<string>();
  const hub = createPresenceHub({
    db,
    workspaceId,
    presence,
    connectedAgentIds: () => connected,
    workingAgentIds: () => working,
    emit: (entries) => emitted.push(entries),
    graceMs: GRACE,
    now: () => T0,
  });
  return { db, workspaceId, alice, presence, hub, emitted, connected, working };
}

describe("presence hub", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("스냅숏은 사람·에이전트를 함께 싣는다 — 소켓이 없으면 offline", () => {
    const { db, workspaceId, alice, hub } = setup();
    const agent = createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev", name: "Dev" });
    const snap = hub.snapshot();
    expect(snap).toContainEqual({ kind: "user", id: alice, state: "offline" });
    expect(snap).toContainEqual({ kind: "agent", id: agent.id, state: "disconnected" });
  });

  it("[Review Focus 2] 끊긴 뒤 1초 안에 다시 붙으면 offline 을 내지 않는다", () => {
    const { alice, presence, hub, emitted } = setup();
    hub.snapshot();
    presence.set("s1", alice, { visible: true });
    expect(emitted).toEqual([[{ kind: "user", id: alice, state: "online" }]]);
    presence.drop("s1");
    vi.advanceTimersByTime(1_000);
    presence.set("s2", alice, { visible: true });
    vi.advanceTimersByTime(GRACE * 2);
    expect(emitted).toHaveLength(1);
  });

  it("끊긴 뒤 유예가 지나면 offline 한 번", () => {
    const { alice, presence, hub, emitted } = setup();
    hub.snapshot();
    presence.set("s1", alice, { visible: true });
    presence.drop("s1");
    vi.advanceTimersByTime(GRACE - 1);
    expect(emitted).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(emitted.at(-1)).toEqual([{ kind: "user", id: alice, state: "offline" }]);
  });

  it("탭을 숨기면 away, 같은 값으로 다시 계산하면 emit 하지 않는다", () => {
    const { alice, presence, hub, emitted } = setup();
    hub.snapshot();
    presence.set("s1", alice, { visible: true });
    presence.set("s1", alice, { visible: false });
    expect(emitted.at(-1)).toEqual([{ kind: "user", id: alice, state: "away" }]);
    const n = emitted.length;
    hub.recomputeUser(alice);
    hub.recomputeAll();
    expect(emitted).toHaveLength(n);
  });

  it("[Review Focus 1] invisible 은 접속해도 offline — 스냅숏·변화 어디에도 만료·dnd 가 없다", () => {
    const { db, alice, presence, hub, emitted } = setup();
    hub.snapshot();
    presence.set("s1", alice, { visible: true });
    db.update(users)
      .set({ statusMode: "invisible", statusModeUntil: new Date(T0.getTime() + 3_600_000) })
      .where(eq(users.id, alice))
      .run();
    hub.recomputeUser(alice);
    expect(emitted.at(-1)).toEqual([{ kind: "user", id: alice, state: "offline" }]);
    expect(hub.snapshot().find((e) => e.id === alice)).toEqual({ kind: "user", id: alice, state: "offline" });
  });

  it("비활성 멤버는 점 없음(state null)", () => {
    const { db, alice, hub } = setup();
    db.update(memberships).set({ deactivatedAt: T0 }).where(eq(memberships.userId, alice)).run();
    expect(hub.snapshot().find((e) => e.id === alice)).toEqual({ kind: "user", id: alice, state: null });
  });

  it("[Review Focus 5] 에이전트가 working 이 되면 그 줄만, 키는 kind·id·state 셋뿐", () => {
    const { db, workspaceId, hub, emitted, connected, working } = setup();
    const agent = createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev", name: "Dev" });
    connected.add(agent.id);
    hub.snapshot();
    working.add(agent.id);
    hub.recomputeAgents();
    const last = emitted.at(-1);
    expect(last).toEqual([{ kind: "agent", id: agent.id, state: "working" }]);
    expect(Object.keys(last?.[0] ?? {}).sort()).toEqual(["id", "kind", "state"]);
    updateAgent(db, agent.id, { enabled: false });
    hub.recomputeAgents();
    expect(emitted.at(-1)).toEqual([{ kind: "agent", id: agent.id, state: "off" }]);
  });
});

describe("openRunAgentIds", () => {
  it("끝나지 않은 런의 에이전트만", () => {
    const db = newTestDb();
    const seed = seedChannelWithAgent(db);
    const run = insertRun(db, {
      channelId: seed.channelId,
      conversationId: seed.conversationId,
      agentId: seed.agentId,
      triggerKind: "mention",
      rootMessageId: uuid(),
      relayDepth: 0,
      sessionKey: dodokSessionKey("dev", seed.conversationId),
      createdAt: new Date(),
    });
    expect(openRunAgentIds(db)).toEqual(new Set([seed.agentId]));
    updateRun(db, run.id, { status: "done", endedAt: new Date() });
    expect(openRunAgentIds(db)).toEqual(new Set());
  });
});

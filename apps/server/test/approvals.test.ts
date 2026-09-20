import type { ProviderApproval } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { type Agent, Approval, type RunState } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { createAgent } from "../src/modules/agents/service";
import { addMember, type ChannelRecord, createChannel } from "../src/modules/channels/service";
import { resolvedOutcome } from "../src/modules/approvals/service";
import * as approvalStore from "../src/modules/approvals/store";
import { getRun, insertRun, listRunEvents } from "../src/modules/runs/store";
import { bootTestApp, login } from "./helpers/app";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent } from "./helpers/seed";
import { connectWire, type WireClient, waitFor } from "./helpers/wire";

const MINUTE = 60_000;

describe("승인 저장·런 상관·wire 중계 (앱 부팅, FakeAdapter)", () => {
  let app: App;
  let adapter: FakeAdapter;
  let token: string;
  let dev: Agent;
  /** 테스트마다 새 채널 — 세션 키가 채널마다 달라 앞 테스트가 남긴 열린 런·승인이 섞이지 않는다 */
  let channel: ChannelRecord;
  const sockets: WireClient[] = [];
  let n = 0;

  beforeAll(async () => {
    adapter = new FakeAdapter();
    app = await bootTestApp({}, { adapter });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    ({ token } = await login(app));
    dev = createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
    });
  });
  beforeEach(() => {
    channel = newChannel();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const socket of sockets.splice(0)) socket.close();
  });
  afterAll(async () => {
    await app.close();
  });

  const sessionKeyOf = (providerAgentId: string, channelId: string) =>
    adapter.sessionKeyFor(providerAgentId, channelId);

  function newChannel(): ChannelRecord {
    const created = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: `approvals-${++n}`,
    });
    addMember(app.db, created.id, { memberType: "agent", memberId: dev.id }, app.logger);
    return created;
  }

  /** 채널을 구독한 소켓 */
  const connect = async (channelId: string = channel.id) => {
    const socket = await connectWire(app, token);
    sockets.push(socket);
    const res = await socket.emitWithAck("channel.subscribe", { channelId });
    if (!res.ok) throw new Error(res.error.code);
    return socket;
  };

  /** @dev 멘션 → 라우터 → 오케스트레이터 → adapter.send 까지 확인하고 그 런을 돌려준다 */
  async function mentionDev(socket: WireClient, channelId: string = channel.id): Promise<RunState> {
    const queued = waitFor(socket, "run.state", (p) => p.run.status === "queued" && p.run.agentId === dev.id);
    const sent = await socket.emitWithAck("message.send", {
      channelId,
      clientMsgId: `m-${++n}`,
      bodyMd: "@dev 파일 써줘",
    });
    if (!sent.ok) throw new Error(sent.error.code);
    const { run } = await queued;
    await vi.waitFor(() => expect(adapter.calls.send.some((s) => s.runId === run.id)).toBe(true));
    return run;
  }

  /**
   * 어댑터가 정규화해 올리는 승인 한 건. `channelId`·`providerAgentId` 는 세션 키에서 푼 값이라
   * 기본값도 세션 키에서 만든다 — 그래야 「서버가 세션 키만 믿는가」를 따로 잴 수 있다.
   */
  function providerApproval(sessionKey: string, patch: Partial<ProviderApproval> = {}): ProviderApproval {
    const parts = sessionKey.split(":");
    const createdAt = new Date();
    return {
      providerApprovalId: `plugin:${uuid()}`,
      kind: "plugin",
      sessionKey,
      providerAgentId: parts[1] ?? "dev",
      channelId: parts[4] ?? uuid(),
      toolCallId: `toolu_${++n}`,
      toolName: "Write",
      pluginId: "fs",
      title: "Write 실행",
      description: '{"path":"a.ts"}',
      severity: "warning",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      status: "pending",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 2 * MINUTE).toISOString(),
      ...patch,
    };
  }

  const stored = (a: ProviderApproval) => approvalStore.getApprovalByProviderId(app.db, a.providerApprovalId);
  const eventTypes = (runId: string) => listRunEvents(app.db, runId, 0).map((e) => e.type);

  it("승인 요구를 런에 붙여 저장하고 wire 로 중계한다 — 런 이벤트·awaiting_approval 까지", async () => {
    const socket = await connect();
    const run = await mentionDev(socket);
    const requested = waitFor(socket, "approval.requested");
    const a = providerApproval(sessionKeyOf("dev", channel.id), { toolCallId: "toolu_run" });

    adapter.emitApproval(a);

    const { approval } = await requested;
    expect(Approval.parse(approval)).toMatchObject({
      providerApprovalId: a.providerApprovalId,
      runId: run.id,
      channelId: channel.id,
      agentId: dev.id,
      status: "pending",
      kind: "plugin",
      toolName: "Write",
      toolCallId: "toolu_run",
      severity: "warning",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      expiresAt: a.expiresAt,
      createdAt: a.createdAt,
    });
    expect(approval.decidedBy).toBeUndefined();
    expect(stored(a)).toEqual(approval);

    await vi.waitFor(() => expect(eventTypes(run.id)).toContain("APPROVAL_REQUESTED"));
    const event = listRunEvents(app.db, run.id, 0).find((e) => e.type === "APPROVAL_REQUESTED");
    expect(event).toMatchObject({
      type: "APPROVAL_REQUESTED",
      runId: run.id,
      approvalId: approval.id,
      kind: "plugin",
      title: "Write 실행",
      severity: "warning",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      toolCallId: "toolu_run",
      expiresAt: a.expiresAt,
    });
    await vi.waitFor(() => expect(getRun(app.db, run.id)?.status).toBe("awaiting_approval"));
  });

  it("런이 없으면 runId 없이 채널 수준 승인으로 저장한다", async () => {
    const socket = await connect();
    const requested = waitFor(socket, "approval.requested");

    adapter.emitApproval(providerApproval(sessionKeyOf("dev", channel.id)));

    const { approval } = await requested;
    expect(approval.runId).toBeUndefined();
    expect(approval.channelId).toBe(channel.id);
    expect(approval.agentId).toBe(dev.id);
  });

  it("같은 승인이 두 번 오면 한 번만 중계한다(어댑터 재생성·되감기)", async () => {
    const socket = await connect();
    const seen: string[] = [];
    socket.on("approval.requested", (p) => seen.push(p.approval.id));
    const a = providerApproval(sessionKeyOf("dev", channel.id));

    adapter.emitApproval(a);
    adapter.emitApproval(a);

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await roundTrip(socket);
    expect(seen).toHaveLength(1);
  });

  it("세션 키가 우리 모양이 아니거나 모르는 채널·에이전트면 warn 한 줄만 남기고 버린다", async () => {
    const socket = await connect();
    const warn = vi.spyOn(app.logger, "warn");
    const seen: unknown[] = [];
    socket.on("approval.requested", (p) => seen.push(p));

    const foreign = providerApproval(`agent:dev:discord:channel:${channel.id}`);
    adapter.emitApproval(foreign);
    const unknownChannel = providerApproval(sessionKeyOf("dev", uuid()));
    adapter.emitApproval(unknownChannel);
    const unknownAgent = providerApproval(sessionKeyOf("nobody", channel.id));
    adapter.emitApproval(unknownAgent);

    await roundTrip(socket);
    expect(seen).toEqual([]);
    expect(stored(foreign)).toBeUndefined();
    expect(stored(unknownChannel)).toBeUndefined();
    expect(stored(unknownAgent)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
    for (const call of warn.mock.calls) {
      expect(call[1]).toBe("approval for unknown session");
      // 본문·툴 인자는 로그에 싣지 않는다
      expect(JSON.stringify(call[0])).not.toContain("a.ts");
    }
  });

  it("채널·에이전트는 세션 키에서 푼다 — 프레임이 다른 채널을 가리켜도 따라가지 않는다", async () => {
    const socket = await connect();
    const requested = waitFor(socket, "approval.requested");

    adapter.emitApproval(
      providerApproval(sessionKeyOf("dev", channel.id), {
        channelId: newChannel().id,
        providerAgentId: "nobody",
      }),
    );

    expect((await requested).approval.channelId).toBe(channel.id);
  });

  it("구독 응답이 그 채널의 미해결 승인을 준다 — 만료된 것·해결된 것·다른 채널 것은 뺀다", async () => {
    const socket = await connect();
    const alive = providerApproval(sessionKeyOf("dev", channel.id));
    const expiring = providerApproval(sessionKeyOf("dev", channel.id), {
      expiresAt: new Date(Date.now() - MINUTE).toISOString(),
    });
    const elsewhere = providerApproval(sessionKeyOf("dev", newChannel().id));
    for (const a of [alive, expiring, elsewhere]) adapter.emitApproval(a);
    await vi.waitFor(() => expect(stored(elsewhere)).toBeDefined());

    const res = await socket.emitWithAck("channel.subscribe", { channelId: channel.id });
    if (!res.ok) throw new Error(res.error.code);
    const ids = res.data.pendingApprovals.map((p) => p.providerApprovalId);
    expect(ids).toContain(alive.providerApprovalId);
    expect(ids).not.toContain(expiring.providerApprovalId);
    expect(ids).not.toContain(elsewhere.providerApprovalId);
    expect(res.data.pendingApprovals.every((p) => p.channelId === channel.id)).toBe(true);
  });

  it("해결 이벤트는 저장된 createdAt·expiresAt 을 지키고, decidedBy 없이 decidedAt 만 채운다", async () => {
    const socket = await connect();
    const run = await mentionDev(socket);
    const a = providerApproval(sessionKeyOf("dev", channel.id));
    const requested = waitFor(socket, "approval.requested");
    adapter.emitApproval(a);
    await requested;
    await vi.waitFor(() => expect(getRun(app.db, run.id)?.status).toBe("awaiting_approval"));

    const resolvedAt = new Date(Date.now() + 1_000).toISOString();
    const resolved = waitFor(socket, "approval.resolved");
    // 실물 plugin.approval.resolved 에는 createdAtMs·expiresAtMs 가 없다(스파이크 3.4)
    adapter.emitApproval({
      ...a,
      status: "allowed",
      decision: "allow-once",
      reason: "user",
      resolvedAt,
      createdAt: undefined,
      expiresAt: undefined,
    });

    const { approval } = await resolved;
    expect(approval).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      reason: "user",
      decidedAt: resolvedAt,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
    });
    // 다른 디바이스(TUI·다른 탭)가 해결한 승인이다 — 우리 사용자를 적지 않는다
    expect(approval.decidedBy).toBeUndefined();

    await vi.waitFor(() => expect(eventTypes(run.id)).toContain("APPROVAL_RESOLVED"));
    expect(listRunEvents(app.db, run.id, 0).find((e) => e.type === "APPROVAL_RESOLVED")).toMatchObject({
      approvalId: approval.id,
      decision: "allow-once",
      reason: "user",
    });
    await vi.waitFor(() => expect(getRun(app.db, run.id)?.status).toBe("streaming"));
  });

  it("만료는 decision deny · reason timeout 으로 런 이벤트에 실린다", async () => {
    const socket = await connect();
    const run = await mentionDev(socket);
    const a = providerApproval(sessionKeyOf("dev", channel.id));
    const requested = waitFor(socket, "approval.requested");
    adapter.emitApproval(a);
    await requested;

    const resolved = waitFor(socket, "approval.resolved");
    adapter.emitApproval({ ...a, status: "expired", reason: "timeout", createdAt: undefined });

    expect((await resolved).approval).toMatchObject({ status: "expired", reason: "timeout" });
    await vi.waitFor(() => expect(eventTypes(run.id)).toContain("APPROVAL_RESOLVED"));
    expect(listRunEvents(app.db, run.id, 0).find((e) => e.type === "APPROVAL_RESOLVED")).toMatchObject({
      decision: "deny",
      reason: "timeout",
    });
  });

  it("이미 종료된 승인에 pending 이 늦게 와도 되살리지 않는다", async () => {
    const socket = await connect();
    const a = providerApproval(sessionKeyOf("dev", channel.id));
    adapter.emitApproval(a);
    await vi.waitFor(() => expect(stored(a)?.status).toBe("pending"));
    const resolved = waitFor(socket, "approval.resolved");
    adapter.emitApproval({ ...a, status: "denied", decision: "deny", reason: "user" });
    await resolved;
    const late: unknown[] = [];
    socket.on("approval.requested", (p) => late.push(p));

    adapter.emitApproval(a); // 되감기가 늦게 올라왔다

    await roundTrip(socket);
    expect(late).toEqual([]);
    expect(stored(a)).toMatchObject({ status: "denied", decision: "deny" });
  });

  it("뒤에 온 프레임이 앞 프레임의 값을 지우지 않는다 — session.approval 되감기에는 toolCallId 가 없다", async () => {
    const socket = await connect();
    const a = providerApproval(sessionKeyOf("dev", channel.id), { toolCallId: "toolu_keep" });
    const requested = waitFor(socket, "approval.requested");
    adapter.emitApproval(a);
    await requested;
    expect(stored(a)?.toolCallId).toBe("toolu_keep");
    const seen: string[] = [];
    socket.on("approval.requested", (p) => seen.push(p.approval.id));

    adapter.emitApproval({ ...a, toolCallId: undefined, pluginId: undefined });

    await roundTrip(socket);
    expect(stored(a)).toMatchObject({ toolCallId: "toolu_keep", pluginId: "fs" });
    expect(seen).toEqual([]); // 새 사실이 없으니 중계하지 않는다
  });

  it("detail 은 자르지 않고 그대로 저장해 그대로 중계한다(계약 상한 16KB)", async () => {
    const socket = await connect();
    const detail = "긴".repeat(16_384);
    const requested = waitFor(socket, "approval.requested");

    adapter.emitApproval(providerApproval(sessionKeyOf("dev", channel.id), { detail }));

    const { approval } = await requested;
    expect(approval.detail).toBe(detail);
    expect(approval.detail).toHaveLength(16_384);
  });

  it("한 승인이 깨져도 다음 승인을 막지 않는다", async () => {
    const socket = await connect();
    const error = vi.spyOn(app.logger, "error");
    const requested = waitFor(socket, "approval.requested");

    // 계약을 어긴 값(severity) — 저장 경계에서 터진다
    adapter.emitApproval(
      providerApproval(sessionKeyOf("dev", channel.id), {
        severity: "boom" as never,
      }),
    );
    const good = providerApproval(sessionKeyOf("dev", channel.id));
    adapter.emitApproval(good);

    expect((await requested).approval.providerApprovalId).toBe(good.providerApprovalId);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      "approval ingest failed",
    );
  });

  it("같은 세션에 런이 둘이면 Gateway 에 나간 런(맨 앞)에 붙인다", async () => {
    const socket = await connect();
    const first = await mentionDev(socket);
    const queued = waitFor(
      socket,
      "run.state",
      (p) => p.run.status === "queued" && p.run.id !== first.id && p.run.agentId === dev.id,
    );
    const sent = await socket.emitWithAck("message.send", {
      channelId: channel.id,
      clientMsgId: `m-${++n}`,
      bodyMd: "@dev 하나 더",
    });
    if (!sent.ok) throw new Error(sent.error.code);
    const second = (await queued).run;
    expect(adapter.calls.send.some((s) => s.runId === second.id)).toBe(false);
    const requested = waitFor(socket, "approval.requested");

    adapter.emitApproval(providerApproval(sessionKeyOf("dev", channel.id)));

    expect((await requested).approval.runId).toBe(first.id);
  });

  it("cancelForRun — 그 런의 남은 승인을 cancelled 로 닫고 중계한다", async () => {
    const socket = await connect();
    const run = await mentionDev(socket);
    const a = providerApproval(sessionKeyOf("dev", channel.id));
    const requested = waitFor(socket, "approval.requested");
    adapter.emitApproval(a);
    const approvalId = (await requested).approval.id;
    const resolved = waitFor(socket, "approval.resolved");

    app.services.approvals.cancelForRun(run.id, "run-aborted");

    expect((await resolved).approval).toMatchObject({
      id: approvalId,
      status: "cancelled",
      reason: "run-aborted",
      decidedAt: expect.any(String),
    });
    expect(approvalStore.listRunApprovals(app.db, run.id).map((p) => p.status)).toEqual(["cancelled"]);
    await vi.waitFor(() => expect(eventTypes(run.id)).toContain("APPROVAL_RESOLVED"));
    expect(listRunEvents(app.db, run.id, 0).find((e) => e.type === "APPROVAL_RESOLVED")).toMatchObject({
      decision: "deny",
      reason: "run-aborted",
    });
  });

  /** 같은 연결의 ack 왕복 — 그 전에 서버가 이 소켓에 보낸 이벤트는 모두 도착해 있다 */
  async function roundTrip(socket: WireClient): Promise<void> {
    const res = await socket.emitWithAck("channel.unsubscribe", { channelId: uuid() });
    expect(res).toEqual({ ok: true, data: null });
  }
});

describe("승인 store (메모리 DB)", () => {
  const base = (patch: Partial<approvalStore.ApprovalRowInput> = {}): approvalStore.ApprovalRowInput => ({
    providerApprovalId: `plugin:${uuid()}`,
    kind: "plugin",
    channelId: "",
    agentId: "",
    title: "Write 실행",
    severity: "warning",
    allowedDecisions: ["allow-once", "deny"],
    status: "pending",
    createdAt: new Date("2026-09-20T00:00:00.000Z"),
    expiresAt: new Date("2026-09-20T00:02:00.000Z"),
    ...patch,
  });

  function setup() {
    const db = newTestDb();
    const { channelId, agentId, userId } = seedChannelWithAgent(db);
    const input = (patch: Partial<approvalStore.ApprovalRowInput> = {}) =>
      base({ channelId, agentId, ...patch });
    return { db, channelId, agentId, userId, input };
  }

  it("새 행은 changed, 같은 값이 다시 오면 changed:false, 값이 바뀌면 다시 changed", () => {
    const { db, input } = setup();
    const a = input({ toolCallId: "toolu_1" });

    const first = approvalStore.upsertApproval(db, a);
    expect(first.changed).toBe(true);
    expect(approvalStore.getApproval(db, first.approval.id)).toEqual(first.approval);

    expect(approvalStore.upsertApproval(db, a)).toEqual({ approval: first.approval, changed: false });

    const changed = approvalStore.upsertApproval(db, { ...a, title: "다른 제목" });
    expect(changed.changed).toBe(true);
    expect(changed.approval).toMatchObject({ id: first.approval.id, title: "다른 제목" });
  });

  it("값이 오지 않은 열은 지우지 않는다 — createdAt·expiresAt 도 새 행일 때만 쓴다", () => {
    const { db, input } = setup();
    const a = input({ toolCallId: "toolu_1", toolName: "Write" });
    const { approval } = approvalStore.upsertApproval(db, a);

    // 해결 프레임: createdAtMs·expiresAtMs 가 없고 session.approval 에는 toolCallId 도 없다
    const resolved = approvalStore.upsertApproval(db, {
      ...a,
      toolCallId: undefined,
      status: "allowed",
      decision: "allow-once",
      reason: "user",
      decidedAt: new Date("2026-09-20T00:01:00.000Z"),
      createdAt: new Date("2026-09-20T09:00:00.000Z"),
      expiresAt: undefined,
    });

    expect(resolved.changed).toBe(true);
    expect(resolved.approval).toMatchObject({
      id: approval.id,
      toolCallId: "toolu_1",
      toolName: "Write",
      status: "allowed",
      decision: "allow-once",
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
      decidedAt: "2026-09-20T00:01:00.000Z",
    });
  });

  it("종료된 행은 더 바뀌지 않는다 — 늦게 온 pending 도, 다른 결말도", () => {
    const { db, input } = setup();
    const a = input();
    approvalStore.upsertApproval(db, a);
    const denied = approvalStore.upsertApproval(db, {
      ...a,
      status: "denied",
      decision: "deny",
      reason: "user",
      decidedAt: new Date("2026-09-20T00:01:00.000Z"),
    });

    expect(approvalStore.upsertApproval(db, a)).toEqual({ approval: denied.approval, changed: false });
    expect(approvalStore.upsertApproval(db, { ...a, status: "expired", reason: "timeout" })).toEqual({
      approval: denied.approval,
      changed: false,
    });
  });

  it("expiresAt 이 아예 없는 새 행은 createdAt 으로 채운다(만료로 본다)", () => {
    const { db, input, channelId } = setup();
    const { approval } = approvalStore.upsertApproval(db, input({ expiresAt: undefined }));

    expect(approval.expiresAt).toBe(approval.createdAt);
    expect(approvalStore.listPendingApprovals(db, channelId, new Date("2026-09-20T00:01:00.000Z"))).toEqual(
      [],
    );
  });

  it("계약을 어긴 값은 행을 남기지 않는다 — 다음 조회를 막지 않게", () => {
    const { db, input, channelId } = setup();
    const broken = input({ severity: "boom" as never });

    expect(() => approvalStore.upsertApproval(db, broken)).toThrow();

    expect(approvalStore.getApprovalByProviderId(db, broken.providerApprovalId)).toBeUndefined();
    expect(approvalStore.listPendingApprovals(db, channelId, new Date("2026-09-20T00:01:00.000Z"))).toEqual(
      [],
    );
  });

  it("조회 셋 — 채널의 살아 있는 승인·런의 승인 전부·런의 미해결 승인", () => {
    const { db, input, channelId, agentId } = setup();
    const run = insertRun(db, {
      channelId,
      agentId,
      triggerKind: "mention",
      rootMessageId: uuid(),
      relayDepth: 0,
      sessionKey: `agent:dev:dodok:channel:${channelId}`,
      createdAt: new Date("2026-09-20T00:00:00.000Z"),
    });
    const live = approvalStore.upsertApproval(db, input({ runId: run.id })).approval;
    const dead = approvalStore.upsertApproval(db, {
      ...input({ runId: run.id }),
      expiresAt: new Date("2026-09-20T00:00:30.000Z"),
    }).approval;
    const channelOnly = approvalStore.upsertApproval(db, input()).approval;
    const at = new Date("2026-09-20T00:01:00.000Z");

    expect(approvalStore.listPendingApprovals(db, channelId, at).map((p) => p.id)).toEqual([
      live.id,
      channelOnly.id,
    ]);
    expect(approvalStore.listRunApprovals(db, run.id).map((p) => p.id)).toEqual([live.id, dead.id]);
    // 만료 시각이 지났어도 아직 pending 이면 런이 닫을 대상이다
    expect(approvalStore.listPendingApprovalsByRun(db, run.id).map((p) => p.id)).toEqual([live.id, dead.id]);
  });

  it("markApproval 은 해결자를 그대로 적고, 주지 않으면 비운다", () => {
    const { db, input, userId } = setup();
    const { approval } = approvalStore.upsertApproval(db, input());
    const at = new Date("2026-09-20T00:01:00.000Z");

    const mine = approvalStore.markApproval(db, approval.id, {
      status: "allowed",
      decision: "allow-once",
      reason: "user",
      decidedBy: userId,
      decidedAt: at,
    });
    expect(mine).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      reason: "user",
      decidedBy: userId,
      decidedAt: at.toISOString(),
    });

    const cancelled = approvalStore.markApproval(db, approval.id, {
      status: "cancelled",
      reason: "run-aborted",
      decidedAt: at,
    });
    expect(cancelled.decidedBy).toBeUndefined();
    expect(cancelled.decision).toBeUndefined();
    expect(() => approvalStore.markApproval(db, uuid(), { status: "expired", decidedAt: at })).toThrow();
  });

  it("resolvedOutcome — 만료·취소는 deny 로, 결정 없는 허용은 allow-once 로 정규화한다", () => {
    expect(resolvedOutcome({ status: "allowed", decision: "allow-always", reason: "user" })).toEqual({
      decision: "allow-always",
      reason: "user",
    });
    expect(resolvedOutcome({ status: "expired" })).toEqual({ decision: "deny", reason: "timeout" });
    expect(resolvedOutcome({ status: "cancelled" })).toEqual({ decision: "deny", reason: "run-aborted" });
    expect(resolvedOutcome({ status: "allowed" })).toEqual({ decision: "allow-once", reason: "user" });
    expect(resolvedOutcome({ status: "denied" })).toEqual({ decision: "deny", reason: "user" });
  });
});

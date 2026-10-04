import { AdapterError, type ProviderApproval } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { type Agent, Approval, type ApprovalDecision, type RunState } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { createAgent } from "../src/modules/agents/service";
import { addMember, type ChannelRecord, createChannel } from "../src/modules/channels/service";
import { resolvedOutcome } from "../src/modules/approvals/service";
import * as approvalStore from "../src/modules/approvals/store";
import { getRun, insertRun, listRunEvents } from "../src/modules/runs/store";
import { createUserMessage } from "../src/modules/messages/service";
import { ServerBus } from "../src/realtime/bus";
import type { WireServer } from "../src/realtime/types";
import type { Logger } from "../src/logger";
import type { RunTimeouts } from "../src/modules/runs/orchestrator";
import { createAdapterRegistry } from "../src/adapters/registry";
import { createServices } from "../src/wiring";
import { bootTestApp, login } from "./helpers/app";
import { newTestDb } from "./helpers/db";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { seedChannelWithAgent } from "./helpers/seed";
import { connectWire, recordEvents, type WireClient, waitFor } from "./helpers/wire";

const MINUTE = 60_000;

let seq = 0;

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
    toolCallId: `toolu_${++seq}`,
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

type BroadcastScope = { event: string; rooms: string[] };

/**
 * 서버가 이벤트를 **어느 룸으로** 냈는지 기록한다. 받은 소켓만 세서는 워크스페이스 룸과 전역 방송(`io.emit`)이
 * 구별되지 않는다 — 접속한 소켓은 모두 그 워크스페이스 룸에 있기 때문이다(socket.ts 의 「서버는 워크스페이스 하나」).
 * Socket.IO 4.8.3 은 브로드캐스트를 어댑터로 내려보내고(`adapter.broadcast(packet, opts)`) `opts.rooms` 가 곧 그 범위다 —
 * 전역이면 빈 셋이다. 스파이는 `vi.restoreAllMocks()`(afterEach)가 원복한다.
 */
function recordBroadcastScope(io: WireServer, events: string[]): BroadcastScope[] {
  const seen: BroadcastScope[] = [];
  const adapter = io.sockets.adapter as unknown as {
    broadcast(packet: { data?: unknown }, opts: { rooms: Set<string> }): void;
  };
  const passthrough = adapter.broadcast.bind(adapter);
  vi.spyOn(adapter, "broadcast").mockImplementation((packet, opts) => {
    const name = Array.isArray(packet.data) ? String(packet.data[0]) : "";
    if (events.includes(name)) seen.push({ event: name, rooms: [...opts.rooms] });
    passthrough(packet, opts);
  });
  return seen;
}

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
    app = await bootTestApp({}, { adapters: [adapter] });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    ({ token } = await login(app));
    dev = createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
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

  /**
   * 이 소켓이 `channelId` **밖**임을 관측으로 잠근다. 구독은 서버 쪽 룸이라 클라이언트에서 직접 볼 수 없지만
   * 채널 룸 이벤트는 구독한 채널에만 가므로(wire.test.ts 「bus 팬아웃」) 그 채널에 메시지를 하나 흘리면 그림자가 잡힌다 —
   * 보낸 사람도 그 채널 룸으로 되받으니 ack 가 돌아온 시점에 팬아웃은 이미 끝나 있다.
   * 이게 없으면 「다른 채널이어도 승인이 닿는다」가 공허해진다: 받는 소켓을 같은 채널 구독으로 바꿔도 전부 초록이다.
   */
  async function expectOutside(socket: WireClient, channelId: string): Promise<void> {
    const leaked = recordEvents(socket, ["message.created"]);
    const sent = await socket.emitWithAck("message.send", {
      channelId,
      clientMsgId: `outside-${++n}`,
      bodyMd: "구독 밖 확인 — 멘션 없음",
    });
    if (!sent.ok) throw new Error(sent.error.code);
    await roundTrip(socket);
    expect(leaked).toEqual([]);
  }

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

  const stored = (a: Pick<ProviderApproval, "providerApprovalId">) =>
    approvalStore.getApprovalByProviderId(app.db, a.providerApprovalId);
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

  it("대문자로 저장된 providerAgentId 에도 소문자 세션 키의 승인이 붙는다(코어가 키를 소문자로 접는다)", async () => {
    const upper = createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: "UpperDev",
      handle: "upperdev",
      name: "Upper",
    });
    addMember(app.db, channel.id, { memberType: "agent", memberId: upper.id }, app.logger);
    const socket = await connect();
    const requested = waitFor(socket, "approval.requested");

    adapter.emitApproval(providerApproval(sessionKeyOf("upperdev", channel.id)));

    const { approval } = await requested;
    expect(approval.agentId).toBe(upper.id);
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

  // 어댑터가 두 프레임을 병합해 같은 승인을 다시 준다(p2-t6 C) — 값은 채우되 카드는 하나여야 한다
  it("같은 승인의 값이 뒤늦게 차면 wire 로만 갱신하고 타임라인 카드는 그대로 둔다", async () => {
    const socket = await connect();
    const run = await mentionDev(socket);
    const seen: Approval[] = [];
    socket.on("approval.requested", (p) => seen.push(p.approval));
    const a = providerApproval(sessionKeyOf("dev", channel.id), { toolCallId: "toolu_run" });

    adapter.emitApproval(a); // 정본 — toolCallId 만
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    adapter.emitApproval({ ...a, urlPath: "/approve/plugin%3Aabc" }); // 병합본 — urlPath 가 찼다

    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[0]?.urlPath).toBeUndefined();
    expect(seen[1]).toMatchObject({
      id: seen[0]?.id,
      toolCallId: "toolu_run",
      urlPath: "/approve/plugin%3Aabc",
    });
    expect(stored(a)).toMatchObject({ toolCallId: "toolu_run", urlPath: "/approve/plugin%3Aabc" });
    // 카드도 런 신호도 한 번뿐이다 — 같은 승인을 타임라인에 또 쌓지 않는다
    await roundTrip(socket);
    expect(eventTypes(run.id).filter((t) => t === "APPROVAL_REQUESTED")).toHaveLength(1);
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

  it("승인 팬아웃은 워크스페이스 룸까지다 — 아무 채널도 구독하지 않은 소켓도 받고, 그 너머로는 안 나간다", async () => {
    // p2-t4 는 「그 채널 구독자에게만」을 잠갔다. 웹은 한 번에 한 채널만 구독해서 그러면 다른 채널을 보는 동안
    // 승인이 아예 닿지 않는다(브라우저 검증 D1) — 판정 7 로 워크스페이스 룸까지 넓혔다. 노출은 늘지 않는다:
    // channel.subscribe 는 워크스페이스 소속만 보므로(socket.ts) 접속한 소켓은 어느 채널이든 구독해 같은 값을 이미 받을 수 있다.
    // 새 경계는 「워크스페이스 룸까지, 그 너머는 아니다」다. 받은 소켓만 세면 전역 방송과 구별되지 않아 룸 이름을 직접 잰다.
    const idle = await connectWire(app, token); // 채널을 하나도 구독하지 않은 소켓 — 그래도 워크스페이스 룸에는 있다
    sockets.push(idle);
    const scope = recordBroadcastScope(app.io, ["approval.requested", "approval.resolved"]);
    // detail 에는 파일 내용이 실린다 — 워크스페이스 밖으로 새면 안 되는 값이라 이 자리에서 같이 잠근다
    const a = providerApproval(sessionKeyOf("dev", channel.id), { detail: "secret-file-body" });

    const requested = waitFor(idle, "approval.requested");
    adapter.emitApproval(a);
    expect((await requested).approval.detail).toBe("secret-file-body");
    const resolved = waitFor(idle, "approval.resolved");
    adapter.emitApproval({ ...a, status: "denied", decision: "deny", reason: "user" });
    expect((await resolved).approval.status).toBe("denied");

    await roundTrip(idle);
    // 룸 이름을 글자 그대로 — workspaceRoom() 을 다시 부르면 구현이 바뀔 때 테스트도 같이 따라간다
    expect(scope).toEqual([
      { event: "approval.requested", rooms: [`workspace:${app.workspaceId}`] },
      { event: "approval.resolved", rooms: [`workspace:${app.workspaceId}`] },
    ]);
  });

  it("다른 채널을 구독한 소켓도 승인 요구를 받는다 — 알림의 「다른 채널」 분기가 닿는다", async () => {
    const other = newChannel();
    const mine = await connect();
    const theirs = await connect(other.id);
    await expectOutside(theirs, channel.id); // 제목의 「다른 채널을 구독한」을 실제로 잰다

    const atMine = waitFor(mine, "approval.requested");
    const atTheirs = waitFor(theirs, "approval.requested");
    adapter.emitApproval(providerApproval(sessionKeyOf("dev", channel.id), { title: "Write 실행" }));

    const { approval } = await atTheirs;
    // 카드의 채널은 승인이 난 채널이다 — 받는 소켓이 구독 중인 채널이 아니다. 웹은 이 값으로 「지금 보는 채널인가」를 가린다
    expect({ channelId: approval.channelId, title: approval.title }).toEqual({
      channelId: channel.id,
      title: "Write 실행",
    });
    expect(approval.channelId).not.toBe(other.id);
    expect((await atMine).approval.id).toBe(approval.id);
  });

  it("확정도 다른 채널 소켓에 닿는다 — 보고 있지 않은 채널의 카드도 닫힌다", async () => {
    const other = newChannel();
    const theirs = await connect(other.id);
    await expectOutside(theirs, channel.id); // 확정을 받는 소켓도 승인 채널 밖이어야 의미가 있다
    const a = providerApproval(sessionKeyOf("dev", channel.id));

    const requested = waitFor(theirs, "approval.requested");
    adapter.emitApproval(a);
    const opened = (await requested).approval;

    const resolved = waitFor(theirs, "approval.resolved");
    adapter.emitApproval({ ...a, status: "denied", decision: "deny", reason: "user" });
    const closed = (await resolved).approval;
    expect({
      id: closed.id,
      channelId: closed.channelId,
      status: closed.status,
      decision: closed.decision,
    }).toEqual({ id: opened.id, channelId: channel.id, status: "denied", decision: "deny" });
  });

  it("구독 응답이 그 채널의 미해결 승인을 준다 — 만료된 것·해결된 것·다른 채널 것은 뺀다", async () => {
    const socket = await connect();
    const alive = providerApproval(sessionKeyOf("dev", channel.id));
    const expiring = providerApproval(sessionKeyOf("dev", channel.id), {
      expiresAt: new Date(Date.now() - MINUTE).toISOString(),
    });
    const elsewhere = providerApproval(sessionKeyOf("dev", newChannel().id));
    // 만료 시각은 아직 남았는데 이미 해결된 것 — 재접속·채널 전환마다 죽은 카드가 되살아나면 안 된다
    const decided = providerApproval(sessionKeyOf("dev", channel.id));
    for (const a of [alive, expiring, elsewhere, decided]) adapter.emitApproval(a);
    await vi.waitFor(() => expect(stored(decided)?.status).toBe("pending"));
    adapter.emitApproval({ ...decided, status: "denied", decision: "deny", reason: "user" });
    await vi.waitFor(() => expect(stored(decided)?.status).toBe("denied"));
    expect(stored(elsewhere)).toBeDefined();

    const res = await socket.emitWithAck("channel.subscribe", { channelId: channel.id });
    if (!res.ok) throw new Error(res.error.code);
    const ids = res.data.pendingApprovals.map((p) => p.providerApprovalId);
    expect(ids).toContain(alive.providerApprovalId);
    expect(ids).not.toContain(expiring.providerApprovalId);
    expect(ids).not.toContain(decided.providerApprovalId);
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

  it("확정 짝의 뒤엣것이 빈 decision 을 채운다 — wire 로만 가고 타임라인은 한 줄 그대로", async () => {
    // ⚠ 실측(5.2) — 만료는 짝으로 온다. 먼저 오는 세션 스냅샷에는 `decision` 이 없고 정본에만 `deny` 가 있다
    const socket = await connect();
    const run = await mentionDev(socket);
    const a = providerApproval(sessionKeyOf("dev", channel.id));
    const requested = waitFor(socket, "approval.requested");
    adapter.emitApproval(a);
    await requested;

    const first = waitFor(socket, "approval.resolved");
    adapter.emitApproval({ ...a, status: "expired", reason: "timeout", createdAt: undefined });
    expect((await first).approval.decision).toBeUndefined();

    const filled = waitFor(socket, "approval.resolved");
    adapter.emitApproval({
      ...a,
      status: "expired",
      decision: "deny",
      reason: "timeout",
      createdAt: undefined,
    });

    expect((await filled).approval).toMatchObject({ status: "expired", decision: "deny", reason: "timeout" });
    expect(stored(a)).toMatchObject({ status: "expired", decision: "deny", reason: "timeout" });
    // 결말은 이미 알렸다 — 값만 늦게 찼으므로 APPROVAL_RESOLVED 가 또 쌓이지 않는다
    await roundTrip(socket);
    expect(eventTypes(run.id).filter((t) => t === "APPROVAL_RESOLVED")).toHaveLength(1);
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
    // 행의 decision 은 **제공자가 보고한 결정**만 담는다 — 런이 사라져 우리가 닫는 취소는 아무도 결정하지 않았다.
    // (만료는 Gateway 가 deny 로 보고하므로 감시 경로도 deny 를 적는다 — 아래 만료 테스트)
    expect((await resolved).approval.decision).toBeUndefined();
    await vi.waitFor(() => expect(eventTypes(run.id)).toContain("APPROVAL_RESOLVED"));
    expect(listRunEvents(app.db, run.id, 0).find((e) => e.type === "APPROVAL_RESOLVED")).toMatchObject({
      decision: "deny",
      reason: "run-aborted",
    });
  });

  /** 런에 붙은 pending 승인 하나를 만들고(선택: 그 전에 툴을 열어 둔다) 저장된 행을 돌려준다 */
  async function pendingApproval(
    socket: WireClient,
    opts: { patch?: Partial<ProviderApproval>; toolOpen?: boolean } = {},
  ): Promise<{ run: RunState; approval: Approval }> {
    const run = await mentionDev(socket);
    if (opts.toolOpen !== false) {
      adapter.emit({ kind: "run_signal", runId: run.id, signal: { kind: "tool_start" } });
      await vi.waitFor(() => expect(getRun(app.db, run.id)?.status).toBe("tool"));
    }
    const requested = waitFor(socket, "approval.requested");
    adapter.emitApproval(providerApproval(sessionKeyOf("dev", channel.id), opts.patch));
    const { approval } = await requested;
    await vi.waitFor(() => expect(getRun(app.db, run.id)?.status).toBe("awaiting_approval"));
    return { run, approval };
  }

  const resolve = (socket: WireClient, approvalId: string, decision: ApprovalDecision) =>
    socket.emitWithAck("approval.resolve", { approvalId, decision });

  it("검사에 걸리면 Gateway 로 보내지 않는다 — 멤버·존재·pending·만료·allowedDecisions·어댑터 연결", async () => {
    const socket = await connect();
    const sent = adapter.calls.resolveApproval.length;

    // 다른 워크스페이스의 승인 — 존재는 알리지 않는다
    const other = seedChannelWithAgent(app.db, { channelName: "other-ws" });
    const foreign = approvalStore.upsertApproval(app.db, {
      providerApprovalId: `plugin:${uuid()}`,
      kind: "plugin",
      channelId: other.channelId,
      agentId: other.agentId,
      title: "남의 워크스페이스",
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      status: "pending",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + MINUTE),
    }).approval;
    expect(await resolve(socket, foreign.id, "allow-once")).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });

    expect(await resolve(socket, uuid(), "allow-once")).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });

    // 이미 확정된 승인
    const done = providerApproval(sessionKeyOf("dev", channel.id));
    adapter.emitApproval(done);
    await vi.waitFor(() => expect(stored(done)?.status).toBe("pending"));
    adapter.emitApproval({ ...done, status: "denied", decision: "deny", reason: "user" });
    await vi.waitFor(() => expect(stored(done)?.status).toBe("denied"));
    expect(await resolve(socket, stored(done)?.id ?? "", "allow-once")).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });

    // 만료 시각이 지난 승인 — 행은 아직 pending 이다
    const stale = providerApproval(sessionKeyOf("dev", channel.id), {
      expiresAt: new Date(Date.now() - MINUTE).toISOString(),
    });
    adapter.emitApproval(stale);
    await vi.waitFor(() => expect(stored(stale)?.status).toBe("pending"));
    expect(await resolve(socket, stored(stale)?.id ?? "", "allow-once")).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });

    // allowedDecisions 밖 결정 — 보내면 Gateway 가 조용히 거절로 확정한다(스파이크 4.4)
    const narrow = providerApproval(sessionKeyOf("dev", channel.id), {
      allowedDecisions: ["allow-once", "deny"],
    });
    adapter.emitApproval(narrow);
    await vi.waitFor(() => expect(stored(narrow)?.status).toBe("pending"));
    expect(await resolve(socket, stored(narrow)?.id ?? "", "allow-always")).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });

    // Gateway 가 끊겼다
    const live = providerApproval(sessionKeyOf("dev", channel.id));
    adapter.emitApproval(live);
    await vi.waitFor(() => expect(stored(live)?.status).toBe("pending"));
    adapter.setStatus({ provider: "openclaw", gateway: "down", bridge: "connected" });
    try {
      expect(await resolve(socket, stored(live)?.id ?? "", "allow-once")).toMatchObject({
        ok: false,
        error: { code: "ADAPTER_UNAVAILABLE" },
      });
    } finally {
      adapter.setStatus({ provider: "openclaw", gateway: "connected", bridge: "connected" });
    }

    expect(adapter.calls.resolveApproval.slice(sent)).toEqual([]);
    expect(stored(narrow)?.status).toBe("pending");
    expect(stored(live)?.status).toBe("pending");
  });

  it("허용하면 Gateway 로 보내고 런이 대기 직전 상태로 돌아간다 — decidedBy 는 우리 사용자", async () => {
    const socket = await connect();
    const { run, approval } = await pendingApproval(socket);
    const resolved = waitFor(socket, "approval.resolved");

    expect(await resolve(socket, approval.id, "allow-once")).toEqual({ ok: true, data: null });

    expect(adapter.calls.resolveApproval.at(-1)).toEqual({
      providerApprovalId: approval.providerApprovalId,
      kind: "plugin", // 저장된 행의 kind 다 — wire 에는 없다
      decision: "allow-once",
    });
    expect((await resolved).approval).toMatchObject({
      id: approval.id,
      status: "allowed",
      decision: "allow-once",
      reason: "user",
      decidedBy: app.ownerUserId,
      decidedAt: expect.any(String),
    });
    expect(stored(approval)).toMatchObject({ status: "allowed", decidedBy: app.ownerUserId });
    // 승인 전에 툴이 열려 있었다 — streaming 으로 되돌아가지 않는다
    await vi.waitFor(() => expect(getRun(app.db, run.id)?.status).toBe("tool"));
    expect(listRunEvents(app.db, run.id, 0).find((e) => e.type === "APPROVAL_RESOLVED")).toMatchObject({
      decision: "allow-once",
      reason: "user",
      decidedBy: app.ownerUserId,
    });
  });

  it("거절해도 런은 죽지 않는다 — denied 로 닫고 툴 오류를 기다린다", async () => {
    const socket = await connect();
    const { run, approval } = await pendingApproval(socket);
    const resolved = waitFor(socket, "approval.resolved");

    expect(await resolve(socket, approval.id, "deny")).toEqual({ ok: true, data: null });

    expect((await resolved).approval).toMatchObject({ status: "denied", decision: "deny", reason: "user" });
    await vi.waitFor(() => expect(getRun(app.db, run.id)?.status).toBe("tool"));
  });

  it("승인 전에 툴이 열려 있지 않았으면 streaming 으로 돌아간다", async () => {
    const socket = await connect();
    const { run, approval } = await pendingApproval(socket, { toolOpen: false });

    expect(await resolve(socket, approval.id, "allow-once")).toEqual({ ok: true, data: null });

    await vi.waitFor(() => expect(getRun(app.db, run.id)?.status).toBe("streaming"));
  });

  it("Gateway 이벤트가 먼저 와도 결과는 먼저 온 쪽 그대로이되, 해결자는 approval.resolve 를 부른 사용자로 남는다", async () => {
    const socket = await connect();
    const { approval } = await pendingApproval(socket);
    const seen: Approval[] = [];
    socket.on("approval.resolved", (p) => seen.push(p.approval));
    // RPC 를 기다리는 사이 Gateway 가 같은 사실을 이벤트로 먼저 줬다(어댑터는 RPC 응답을 중복 제거에 넣지 않는다)
    const spy = vi
      .spyOn(adapter, "resolveApproval")
      .mockImplementationOnce(async (providerApprovalId, kind, decision) => {
        const terminal: ProviderApproval = {
          ...providerApproval(sessionKeyOf("dev", channel.id)),
          providerApprovalId,
          kind,
          status: "allowed",
          decision,
          reason: "user",
          resolvedAt: new Date().toISOString(),
        };
        adapter.emitApproval(terminal);
        return terminal;
      });

    expect(await resolve(socket, approval.id, "allow-once")).toEqual({ ok: true, data: null });

    expect(spy).toHaveBeenCalledTimes(1);
    await roundTrip(socket);
    expect(seen.map((a) => a.id)).toEqual([approval.id]); // 두 번 중계하지 않는다
    // 결과(허용·거절)는 먼저 온 쪽(Gateway 이벤트) 그대로다 — 그래도 이 승인을 해결한 사람은 우리 사용자다(사람이 여럿인
    // 팀에서는 누가 눌렀는지가 감사 기록이다) — decided_by 가 비어 있을 때만 채우는 갱신으로 뒤늦게 남긴다
    expect(stored(approval)).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      decidedBy: app.ownerUserId,
    });
  });

  it("반대 순서 — RPC 응답이 먼저 decided_by 를 적고 나면, 뒤늦게 온 같은 결말의 이벤트가 지우지 않는다", async () => {
    const socket = await connect();
    const { approval } = await pendingApproval(socket);
    const a = providerApproval(sessionKeyOf("dev", channel.id), {
      providerApprovalId: approval.providerApprovalId,
    });

    expect(await resolve(socket, approval.id, "allow-once")).toEqual({ ok: true, data: null });
    expect(stored(approval)).toMatchObject({ status: "allowed", decidedBy: app.ownerUserId });

    // 같은 승인의 확정 이벤트가 뒤늦게 도착한다(어댑터 재생성·되감기) — 종료된 행이라 더 바뀌지 않는다
    adapter.emitApproval({ ...a, status: "allowed", decision: "allow-once", reason: "user" });

    await roundTrip(socket);
    expect(stored(approval)).toMatchObject({ status: "allowed", decidedBy: app.ownerUserId });
  });

  it("Gateway 이벤트가 먼저 다른 결정으로 확정되면 — 진 결정을 낸 나는 결정자로 남지 않는다", async () => {
    const socket = await connect();
    const { approval } = await pendingApproval(socket);
    // RPC 를 기다리는 사이 Gateway 가 다른 결정(허용)으로 이미 확정했다 — 나는 "deny" 를 눌렀지만 진 쪽이다
    const spy = vi
      .spyOn(adapter, "resolveApproval")
      .mockImplementationOnce(async (providerApprovalId, kind, _decision) => {
        const terminal: ProviderApproval = {
          ...providerApproval(sessionKeyOf("dev", channel.id)),
          providerApprovalId,
          kind,
          status: "allowed",
          decision: "allow-once",
          reason: "user",
          resolvedAt: new Date().toISOString(),
        };
        adapter.emitApproval(terminal); // 다른 사람의 결정(허용)이 이벤트로 먼저 온다
        return terminal; // 내 RPC 응답도 승자 스냅샷 그대로 — applied:false 상황을 흉내
      });

    expect(await resolve(socket, approval.id, "deny")).toEqual({ ok: true, data: null });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(stored(approval)).toMatchObject({ status: "allowed", decision: "allow-once" });
    // 결과는 허용인데 나는 거절을 눌렀다 — 진 결정을 낸 내가 결정자로 남으면 안 된다
    expect(stored(approval)?.decidedBy).toBeUndefined();
  });

  it("두 사람이 거의 동시에 결정하면 먼저 결정자로 남은 사람만 남는다 — 나중 사용자는 덮지 못한다", async () => {
    const socket = await connect();
    const { approval } = await pendingApproval(socket);
    const otherUserId = uuid();
    // Gateway 이벤트가 먼저 결말을 적어 decided_by 가 아직 빈 채로 닫혔다고 가정한다(두 사람 다 이 상태에서 출발)
    adapter.emitApproval({
      ...providerApproval(sessionKeyOf("dev", channel.id), {
        providerApprovalId: approval.providerApprovalId,
      }),
      status: "allowed",
      decision: "allow-once",
      reason: "user",
    });
    await vi.waitFor(() => expect(stored(approval)?.status).toBe("allowed"));
    expect(stored(approval)?.decidedBy).toBeUndefined();

    // 먼저 결정자로 claim 한 사용자만 남고, 뒤이어 다른 사용자가 같은 승인을 claim 해도 덮지 못한다
    approvalStore.claimDecidedBy(app.db, approval.id, app.ownerUserId);
    approvalStore.claimDecidedBy(app.db, approval.id, otherUserId);

    expect(stored(approval)?.decidedBy).toBe(app.ownerUserId);
  });

  it("earliestPendingExpiry — 그 런의 미해결 승인 중 가장 이른 만료 시각(해결된 것은 세지 않는다)", async () => {
    const socket = await connect();
    const run = await mentionDev(socket);
    const late = providerApproval(sessionKeyOf("dev", channel.id), {
      expiresAt: new Date(Date.now() + 5 * MINUTE).toISOString(),
    });
    const soon = providerApproval(sessionKeyOf("dev", channel.id), {
      expiresAt: new Date(Date.now() + MINUTE).toISOString(),
    });
    // 먼저 온 것이 늦게 만료된다 — 도착 순서가 아니라 만료 시각으로 골라야 한다
    for (const a of [late, soon]) adapter.emitApproval(a);
    await vi.waitFor(() => expect(stored(soon)?.status).toBe("pending"));

    expect(app.services.approvals.earliestPendingExpiry(run.id)?.toISOString()).toBe(soon.expiresAt);

    adapter.emitApproval({ ...soon, status: "denied", decision: "deny", reason: "user" });
    await vi.waitFor(() => expect(stored(soon)?.status).toBe("denied"));
    expect(app.services.approvals.earliestPendingExpiry(run.id)?.toISOString()).toBe(late.expiresAt);
  });

  it("Gateway 가 우리 결정과 다르게 확정하면 그대로 적고 해결자는 비운다", async () => {
    const socket = await connect();
    const { approval } = await pendingApproval(socket);
    // 목록 안의 결정이라도 Gateway 가 거절로 확정할 수 있다(malformed-verdict) — 정본은 Gateway 스냅샷이다
    vi.spyOn(adapter, "resolveApproval").mockImplementationOnce(async (providerApprovalId, kind) => ({
      ...providerApproval(sessionKeyOf("dev", channel.id)),
      providerApprovalId,
      kind,
      status: "denied",
      decision: "deny",
      reason: "malformed-verdict",
      resolvedAt: new Date().toISOString(),
    }));
    const resolved = waitFor(socket, "approval.resolved");

    expect(await resolve(socket, approval.id, "allow-once")).toEqual({ ok: true, data: null });

    expect((await resolved).approval).toMatchObject({
      status: "denied",
      decision: "deny",
      reason: "malformed-verdict",
    });
    expect(stored(approval)?.decidedBy).toBeUndefined(); // 우리가 누른 결정이 아니다
  });

  it("Gateway 가 거부하면 그 코드를 그대로 돌려주고 행은 pending 으로 남는다", async () => {
    const socket = await connect();
    const { approval } = await pendingApproval(socket);
    vi.spyOn(adapter, "resolveApproval").mockRejectedValueOnce(
      new AdapterError("ADAPTER_UNAVAILABLE", "no gateway connection"),
    );

    expect(await resolve(socket, approval.id, "allow-once")).toMatchObject({
      ok: false,
      error: { code: "ADAPTER_UNAVAILABLE" },
    });

    expect(stored(approval)?.status).toBe("pending"); // 다시 누를 수 있다
  });

  it("런을 중지하면 남은 승인을 cancelled 로 닫고 APPROVAL_RESOLVED 를 타임라인에 남긴다", async () => {
    const socket = await connect();
    const { run, approval } = await pendingApproval(socket);
    const resolved = waitFor(socket, "approval.resolved");
    const states: string[] = [];
    socket.on("run.state", (p) => {
      if (p.run.id === run.id) states.push(p.run.status);
    });

    expect(await socket.emitWithAck("run.abort", { runId: run.id })).toEqual({ ok: true, data: null });

    expect((await resolved).approval).toMatchObject({
      id: approval.id,
      status: "cancelled",
      reason: "run-aborted",
    });
    await vi.waitFor(() => expect(getRun(app.db, run.id)?.status).toBe("aborted"));
    // 승인을 닫느라 런이 대기 직전 상태로 되돌아갔다가 끝나지 않는다 — 끝나는 런에는 런 신호를 보내지 않는다
    await roundTrip(socket);
    expect(states).toEqual(["aborted"]);
    // 런을 먼저 종료로 박으면 이 이벤트가 드롭된다(applyRunEvent 의 terminal 가드) — 전이 전에 닫아야 한다
    const types = eventTypes(run.id);
    expect(types).toContain("APPROVAL_RESOLVED");
    expect(types.indexOf("APPROVAL_RESOLVED")).toBeLessThan(types.indexOf("RUN_ABORTED"));
    expect(listRunEvents(app.db, run.id, 0).find((e) => e.type === "APPROVAL_RESOLVED")).toMatchObject({
      decision: "deny",
      reason: "run-aborted",
    });
  });

  it("해결 시각이 없는 해결 이벤트는 받은 시각을 decidedAt 으로 적는다", async () => {
    const socket = await connect();
    const a = providerApproval(sessionKeyOf("dev", channel.id));
    const requested = waitFor(socket, "approval.requested");
    adapter.emitApproval(a);
    await requested;

    const resolved = waitFor(socket, "approval.resolved");
    adapter.emitApproval({ ...a, status: "denied", decision: "deny", reason: "user", resolvedAt: undefined });

    // 계약상 decidedAt 은 선택이라 비워도 파싱은 통과한다 — 그래서 값이 있는지를 직접 잰다
    expect((await resolved).approval.decidedAt).toEqual(expect.any(String));
  });

  it("다른 워크스페이스 채널의 승인은 받아 적지 않는다", async () => {
    const socket = await connect();
    const warn = vi.spyOn(app.logger, "warn");
    const other = seedChannelWithAgent(app.db, { channelName: "other-ws-ingest" });
    const foreign = providerApproval(sessionKeyOf("dev", other.channelId));

    adapter.emitApproval(foreign);

    await roundTrip(socket);
    expect(stored(foreign)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith({ sessionKey: foreign.sessionKey }, "approval for unknown session");
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

    expect(first.created).toBe(true); // 처음 본 승인 — 타임라인 카드는 여기서만 나간다
    expect(approvalStore.upsertApproval(db, a)).toEqual({
      approval: first.approval,
      changed: false,
      created: false,
      filled: false,
    });

    const changed = approvalStore.upsertApproval(db, { ...a, title: "다른 제목" });
    expect(changed).toMatchObject({ changed: true, created: false });
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

    expect(resolved).toMatchObject({ changed: true, created: false });
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

    expect(approvalStore.upsertApproval(db, a)).toEqual({
      approval: denied.approval,
      changed: false,
      created: false,
      filled: false,
    });
    expect(approvalStore.upsertApproval(db, { ...a, status: "expired", reason: "timeout" })).toEqual({
      approval: denied.approval,
      changed: false,
      created: false,
      filled: false,
    });
  });

  it("종료된 행의 빈 decision·reason 은 같은 결말을 말하는 짝이 채운다 — 다른 결말은 못 채운다", () => {
    const { db, input } = setup();
    const a = input();
    approvalStore.upsertApproval(db, a);
    // 확정 짝의 앞엣것 — 실물 만료 세션 스냅샷에는 `decision` 이 없다(스파이크 5.2)
    const expired = approvalStore.upsertApproval(db, {
      ...a,
      status: "expired",
      reason: "timeout",
      decidedAt: new Date("2026-09-20T00:01:00.000Z"),
    });
    expect(expired).toMatchObject({ changed: true, filled: false });
    expect(expired.approval.decision).toBeUndefined();

    // 뒤엣것(`plugin.approval.resolved`)이 그 자리를 채운다 — 타임라인에 또 쌓지 않게 filled 로 알린다
    const late = approvalStore.upsertApproval(db, {
      ...a,
      status: "expired",
      decision: "deny",
      reason: "timeout",
    });
    expect(late).toMatchObject({ changed: true, created: false, filled: true });
    expect(late.approval).toMatchObject({ status: "expired", decision: "deny", reason: "timeout" });

    // 이미 찬 값은 덮지 않고, 다른 결말을 말하는 프레임은 아무것도 바꾸지 않는다
    expect(
      approvalStore.upsertApproval(db, { ...a, status: "expired", decision: "allow-once" }),
    ).toMatchObject({ changed: false, filled: false });
    expect(
      approvalStore.upsertApproval(db, { ...a, status: "allowed", decision: "allow-once", reason: "user" }),
    ).toMatchObject({ changed: false, filled: false });
    expect(approvalStore.getApproval(db, late.approval.id)).toMatchObject({
      status: "expired",
      decision: "deny",
      reason: "timeout",
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
    // 만료 시각은 아직 남았는데 이미 해결된 것 — 미해결 조회 둘에서 빠지는 것은 오직 status 조건 덕이다
    const decided = approvalStore.upsertApproval(db, {
      ...input({ runId: run.id }),
      status: "denied",
      decision: "deny",
      reason: "user",
      decidedAt: new Date("2026-09-20T00:00:40.000Z"),
    }).approval;
    const at = new Date("2026-09-20T00:01:00.000Z");

    expect(approvalStore.listPendingApprovals(db, channelId, at).map((p) => p.id)).toEqual([
      live.id,
      channelOnly.id,
    ]);
    expect(approvalStore.listRunApprovals(db, run.id).map((p) => p.id)).toEqual([
      live.id,
      dead.id,
      decided.id,
    ]);
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

  it("claimDecidedBy — 비어 있을 때만 채운다, 먼저 채운 사람을 나중 사람이 덮지 못한다", () => {
    const { db, input } = setup();
    const { approval } = approvalStore.upsertApproval(db, input());
    const first = uuid();
    const second = uuid();

    const claimed = approvalStore.claimDecidedBy(db, approval.id, first);
    expect(claimed?.decidedBy).toBe(first);

    const notOverwritten = approvalStore.claimDecidedBy(db, approval.id, second);
    expect(notOverwritten?.decidedBy).toBe(first); // 나중 사람은 이미 찬 값을 덮지 못한다
    expect(approvalStore.getApproval(db, approval.id)?.decidedBy).toBe(first);
  });

  it("claimDecidedBy — 없는 승인이면 undefined", () => {
    const { db } = setup();
    expect(approvalStore.claimDecidedBy(db, uuid(), uuid())).toBeUndefined();
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

/**
 * 타이머만 재는 자리 — 앱을 띄우지 않고(실소켓이 가짜 시계와 섞이지 않게) `createServices` 로 같은 배선을 만든다.
 * 대기 중에는 Gateway 가 아무 신호도 보내지 않으므로(스파이크 6.3) 여기서 재는 것이 유일한 상한이다.
 */
describe("승인 대기 중 런 시계 (가짜 타이머, 메모리 DB)", () => {
  const RUN_MS = 5_000;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(timeouts: Partial<RunTimeouts> = {}) {
    const db = newTestDb();
    const bus = new ServerBus();
    const adapter = new FakeAdapter();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ids = seedChannelWithAgent(db);
    const services = createServices({
      db,
      bus,
      logger: logger as unknown as Logger,
      registry: createAdapterRegistry([adapter]),
      workspaceId: ids.workspaceId,
      timeouts: { runMs: RUN_MS, ...timeouts },
    });
    const sessionKey = adapter.sessionKeyFor("dev", ids.channelId);
    const runOf = (runId: string) => {
      const run = getRun(db, runId);
      if (!run) throw new Error(`run ${runId} missing`);
      return run;
    };

    /** 멘션 런 하나를 띄워 툴을 연 뒤(= tool), 승인 하나를 요구해 awaiting_approval 로 만든다 */
    async function awaitingApproval(patch: Partial<ProviderApproval> = {}) {
      const message = createUserMessage(db, bus, {
        channelId: ids.channelId,
        authorId: ids.userId,
        bodyMd: "@dev 파일 써줘",
        clientMsgId: `c-${++seq}`,
      });
      const run = await services.orchestrator.enqueueRun(
        {
          agentId: ids.agentId,
          channelId: ids.channelId,
          triggerKind: "mention",
          rootMessageId: message.id,
          relayDepth: 0,
        },
        { message },
      );
      await vi.advanceTimersByTimeAsync(0); // adapter.send ack
      adapter.emit({ kind: "run_signal", runId: run.id, signal: { kind: "tool_start" } });
      expect(runOf(run.id).status).toBe("tool");
      const a = providerApproval(sessionKey, patch);
      adapter.emitApproval(a);
      expect(runOf(run.id).status).toBe("awaiting_approval");
      return { run, a };
    }

    return { db, adapter, services, logger, sessionKey, runOf, awaitingApproval, ...ids };
  }

  it("승인 대기 동안에는 런 무응답 타임아웃이 돌지 않는다", async () => {
    const t = setup();
    const { run } = await t.awaitingApproval(); // TTL 2분 — 감시 타이머는 아직 멀다

    await vi.advanceTimersByTimeAsync(RUN_MS + 1_000);

    expect(t.runOf(run.id).status).toBe("awaiting_approval"); // error 가 아니다
    t.services.orchestrator.stop();
  });

  it("아무 해결도 오지 않으면 만료 시각 + 5초에 승인을 닫고 런 시계를 다시 켠다", async () => {
    const t = setup();
    const { run, a } = await t.awaitingApproval({
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    });

    await vi.advanceTimersByTimeAsync(20_000 + 4_000);
    expect(approvalStore.getApprovalByProviderId(t.db, a.providerApprovalId)?.status).toBe("pending");

    await vi.advanceTimersByTimeAsync(1_100); // 만료 + 5초
    const expired = approvalStore.getApprovalByProviderId(t.db, a.providerApprovalId);
    // ⚠ 실측(p2-t6 B) — 같은 만료를 Gateway 경로는 `deny`+`timeout` 으로 준다. 감시 경로도 같은 모양으로 적는다
    expect(expired).toMatchObject({ status: "expired", decision: "deny", reason: "timeout" });
    // 승인 대기에서 나왔으니 다시 툴을 기다린다 — 그리고 런 시계가 다시 돈다
    expect(t.runOf(run.id).status).toBe("tool");
    expect(listRunEvents(t.db, run.id, 0).find((e) => e.type === "APPROVAL_RESOLVED")).toMatchObject({
      decision: "deny",
      reason: "timeout",
    });

    await vi.advanceTimersByTimeAsync(RUN_MS + 1_000);
    expect(t.runOf(run.id)).toMatchObject({ status: "error", error: { code: "TIMEOUT" } });
    t.services.orchestrator.stop();
  });

  it("만료 시각이 이미 지난 pending 행도 감시 타이머가 닫는다", async () => {
    const t = setup();
    const { run, a } = await t.awaitingApproval({
      expiresAt: new Date(Date.now() - MINUTE).toISOString(),
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(approvalStore.getApprovalByProviderId(t.db, a.providerApprovalId)).toMatchObject({
      status: "expired",
      reason: "timeout",
    });
    expect(t.runOf(run.id).status).toBe("tool");
    t.services.orchestrator.stop();
  });

  it("사용자가 제때 허용하면 감시 타이머는 울리지 않고 런 시계가 다시 돈다", async () => {
    const t = setup();
    const { run, a } = await t.awaitingApproval({
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    });
    const approval = approvalStore.getApprovalByProviderId(t.db, a.providerApprovalId);

    await t.services.runs.resolveApproval({
      approvalId: approval?.id ?? "",
      decision: "allow-once",
      userId: t.userId,
    });

    expect(approvalStore.getApprovalByProviderId(t.db, a.providerApprovalId)).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      decidedBy: t.userId,
    });
    expect(t.runOf(run.id).status).toBe("tool");

    // 감시 타이머가 살아 있었다면 여기서 만료로 덮어썼을 것이다
    await vi.advanceTimersByTimeAsync(25_100);
    expect(approvalStore.getApprovalByProviderId(t.db, a.providerApprovalId)?.status).toBe("allowed");
    expect(t.runOf(run.id)).toMatchObject({ status: "error", error: { code: "TIMEOUT" } }); // 런 시계는 다시 돌았다
    t.services.orchestrator.stop();
  });

  /** 한 런에 승인이 둘 — 감시 타이머는 가장 이른 만료 시각에 한 번 울린다(p2-t5 리뷰 B-1 ①) */
  async function twoApprovals(t: ReturnType<typeof setup>) {
    const { run, a } = await t.awaitingApproval({
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    });
    // 대기 중에 두 번째 승인이 왔다 — 수명이 세 배다. 첫 승인의 감시 타이머가 이것까지 닫아서는 안 된다
    const long = providerApproval(t.sessionKey, {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    t.adapter.emitApproval(long);
    expect(approvalStore.getApprovalByProviderId(t.db, long.providerApprovalId)?.status).toBe("pending");
    return { run, a, long };
  }

  it("감시 타이머가 울려도 아직 만료되지 않은 승인은 pending 으로 남고 그대로 해결할 수 있다", async () => {
    const t = setup({ runMs: 300_000 });
    const { run, a, long } = await twoApprovals(t);

    await vi.advanceTimersByTimeAsync(25_100); // 첫 승인의 만료 + 5초

    expect(approvalStore.getApprovalByProviderId(t.db, a.providerApprovalId)).toMatchObject({
      status: "expired",
      reason: "timeout",
    });
    // 두 번째는 Gateway 가 여전히 기다리고 있다 — 카드가 살아 있어야 하고 눌리면 Gateway 로 나가야 한다
    const alive = approvalStore.getApprovalByProviderId(t.db, long.providerApprovalId);
    expect(alive?.status).toBe("pending");
    await t.services.runs.resolveApproval({
      approvalId: alive?.id ?? "",
      decision: "allow-once",
      userId: t.userId,
    });
    expect(approvalStore.getApprovalByProviderId(t.db, long.providerApprovalId)).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      decidedBy: t.userId,
    });
    expect(t.adapter.calls.resolveApproval.at(-1)).toEqual({
      providerApprovalId: long.providerApprovalId,
      kind: "plugin",
      decision: "allow-once",
    });

    // 다시 건 감시 타이머가 이미 해결된 승인을 덮어쓰지 않는다
    await vi.advanceTimersByTimeAsync(40_000);
    expect(approvalStore.getApprovalByProviderId(t.db, long.providerApprovalId)?.status).toBe("allowed");
    expect(t.runOf(run.id).status).toBe("tool");
    t.services.orchestrator.stop();
  });

  it("남은 승인은 그 만료 시각으로 다시 감시한다 — 첫 승인이 대기에서 나가며 슬롯을 지워도", async () => {
    const t = setup({ runMs: 300_000 });
    const { run, a, long } = await twoApprovals(t);

    await vi.advanceTimersByTimeAsync(25_100);
    expect(approvalStore.getApprovalByProviderId(t.db, a.providerApprovalId)?.status).toBe("expired");
    expect(approvalStore.getApprovalByProviderId(t.db, long.providerApprovalId)?.status).toBe("pending");

    await vi.advanceTimersByTimeAsync(40_000); // 두 번째 승인의 만료 + 5초 = 65초

    expect(approvalStore.getApprovalByProviderId(t.db, long.providerApprovalId)).toMatchObject({
      status: "expired",
      reason: "timeout",
    });
    expect(listRunEvents(t.db, run.id, 0).filter((e) => e.type === "APPROVAL_RESOLVED")).toMatchObject([
      { decision: "deny", reason: "timeout" },
      { decision: "deny", reason: "timeout" },
    ]);
    // 런 시계는 첫 승인이 풀릴 때 다시 켜졌고 계속 돈다
    expect(t.runOf(run.id).status).toBe("tool");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(t.runOf(run.id)).toMatchObject({ status: "error", error: { code: "TIMEOUT" } });
    t.services.orchestrator.stop();
  });

  it("승인 하나를 해결해도 같은 런의 살아 있는 다른 승인이 만료로 휩쓸리지 않는다", async () => {
    const t = setup({ runMs: 600_000 });
    const { run, a } = await t.awaitingApproval({
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    });
    // 대기 중에 두 번째 승인이 왔다 — 수명이 훨씬 길다(첫 승인의 감시 타이머가 닫아서는 안 된다)
    const long = providerApproval(t.sessionKey, {
      expiresAt: new Date(Date.now() + 5 * MINUTE).toISOString(),
    });
    t.adapter.emitApproval(long);

    await t.services.runs.resolveApproval({
      approvalId: approvalStore.getApprovalByProviderId(t.db, a.providerApprovalId)?.id ?? "",
      decision: "allow-once",
      userId: t.userId,
    });
    expect(t.runOf(run.id).status).toBe("tool");

    await vi.advanceTimersByTimeAsync(26_000);

    expect(approvalStore.getApprovalByProviderId(t.db, long.providerApprovalId)?.status).toBe("pending");
    t.services.orchestrator.stop();
  });
});

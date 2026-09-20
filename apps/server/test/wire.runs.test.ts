import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { type Agent, Run, RunEventsReplayResult, type RunState } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { createAgent } from "../src/modules/agents/service";
import { addMember, type ChannelRecord, createChannel } from "../src/modules/channels/service";
import { createAgentMessage } from "../src/modules/messages/service";
import { getRun, insertRun } from "../src/modules/runs/store";
import { bootTestApp, login } from "./helpers/app";
import { seedWorkspace } from "./helpers/seed";
import { connectWire, type WireClient, waitFor } from "./helpers/wire";

describe("wire 런 핸들러·REST 런 조회 (앱 부팅, FakeAdapter 배선)", () => {
  let app: App;
  let adapter: FakeAdapter;
  let token: string;
  let headers: { authorization: string };
  let channel: ChannelRecord;
  let dev: Agent;
  const sockets: WireClient[] = [];
  let n = 0;

  beforeAll(async () => {
    adapter = new FakeAdapter();
    app = await bootTestApp({}, { adapter });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    ({ token, headers } = await login(app));
    channel = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: "runs",
    });
    dev = createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
    });
    addMember(app.db, channel.id, { memberType: "agent", memberId: dev.id }, app.logger);
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });
  afterAll(async () => {
    await app.close();
  });

  const connect = async () => {
    const socket = await connectWire(app, token);
    sockets.push(socket);
    const res = await socket.emitWithAck("channel.subscribe", { channelId: channel.id });
    if (!res.ok) throw new Error(res.error.code);
    return socket;
  };

  /** @dev 멘션 → 라우터 → 오케스트레이터 → send 까지 확인하고 그 런을 돌려준다 */
  async function mentionDev(socket: WireClient): Promise<RunState> {
    const queued = waitFor(socket, "run.state", (p) => p.run.status === "queued" && p.run.agentId === dev.id);
    const sent = await socket.emitWithAck("message.send", {
      channelId: channel.id,
      clientMsgId: `m-${++n}`,
      bodyMd: "@dev 부탁",
    });
    if (!sent.ok) throw new Error(sent.error.code);
    const { run } = await queued;
    await vi.waitFor(() => expect(getRun(app.db, run.id)?.providerRunId).toBe(run.id));
    expect(adapter.calls.send.find((s) => s.runId === run.id)).toMatchObject({
      kind: "message",
      agentId: "dev",
      message: { id: sent.data.message.id },
    });
    return run;
  }

  it("run.abort — ack null, adapter.calls.abort 에 남고 run.state aborted 팬아웃", async () => {
    const socket = await connect();
    const run = await mentionDev(socket);
    const aborted = waitFor(socket, "run.state", (p) => p.run.id === run.id && p.run.status === "aborted");

    expect(await socket.emitWithAck("run.abort", { runId: run.id })).toEqual({ ok: true, data: null });
    expect(adapter.calls.abort).toContainEqual({
      runId: run.id,
      sessionKey: `agent:dev:dodok:channel:${channel.id}`,
    });
    await aborted;
    expect(getRun(app.db, run.id)?.status).toBe("aborted");

    expect(await socket.emitWithAck("run.abort", { runId: uuid() })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("run.events.replay { afterSeq } — RUN_QUEUED 부터, afterSeq 뒤의 이벤트만, run 은 RunState", async () => {
    const socket = await connect();
    const run = await mentionDev(socket);
    try {
      const all = await socket.emitWithAck("run.events.replay", { runId: run.id, afterSeq: 0 });
      if (!all.ok) throw new Error(all.error.code);
      const replay = RunEventsReplayResult.parse(all.data);
      expect(replay.events[0]).toMatchObject({ type: "RUN_QUEUED", seq: 1, runId: run.id, position: 0 });
      expect(replay.run).toMatchObject({
        id: run.id,
        channelId: channel.id,
        agentId: dev.id,
        status: "queued",
      });
      expect(all.data.run).not.toHaveProperty("sessionKey");

      // 기본 afterSeq 0 과 같다
      expect(await socket.emitWithAck("run.events.replay", { runId: run.id } as never)).toEqual(all);

      adapter.emit({ kind: "run_signal", runId: run.id, signal: { kind: "gateway_started" } });
      await vi.waitFor(() => expect(getRun(app.db, run.id)?.status).toBe("streaming"));
      const after = await socket.emitWithAck("run.events.replay", { runId: run.id, afterSeq: 1 });
      if (!after.ok) throw new Error(after.error.code);
      expect(after.data.events.length).toBeGreaterThan(0);
      expect(after.data.events.every((e) => e.seq > 1)).toBe(true);
      expect(after.data.events.map((e) => e.type)).toContain("RUN_STARTED");
      expect(after.data.run.status).toBe("streaming");

      expect(await socket.emitWithAck("run.events.replay", { runId: uuid(), afterSeq: 0 })).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
    } finally {
      await socket.emitWithAck("run.abort", { runId: run.id });
    }
  });

  it("component.interact — ack { interactionId }, message.updated 팬아웃, interaction 런 send, 재클릭 CONSUMED", async () => {
    const socket = await connect();
    const source = insertRun(app.db, {
      channelId: channel.id,
      agentId: dev.id,
      triggerKind: "mention",
      rootMessageId: uuid(),
      relayDepth: 0,
      sessionKey: `agent:dev:dodok:channel:${channel.id}`,
      createdAt: new Date(),
    });
    const card = createAgentMessage(app.db, app.bus, {
      channelId: channel.id,
      agentId: dev.id,
      runId: source.id,
      externalId: `card-${++n}`,
      bodyMd: "진행할까요?",
      components: { blocks: [{ type: "actions", items: [{ type: "button", id: "go", label: "진행" }] }] },
    });
    const componentId = card.components?.id ?? "";
    const updated = waitFor(socket, "message.updated", (p) => p.message.id === card.id);

    const res = await socket.emitWithAck("component.interact", {
      messageId: card.id,
      componentId,
      itemId: "go",
      values: {},
    });
    expect(res).toEqual({ ok: true, data: { interactionId: expect.any(String) } });
    expect((await updated).message.componentState?.consumed).toEqual(["go"]);

    await vi.waitFor(() =>
      expect(
        adapter.calls.send.find((s) => s.kind === "interaction" && s.message.id === card.id),
      ).toBeDefined(),
    );
    const delivery = adapter.calls.send.find((s) => s.kind === "interaction" && s.message.id === card.id);
    expect(delivery).toMatchObject({ agentId: "dev", message: { author: { type: "user" } } });
    expect(delivery?.message.text).toContain(`component=${componentId} item=go`);
    const interactionRun = getRun(app.db, delivery?.runId ?? "");
    expect(interactionRun).toMatchObject({
      triggerKind: "interaction",
      rootMessageId: card.id,
      relayDepth: 0,
    });

    expect(
      await socket.emitWithAck("component.interact", {
        messageId: card.id,
        componentId,
        itemId: "go",
        values: {},
      }),
    ).toMatchObject({ ok: false, error: { code: "CONSUMED" } });
    expect(
      await socket.emitWithAck("component.interact", {
        messageId: uuid(),
        componentId,
        itemId: "go",
        values: {},
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    await socket.emitWithAck("run.abort", { runId: interactionRun?.id ?? "" });
  });

  it("approval.resolve 는 없는 승인에 NOT_FOUND, channel.subscribe 는 진행 중 런을 싣는다", async () => {
    const socket = await connect();
    // 실제 승인 서비스로 배선돼 있다 — 없는 승인은 Gateway 로 나가기 전에 막힌다(설계 4.4)
    expect(
      await socket.emitWithAck("approval.resolve", { approvalId: uuid(), decision: "allow-once" }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(adapter.calls.resolveApproval).toEqual([]);

    const run = await mentionDev(socket);
    try {
      const res = await socket.emitWithAck("channel.subscribe", { channelId: channel.id });
      if (!res.ok) throw new Error(res.error.code);
      expect(res.data.activeRuns.map((r) => r.id)).toContain(run.id);
    } finally {
      await socket.emitWithAck("run.abort", { runId: run.id });
    }
  });

  it("REST GET /channels/:id/runs · /runs/:id · /runs/:id/events — 최근 순·limit·afterSeq·워크스페이스 경계", async () => {
    const api = (url: string, auth = true) =>
      app.fastify.inject({ method: "GET", url: `/api/v1${url}`, headers: auth ? headers : {} });

    const listed = await api(`/channels/${channel.id}/runs`);
    expect(listed.statusCode).toBe(200);
    const { runs } = listed.json() as { runs: Run[] };
    expect(runs.length).toBeGreaterThanOrEqual(3);
    for (const run of runs) Run.parse(run);
    const times = runs.map((r) => `${r.createdAt}|${r.id}`);
    expect(times).toEqual([...times].sort().reverse());

    const one = await api(`/channels/${channel.id}/runs?limit=1`);
    expect(one.json().runs).toEqual([runs[0]]);
    expect((await api(`/channels/${channel.id}/runs?limit=201`)).statusCode).toBe(400);
    expect((await api(`/channels/${channel.id}/runs?limit=0`)).statusCode).toBe(400);

    const target = runs[runs.length - 1] as Run;
    const detail = await api(`/runs/${target.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual({ run: target });

    const events = await api(`/runs/${target.id}/events?afterSeq=1`);
    expect(events.statusCode).toBe(200);
    const body = events.json() as { events: { seq: number }[]; run: Run };
    expect(body.run).toEqual(target);
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.seq > 1)).toBe(true);
    const allEvents = (await api(`/runs/${target.id}/events`)).json() as { events: { seq: number }[] };
    expect(allEvents.events[0]?.seq).toBe(1);
    expect((await api(`/runs/${target.id}/events?afterSeq=-1`)).statusCode).toBe(400);

    expect((await api(`/runs/${uuid()}`)).statusCode).toBe(404);
    expect((await api(`/runs/${uuid()}/events`)).statusCode).toBe(404);
    expect((await api(`/channels/${uuid()}/runs`)).statusCode).toBe(404);
    expect((await api(`/runs/not-a-uuid`)).statusCode).toBe(400);
    expect((await api(`/runs/${target.id}`, false)).statusCode).toBe(401);

    const other = seedWorkspace(app.db, { userHandle: "stranger" });
    const otherChannel = createChannel(app.db, {
      workspaceId: other.workspaceId,
      createdBy: other.userId,
      name: "x",
    });
    const otherAgent = createAgent(app.db, {
      workspaceId: other.workspaceId,
      providerAgentId: "ext",
      handle: "ext",
      name: "ext",
    });
    const otherRun = insertRun(app.db, {
      channelId: otherChannel.id,
      agentId: otherAgent.id,
      triggerKind: "mention",
      rootMessageId: uuid(),
      relayDepth: 0,
      sessionKey: "agent:ext:dodok:channel:x",
      createdAt: new Date(),
    });
    expect((await api(`/channels/${otherChannel.id}/runs`)).statusCode).toBe(404);
    expect((await api(`/runs/${otherRun.id}`)).statusCode).toBe(404);
    expect((await api(`/runs/${otherRun.id}/events`)).statusCode).toBe(404);

    const socket = await connect();
    expect(await socket.emitWithAck("run.abort", { runId: otherRun.id })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await socket.emitWithAck("run.events.replay", { runId: otherRun.id, afterSeq: 0 })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });
});

describe("app.close — 배선된 오케스트레이터", () => {
  it("close() 뒤에는 어댑터 이벤트를 받지 않는다(orchestrator.stop)", async () => {
    const adapter = new FakeAdapter();
    const app = await bootTestApp({}, { adapter });
    const channel = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: "c",
    });
    const agent = createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId: "dev",
      handle: "dev",
      name: "d",
    });
    const run = insertRun(app.db, {
      channelId: channel.id,
      agentId: agent.id,
      triggerKind: "mention",
      rootMessageId: uuid(),
      relayDepth: 0,
      sessionKey: `agent:dev:dodok:channel:${channel.id}`,
      createdAt: new Date(),
    });
    // 닫기 전에는 배선되어 있다 — 신호가 런에 반영된다
    adapter.emit({ kind: "run_signal", runId: run.id, signal: { kind: "gateway_started" } });
    await vi.waitFor(() => expect(getRun(app.db, run.id)?.status).toBe("streaming"));

    // close() 는 DB 도 닫는다 — 런 행 대신 오케스트레이터에 신호가 닿는지를 본다
    const signal = vi.spyOn(app.orchestrator, "signal");
    await app.close();
    adapter.emit({ kind: "run_signal", runId: run.id, signal: { kind: "abort_requested" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signal).not.toHaveBeenCalled();
    expect(app.db.$client.open).toBe(false);
  });
});

import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { type Agent, ComponentsV1, type Message, type RelayPolicy, type Run } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { Logger } from "../src/logger";
import { createAgent, updateAgent } from "../src/modules/agents/service";
import { addMember, createChannel, updateAgentMember } from "../src/modules/channels/service";
import { createAgentMessage, createUserMessage, listMessages } from "../src/modules/messages/service";
import { createRunGate } from "../src/modules/ops/budget";
import { patchOpsSettings } from "../src/modules/ops/settings";
import { computeRelayHash, type RunPlan } from "../src/modules/router/decide";
import { createRouter } from "../src/modules/router/service";
import type { EnqueueTrigger } from "../src/modules/runs/orchestrator";
import { getRun, insertRun, listOpenRuns } from "../src/modules/runs/store";
import { ServerBus } from "../src/realtime/bus";
import { createServices } from "../src/wiring";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

const CONTINUE_COMPONENTS = {
  blocks: [
    {
      type: "actions",
      items: [{ type: "button", id: "continue_relay", label: "이어가기", style: "primary" }],
    },
  ],
};

function setup(relayPolicy?: z.input<typeof RelayPolicy>) {
  const db = newTestDb();
  const bus = new ServerBus();
  const logger = { warn: vi.fn(), error: vi.fn() };
  const { workspaceId, userId } = seedWorkspace(db, { userHandle: "jang" });
  const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general", relayPolicy });
  const member = (handle: string): Agent => {
    const agent = createAgent(db, {
      workspaceId,
      providerAgentId: handle,
      handle,
      name: handle.toUpperCase(),
    });
    addMember(db, channel.id, { memberType: "agent", memberId: agent.id }, logger);
    return agent;
  };
  const dev = member("dev");
  const fin = member("fin");
  const ops = member("ops");
  const enqueue = vi.fn(
    async (plan: RunPlan & { channelId: string }, _trigger: EnqueueTrigger) =>
      ({ id: uuid(), ...plan }) as Run,
  );
  const router = createRouter({ db, bus, logger, enqueue });
  const created: Message[] = [];
  bus.on("message.created", (p) => created.push(p.message));

  let n = 0;
  const human = (bodyMd: string) =>
    createUserMessage(db, bus, { channelId: channel.id, authorId: userId, bodyMd, clientMsgId: `c${++n}` });
  const runOf = (
    agent: Agent,
    over: { relayDepth?: number; rootMessageId?: string; relayHash?: string } = {},
  ) =>
    insertRun(db, {
      channelId: channel.id,
      agentId: agent.id,
      triggerKind: "mention",
      rootMessageId: over.rootMessageId ?? uuid(),
      relayDepth: over.relayDepth ?? 0,
      relayHash: over.relayHash,
      sessionKey: `agent:${agent.providerAgentId}:dodok:channel:${channel.id}`,
      createdAt: new Date(),
    });
  const said = (agent: Agent, run: Run | undefined, bodyMd: string) =>
    createAgentMessage(db, bus, {
      channelId: channel.id,
      agentId: agent.id,
      runId: run?.id,
      externalId: `out-${++n}`,
      bodyMd,
    });
  const systemMessages = () => created.filter((m) => m.kind === "system");
  return {
    db,
    bus,
    logger,
    workspaceId,
    userId,
    channel,
    dev,
    fin,
    ops,
    enqueue,
    router,
    human,
    runOf,
    said,
    systemMessages,
  };
}

/** setup 의 enqueue 대역 앞에 실제 관문을 둔 라우터 */
function gatedRouter(t: ReturnType<typeof setup>) {
  const ops = { record: vi.fn(() => null) };
  const gate = createRunGate({ db: t.db, bus: t.bus, ops, workspaceId: t.workspaceId, enqueue: t.enqueue });
  return createRouter({ db: t.db, bus: t.bus, logger: t.logger, enqueue: gate.enqueue });
}

describe("router service", () => {
  it("사람 메시지 @dev → enqueue 1(mention, depth 0, rootMessageId = 그 메시지)", async () => {
    const t = setup();
    const message = t.human("@dev 안녕");
    await t.router.routeMessage(message);
    expect(t.enqueue).toHaveBeenCalledTimes(1);
    expect(t.enqueue).toHaveBeenCalledWith(
      {
        agentId: t.dev.id,
        channelId: t.channel.id,
        triggerKind: "mention",
        rootMessageId: message.id,
        relayDepth: 0,
      },
      { message },
    );
    expect(t.systemMessages()).toEqual([]);
  });

  it("사람 메시지의 대상은 순서대로 enqueue 하고, enabled=false 에이전트는 빠진다(시스템 메시지 없음)", async () => {
    const t = setup();
    updateAgent(t.db, t.fin.id, { enabled: false });
    const message = t.human("@fin @ops @dev 같이 봐줘");
    await t.router.routeMessage(message);
    expect(t.enqueue.mock.calls.map(([plan]) => plan.agentId)).toEqual([t.ops.id, t.dev.id]);
    expect(t.systemMessages()).toEqual([]);
  });

  it("에이전트(dev) 메시지 @fin → enqueue(relay, depth 1, rootMessageId 유지, relayHash)", async () => {
    const t = setup();
    const root = uuid();
    const run = t.runOf(t.dev, { relayDepth: 0, rootMessageId: root });
    const message = t.said(t.dev, run, "@fin 이거 계산해줘");
    await t.router.routeMessage(message);
    expect(t.enqueue).toHaveBeenCalledTimes(1);
    expect(t.enqueue).toHaveBeenCalledWith(
      {
        agentId: t.fin.id,
        channelId: t.channel.id,
        triggerKind: "relay",
        rootMessageId: root,
        relayDepth: 1,
        relayHash: computeRelayHash(t.dev.id, t.fin.id, message.bodyMd),
      },
      { message },
    );
  });

  it("depth 초과 → relay_limit 시스템 메시지 + continue_relay 버튼 + systemMeta.relay", async () => {
    const t = setup({ maxRelayTurns: 2 });
    const root = uuid();
    const run = t.runOf(t.dev, { relayDepth: 2, rootMessageId: root });
    await t.router.routeMessage(t.said(t.dev, run, "@fin 계속"));

    expect(t.enqueue).not.toHaveBeenCalled();
    const [system, ...rest] = t.systemMessages();
    expect(rest).toEqual([]);
    expect(system).toMatchObject({
      channelId: t.channel.id,
      kind: "system",
      authorType: "system",
      bodyMd: "릴레이 한도(2턴)에 도달했습니다. 계속하려면 사람이 멘션하거나 이어가기를 누르세요.",
      systemMeta: {
        kind: "relay_limit",
        relay: { fromAgentId: t.dev.id, toAgentId: t.fin.id, sourceRunId: run.id, rootMessageId: root },
      },
      componentState: { consumed: [] },
    });
    const parsed = ComponentsV1.parse(CONTINUE_COMPONENTS);
    expect(system?.components).toEqual({ ...parsed, id: expect.stringMatching(/^cmp_/) });
    expect(system?.components?.reusable).toBe(false);
  });

  it("같은 본문 반복(repeat) → relay_limit(계약 5.2 규칙 3) + 이어가기 버튼", async () => {
    const t = setup();
    const root = uuid();
    const body = "@fin 다시 확인";
    const first = t.runOf(t.dev, { rootMessageId: root });
    const probe = t.said(t.dev, first, body);
    t.runOf(t.fin, { rootMessageId: root, relayHash: computeRelayHash(t.dev.id, t.fin.id, probe.bodyMd) });

    const again = t.runOf(t.dev, { rootMessageId: root, relayDepth: 1 });
    await t.router.routeMessage(t.said(t.dev, again, body));

    expect(t.enqueue).not.toHaveBeenCalled();
    expect(t.systemMessages()).toEqual([
      expect.objectContaining({
        bodyMd: "같은 내용의 릴레이가 반복되어 멈췄습니다. 계속하려면 사람이 멘션하거나 이어가기를 누르세요.",
        systemMeta: {
          kind: "relay_limit",
          relay: { fromAgentId: t.dev.id, toAgentId: t.fin.id, sourceRunId: again.id, rootMessageId: root },
        },
        components: expect.objectContaining({ blocks: ComponentsV1.parse(CONTINUE_COMPONENTS).blocks }),
      }),
    ]);
  });

  it("allowPairs 제한 → relay_denied(버튼 없음), 같은 사유의 여러 대상은 한 메시지에 핸들을 나열", async () => {
    const t = setup({ allowPairs: [{ from: uuid(), to: uuid() }] });
    const root = uuid();
    const run = t.runOf(t.dev, { rootMessageId: root });
    await t.router.routeMessage(t.said(t.dev, run, "@fin @ops 둘 다 봐줘"));

    expect(t.enqueue).not.toHaveBeenCalled();
    const systems = t.systemMessages();
    expect(systems).toHaveLength(1);
    expect(systems[0]).toMatchObject({
      bodyMd: "@dev 는 @fin, @ops 를 부를 수 없습니다(허용 목록 밖)",
      systemMeta: {
        kind: "relay_denied",
        relay: { fromAgentId: t.dev.id, toAgentId: t.fin.id, sourceRunId: run.id, rootMessageId: root },
      },
    });
    expect(systems[0]?.components).toBeUndefined();
    expect(systems[0]?.componentState).toBeUndefined();
  });

  it("에이전트 메시지의 비활성 대상 → relay_denied(disabled), 사유가 다르면 메시지도 따로, 통과한 대상은 enqueue", async () => {
    const t = setup();
    updateAgent(t.db, t.fin.id, { enabled: false });
    const run = t.runOf(t.dev);
    await t.router.routeMessage(t.said(t.dev, run, "@fin @ops 부탁"));
    expect(t.enqueue.mock.calls.map(([plan]) => plan.agentId)).toEqual([t.ops.id]);
    expect(t.systemMessages()).toEqual([
      expect.objectContaining({
        bodyMd: "@fin 은 비활성 상태입니다",
        systemMeta: expect.objectContaining({
          kind: "relay_denied",
          relay: expect.objectContaining({ toAgentId: t.fin.id }),
        }),
      }),
    ]);
  });

  it("사유가 다른 차단은 사유마다 시스템 메시지 하나씩(차단 순서대로)", async () => {
    const t = setup({ maxRelayTurns: 1 });
    updateAgent(t.db, t.fin.id, { enabled: false });
    const run = t.runOf(t.dev, { relayDepth: 1 });
    await t.router.routeMessage(t.said(t.dev, run, "@fin @ops 부탁"));
    expect(t.enqueue).not.toHaveBeenCalled();
    expect(t.systemMessages().map((m) => [m.systemMeta?.kind, m.systemMeta?.relay?.toAgentId])).toEqual([
      ["relay_denied", t.fin.id],
      ["relay_limit", t.ops.id],
    ]);
  });

  it("릴레이가 채널 한도에 막히면 관문의 run_limit 한 줄 — relay_denied 는 없다", async () => {
    const t = setup({ dailyRunLimit: 1 });
    const router = gatedRouter(t);
    const run = t.runOf(t.dev); // 오늘 런 1개
    await router.routeMessage(t.said(t.dev, run, "@fin 하나 더"));
    expect(t.enqueue).not.toHaveBeenCalled();
    expect(t.systemMessages().map((m) => [m.bodyMd, m.systemMeta])).toEqual([
      [
        "이 채널의 오늘 런 한도(1)에 도달했습니다 — 내일 0시에 풀립니다",
        { kind: "run_limit", limit: { scope: "channel", limit: 1 } },
      ],
    ]);
  });

  it("사람 멘션·자동 응답이 워크스페이스 한도에 막히면 런 0 · 메시지는 저장 · 시스템 메시지 1", async () => {
    const t = setup();
    patchOpsSettings(t.db, t.workspaceId, { dailyRunLimit: 1 });
    updateAgentMember(t.db, t.channel.id, t.fin.id, { autoRespond: true }, t.logger);
    const router = gatedRouter(t);
    t.runOf(t.dev); // 오늘 런 1개

    const mention = t.human("@dev 안녕");
    await router.routeMessage(mention);
    const plain = t.human("아무나");
    await router.routeMessage(plain);

    expect(t.enqueue).not.toHaveBeenCalled();
    expect(listMessages(t.db, t.channel.id, { limit: 50 }).messages.map((m) => m.id)).toEqual(
      expect.arrayContaining([mention.id, plain.id]),
    );
    expect(t.systemMessages().map((m) => m.bodyMd)).toEqual([
      "오늘 런 한도(1)에 도달했습니다 — 내일 0시에 풀립니다",
    ]);
  });

  it("시스템 메시지는 무시, 런이 없는 에이전트 메시지는 릴레이하지 않고 warn", async () => {
    const t = setup();
    await t.router.routeMessage({ ...t.human("@dev 무시"), kind: "system", authorType: "system" });
    expect(t.enqueue).not.toHaveBeenCalled();

    const runless = t.said(t.dev, undefined, "@fin 런 없음");
    await t.router.routeMessage(runless);
    const missing = { ...t.said(t.dev, undefined, "@fin 없는 런"), runId: uuid() };
    await t.router.routeMessage(missing);

    expect(t.enqueue).not.toHaveBeenCalled();
    expect(t.systemMessages()).toEqual([]);
    expect(t.logger.warn).toHaveBeenCalledTimes(2);
    expect(t.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: runless.id }),
      expect.any(String),
    );
    expect(t.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: missing.id, runId: missing.runId }),
      expect.any(String),
    );
  });

  it("한 대상의 enqueue 가 실패해도 다음 대상은 enqueue 하고 오류는 로그", async () => {
    const t = setup();
    t.enqueue.mockRejectedValueOnce(new Error("boom"));
    const message = t.human("@dev @fin 둘 다");
    await t.router.routeMessage(message);
    expect(t.enqueue.mock.calls.map(([plan]) => plan.agentId)).toEqual([t.dev.id, t.fin.id]);
    expect(t.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: message.id, agentId: t.dev.id }),
      expect.any(String),
    );
  });
});

describe("router service — 스레드", () => {
  function threadSetup(relayPolicy?: z.input<typeof RelayPolicy>) {
    const t = setup(relayPolicy);
    let n = 0;
    const reply = (rootId: string, bodyMd: string) =>
      createUserMessage(t.db, t.bus, {
        channelId: t.channel.id,
        authorId: t.userId,
        bodyMd,
        clientMsgId: `t${++n}`,
        threadRootId: rootId,
      });
    const agentReply = (agent: Agent, run: Run, rootId: string, bodyMd: string) =>
      createAgentMessage(t.db, t.bus, {
        channelId: t.channel.id,
        agentId: agent.id,
        runId: run.id,
        externalId: `tr-${++n}`,
        bodyMd,
        threadRootId: rootId,
      });
    return { ...t, reply, agentReply };
  }

  it("스레드 답글 @dev → 그 스레드의 mention 런(임시 건너뛰기 없음)", async () => {
    const t = threadSetup();
    const root = t.human("루트");
    const message = t.reply(root.id, "@dev 봐줘");
    await t.router.routeMessage(message);
    expect(t.enqueue).toHaveBeenCalledWith(
      {
        agentId: t.dev.id,
        channelId: t.channel.id,
        triggerKind: "mention",
        rootMessageId: message.id,
        relayDepth: 0,
        threadRootId: root.id,
      },
      { message },
    );
    expect(t.logger.warn).not.toHaveBeenCalled();
  });

  it("멘션 없는 스레드 답글 — 루트가 에이전트 메시지면 그 에이전트", async () => {
    const t = threadSetup();
    updateAgentMember(t.db, t.channel.id, t.dev.id, { autoRespond: true }, t.logger);
    const root = t.said(t.fin, t.runOf(t.fin), "에이전트 루트");
    await t.router.routeMessage(t.reply(root.id, "이어서 질문"));
    expect(t.enqueue.mock.calls.map(([plan]) => [plan.agentId, plan.triggerKind, plan.threadRootId])).toEqual(
      [[t.fin.id, "auto_respond", root.id]],
    );
  });

  it("스레드 안 릴레이 차단(한도) 알림은 그 스레드에 남는다", async () => {
    const t = threadSetup({ maxRelayTurns: 1 });
    const root = t.human("루트");
    const run = { ...t.runOf(t.dev, { relayDepth: 1 }), threadRootId: root.id };
    await t.router.routeMessage(t.agentReply(t.dev, run, root.id, "@fin 부탁"));
    expect(t.enqueue).not.toHaveBeenCalled();
    expect(t.systemMessages().map((m) => [m.systemMeta?.kind, m.threadRootId])).toEqual([
      ["relay_limit", root.id],
    ]);
  });

  it("스레드 런이 한도에 막히면 run_limit 알림도 그 스레드에", async () => {
    const t = threadSetup({ dailyRunLimit: 1 });
    const router = gatedRouter(t);
    t.runOf(t.dev);
    const root = t.human("루트");
    await router.routeMessage(t.reply(root.id, "@dev 하나 더"));
    expect(t.enqueue).not.toHaveBeenCalled();
    expect(t.systemMessages().map((m) => [m.systemMeta?.kind, m.threadRootId])).toEqual([
      ["run_limit", root.id],
    ]);
  });
});

describe("createServices — 라우터·오케스트레이터 상호 참조", () => {
  function boot() {
    const t = setup();
    const adapter = new FakeAdapter();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };
    const services = createServices({
      db: t.db,
      bus: t.bus,
      logger: logger as unknown as Logger,
      adapter,
      workspaceId: t.workspaceId,
    });
    return { ...t, adapter, services };
  }

  it("사람 메시지 → 라우터 → 오케스트레이터 → adapter.send, 정본의 @멘션 → 릴레이 런 send", async () => {
    const t = boot();
    try {
      const message = t.human("@dev 시작");
      await t.services.router.routeMessage(message);
      expect(t.adapter.calls.send).toHaveLength(1);
      const first = t.adapter.calls.send[0];
      expect(first).toMatchObject({ kind: "message", agentId: "dev", channelId: t.channel.id });
      const devRun = getRun(t.db, first?.runId ?? "");
      expect(devRun).toMatchObject({ triggerKind: "mention", relayDepth: 0, rootMessageId: message.id });

      await t.services.orchestrator.onCanonical({
        outboundId: "out-dev-1",
        channelId: t.channel.id,
        agentId: "dev",
        sessionKey: devRun?.sessionKey ?? "",
        runId: devRun?.id,
        text: "@fin 이어서 부탁",
        attachmentIds: [],
        ts: new Date().toISOString(),
      });
      await vi.waitFor(() => expect(t.adapter.calls.send).toHaveLength(2));
      const relay = t.adapter.calls.send[1];
      expect(relay).toMatchObject({ kind: "message", agentId: "fin" });
      expect(getRun(t.db, relay?.runId ?? "")).toMatchObject({
        agentId: t.fin.id,
        triggerKind: "relay",
        relayDepth: 1,
        rootMessageId: message.id,
      });
      expect(t.services.runs.activeRuns(t.channel.id).map((r) => r.id)).toEqual(
        listOpenRuns(t.db).map((r) => r.id),
      );
    } finally {
      t.services.orchestrator.stop();
    }
  });
});

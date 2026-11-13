import type { Agent, Message, RelayPolicy, Run } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { Db } from "../src/db/client";
import { componentInteractions, conversations } from "../src/db/schema.sqlite";
import { createAgent, updateAgent } from "../src/modules/agents/service";
import { addMember, createChannel, removeMember, updateChannel } from "../src/modules/channels/service";
import { type InteractInput, interact } from "../src/modules/components/service";
import { deleteInvite, insertInvite } from "../src/modules/conversations/invited-agents";
import {
  createAgentMessage,
  createSystemMessage,
  createUserMessage,
  getMessage,
  listMessages,
  withInteractions,
} from "../src/modules/messages/service";
import type { RunPlan } from "../src/modules/router/decide";
import { createRunGate } from "../src/modules/ops/budget";
import { patchOpsSettings } from "../src/modules/ops/settings";
import { createRouter } from "../src/modules/router/service";
import type { EnqueueTrigger } from "../src/modules/runs/orchestrator";
import { insertRun, updateRun } from "../src/modules/runs/store";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { channelConversation, seedWorkspace } from "./helpers/seed";

type CardComponents = Parameters<typeof createAgentMessage>[2]["components"];

const PICKER: CardComponents = {
  blocks: [
    {
      type: "actions",
      id: "row1",
      items: [
        { type: "button", id: "go", label: "진행", style: "primary" },
        { type: "button", id: "boss_only", label: "승인", allowedUsers: [uuid()] },
      ],
    },
    {
      type: "actions",
      items: [
        {
          type: "select",
          id: "target",
          placeholder: "대상 선택",
          options: [
            { value: "web", label: "웹" },
            { value: "api", label: "API" },
          ],
        },
      ],
    },
  ],
};

/** component_interactions 를 읽는 질의 수를 센다 — 트랜잭션 안(tx)의 질의도 같은 연결의 prepare 를 거친다. 쓰기(insert into)는 세지 않는다 */
function countInteractionReads(db: Db): { count(): number; restore(): void } {
  const spy = vi.spyOn(db.$client, "prepare");
  return {
    count: () => spy.mock.calls.filter(([sql]) => /from "component_interactions"/.test(String(sql))).length,
    restore: () => spy.mockRestore(),
  };
}

function setup(relayPolicy?: z.input<typeof RelayPolicy>) {
  const db = newTestDb();
  const bus = new ServerBus();
  const logger = { warn: vi.fn(), error: vi.fn() };
  const { workspaceId, userId } = seedWorkspace(db, { userHandle: "jang" });
  const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general", relayPolicy });
  const member = (handle: string): Agent => {
    const agent = createAgent(db, { workspaceId, providerAgentId: handle, handle, name: handle });
    addMember(db, channel.id, { memberType: "agent", memberId: agent.id }, logger);
    return agent;
  };
  const dev = member("dev");
  const fin = member("fin");
  const enqueue = vi.fn(
    async (plan: RunPlan & { channelId: string }, _trigger: EnqueueTrigger) =>
      ({ id: uuid(), ...plan }) as Run,
  );
  let clock = new Date();
  const ops = { record: vi.fn(() => null) };
  // 실제 관문 — 한도 판정·run_limit 알림은 관문 몫이고, 그 뒤 런은 enqueue 대역으로 간다
  const gate = createRunGate({ db, bus, ops, workspaceId, enqueue, now: () => clock });
  const deps = { db, bus, workspaceId, gate, now: () => clock };
  const setNow = (d: Date) => {
    clock = d;
  };
  const updated: Message[] = [];
  bus.on("message.updated", (p) => updated.push(p.message));

  let n = 0;
  const runOf = (agent: Agent, relayDepth = 0) =>
    insertRun(db, {
      channelId: channel.id,
      conversationId: channelConversation(db, channel.id),
      agentId: agent.id,
      triggerKind: "mention",
      rootMessageId: uuid(),
      relayDepth,
      sessionKey: `agent:${agent.providerAgentId}:dodok:channel:${channelConversation(db, channel.id)}`,
      createdAt: new Date(),
    });
  const card = (agent: Agent, components: CardComponents = PICKER, run: Run | null = runOf(agent)) =>
    createAgentMessage(db, bus, {
      conversationId: channelConversation(db, channel.id),
      agentId: agent.id,
      runId: run?.id,
      externalId: `out-${++n}`,
      bodyMd: "골라 주세요",
      components,
    });
  const click = (message: Message, itemId: string, values: Record<string, unknown> = {}): InteractInput => ({
    userId,
    messageId: message.id,
    componentId: message.components?.id ?? "",
    itemId,
    values,
  });
  const interactionRows = () => db.select().from(componentInteractions).all();
  return {
    db,
    bus,
    logger,
    workspaceId,
    userId,
    channel,
    dev,
    fin,
    enqueue,
    ops,
    deps,
    setNow,
    updated,
    runOf,
    card,
    click,
    interactionRows,
  };
}

/** 오케스트레이터가 남기는 run_error 카드와 같은 모양 */
function retryNotice(t: ReturnType<typeof setup>, runId: string): Message {
  return createSystemMessage(t.db, t.bus, {
    conversationId: channelConversation(t.db, t.channel.id),
    kind: "run_error",
    bodyMd: "@dev 실행이 실패했습니다: TIMEOUT",
    systemMeta: { kind: "run_error", runId },
    components: {
      blocks: [{ type: "actions", items: [{ type: "button", id: "retry_run", label: "다시 실행" }] }],
    },
  });
}

/** error 로 끝난 런과 그 run_error 카드 — relay 면 트리거는 fromAgent 의 메시지다 */
function failedRun(
  t: ReturnType<typeof setup>,
  opts: { agent: Agent; triggerKind: "mention" | "relay"; relayDepth?: number; fromAgent?: Agent },
): { run: Run; notice: Message } {
  const trigger = opts.fromAgent
    ? createAgentMessage(t.db, t.bus, {
        conversationId: channelConversation(t.db, t.channel.id),
        agentId: opts.fromAgent.id,
        externalId: `out-trigger-${uuid()}`,
        bodyMd: `@${opts.agent.handle} 넘길게`,
      })
    : createUserMessage(t.db, t.bus, {
        conversationId: channelConversation(t.db, t.channel.id),
        authorId: t.userId,
        bodyMd: `@${opts.agent.handle} 해줘`,
        clientMsgId: `c-${uuid()}`,
      });
  const run = insertRun(t.db, {
    channelId: t.channel.id,
    conversationId: channelConversation(t.db, t.channel.id),
    agentId: opts.agent.id,
    triggerKind: opts.triggerKind,
    triggerMessageId: trigger.id,
    rootMessageId: uuid(),
    relayDepth: opts.relayDepth ?? 0,
    sessionKey: "k",
    createdAt: new Date(),
  });
  updateRun(t.db, run.id, { status: "error", error: { code: "TIMEOUT", message: "t" } });
  return { run, notice: retryNotice(t, run.id) };
}

describe("components service — interact", () => {
  it("이어가기 대상이 비활성이면 VALIDATION — 저장·소비·런 없음(대상을 되살리면 다시 누를 수 있다)", async () => {
    const t = setup({ maxRelayTurns: 1 });
    const created: Message[] = [];
    t.bus.on("message.created", (p) => created.push(p.message));
    const router = createRouter({ db: t.db, bus: t.bus, logger: t.logger, enqueue: t.enqueue });
    const source = t.runOf(t.dev, 1);
    await router.routeMessage(
      createAgentMessage(t.db, t.bus, {
        conversationId: channelConversation(t.db, t.channel.id),
        agentId: t.dev.id,
        runId: source.id,
        externalId: "out-relay",
        bodyMd: "@fin 계속",
      }),
    );
    const system = created.find((m) => m.systemMeta?.kind === "relay_limit");
    if (!system?.components?.id) throw new Error("relay_limit 시스템 메시지가 없다");

    updateAgent(t.db, t.fin.id, { enabled: false });
    await expect(interact(t.deps, t.click(system, "continue_relay"))).rejects.toMatchObject({
      body: { code: "VALIDATION" },
    });
    expect(t.enqueue).not.toHaveBeenCalled();
    expect(t.interactionRows()).toHaveLength(0);
    expect(t.updated).toHaveLength(0);
    expect(getMessage(t.db, system.id)?.componentState?.consumed ?? []).toEqual([]);

    updateAgent(t.db, t.fin.id, { enabled: true });
    await interact(t.deps, t.click(system, "continue_relay"));
    expect(t.enqueue).toHaveBeenCalledTimes(1);
  });

  it("카드 대상 에이전트가 채널에서 빠지면 VALIDATION — 저장·소비 없음", async () => {
    const t = setup();
    const message = t.card(t.dev);
    removeMember(t.db, t.channel.id, t.dev.id);
    await expect(interact(t.deps, t.click(message, "go"))).rejects.toMatchObject({
      body: { code: "VALIDATION" },
    });
    expect(t.enqueue).not.toHaveBeenCalled();
    expect(t.interactionRows()).toHaveLength(0);
    expect(t.updated).toHaveLength(0);
  });
  it("그 세션에 초대한 에이전트의 카드는 그 에이전트에게 간다 — 내보내면 VALIDATION [세션 에이전트 초대 스펙 5.2]", async () => {
    const t = setup();
    const guest = createAgent(t.db, {
      workspaceId: t.workspaceId,
      providerAgentId: "guest",
      handle: "guest",
      name: "guest",
    });
    const conversationId = channelConversation(t.db, t.channel.id);
    insertInvite(t.db, { conversationId, agentId: guest.id, invitedBy: t.userId });
    await interact(t.deps, t.click(t.card(guest), "go"));
    expect(t.enqueue.mock.calls[0]?.[0]).toMatchObject({ agentId: guest.id, triggerKind: "interaction" });
    const later = t.card(guest);
    deleteInvite(t.db, { conversationId, agentId: guest.id });
    await expect(interact(t.deps, t.click(later, "go"))).rejects.toMatchObject({
      body: { code: "VALIDATION" },
    });
    expect(t.enqueue).toHaveBeenCalledTimes(1);
  });

  it("허용 목록 채널에서 초대한 에이전트의 relay 런 retry 는 쌍 허용을 통과한다(I11)", async () => {
    const t = setup({ allowPairs: [{ from: uuid(), to: uuid() }] });
    const guest = createAgent(t.db, {
      workspaceId: t.workspaceId,
      providerAgentId: "guest",
      handle: "guest",
      name: "guest",
    });
    const conversationId = channelConversation(t.db, t.channel.id);
    insertInvite(t.db, { conversationId, agentId: guest.id, invitedBy: t.userId });
    const { run, notice } = failedRun(t, { agent: guest, triggerKind: "relay", fromAgent: t.dev });
    await interact(t.deps, t.click(notice, "retry_run"));
    expect(t.enqueue.mock.calls[0]?.[0]).toMatchObject({ agentId: guest.id, parentRunId: run.id });
  });

  it("continue_relay 클릭 → continue 런(relay.toAgentId, rootMessageId = 시스템 메시지, depth 0) + 소비 + message.updated", async () => {
    const t = setup({ maxRelayTurns: 1 });
    const created: Message[] = [];
    t.bus.on("message.created", (p) => created.push(p.message));
    const router = createRouter({ db: t.db, bus: t.bus, logger: t.logger, enqueue: t.enqueue });
    const source = t.runOf(t.dev, 1);
    await router.routeMessage(
      createAgentMessage(t.db, t.bus, {
        conversationId: channelConversation(t.db, t.channel.id),
        agentId: t.dev.id,
        runId: source.id,
        externalId: "out-relay",
        bodyMd: "@fin 계속",
      }),
    );
    const system = created.find((m) => m.systemMeta?.kind === "relay_limit");
    if (!system?.components?.id) throw new Error("relay_limit 시스템 메시지가 없다");
    expect(t.enqueue).not.toHaveBeenCalled();

    const { interactionId } = await interact(t.deps, t.click(system, "continue_relay"));

    const interactionText = `[dodok interaction] user=@jang kind=button component=${system.components.id} item=continue_relay\n@jang 님이 "이어가기" 버튼을 눌렀습니다.`;
    expect(t.enqueue).toHaveBeenCalledTimes(1);
    expect(t.enqueue).toHaveBeenCalledWith(
      {
        agentId: t.fin.id,
        channelId: t.channel.id,
        conversationId: channelConversation(t.db, t.channel.id),
        triggerKind: "continue",
        rootMessageId: system.id,
        relayDepth: 0,
      },
      { interactionId, interactionText, interactionMessageId: system.id },
    );
    expect(t.interactionRows()).toEqual([
      expect.objectContaining({
        id: interactionId,
        messageId: system.id,
        componentId: system.components.id,
        userId: t.userId,
        itemId: "continue_relay",
        blockId: null,
        values: {},
      }),
    ]);
    expect(t.updated).toHaveLength(1);
    expect(t.updated[0]).toMatchObject({ id: system.id, componentState: { consumed: ["continue_relay"] } });
    expect(getMessage(t.db, system.id)?.componentState?.consumed).toEqual(["continue_relay"]);

    // 1회용 — 두 번째 클릭은 CONSUMED, 저장·런·이벤트 없음
    await expect(interact(t.deps, t.click(system, "continue_relay"))).rejects.toMatchObject({
      body: { code: "CONSUMED" },
    });
    expect(t.enqueue).toHaveBeenCalledTimes(1);
    expect(t.interactionRows()).toHaveLength(1);
    expect(t.updated).toHaveLength(1);
  });

  it("에이전트 카드의 셀렉트 → interaction 런(대상 = 그 메시지 runId 의 에이전트), 값·blockId 저장", async () => {
    const t = setup();
    const message = t.card(t.fin);
    const { interactionId } = await interact(t.deps, t.click(message, "target", { values: ["api"] }));

    expect(t.enqueue).toHaveBeenCalledWith(
      {
        agentId: t.fin.id,
        channelId: t.channel.id,
        conversationId: channelConversation(t.db, t.channel.id),
        triggerKind: "interaction",
        rootMessageId: message.id,
        relayDepth: 0,
      },
      {
        interactionId,
        interactionText: `[dodok interaction] user=@jang kind=select component=${message.components?.id} item=target values=["api"]\n@jang 님이 "대상 선택"에서 API을 골랐습니다.`,
        interactionMessageId: message.id,
      },
    );
    expect(t.interactionRows()).toEqual([
      expect.objectContaining({
        id: interactionId,
        itemId: "target",
        values: { values: ["api"] },
        blockId: null,
      }),
    ]);

    const button = await interact(t.deps, t.click(t.card(t.dev), "go"));
    expect(t.interactionRows().find((r) => r.id === button.interactionId)?.blockId).toBe("row1");
    expect(t.enqueue.mock.calls[1]?.[0]).toMatchObject({ agentId: t.dev.id, triggerKind: "interaction" });
  });

  it("런 없이 저장된 에이전트 카드는 작성한 에이전트에게 간다", async () => {
    const t = setup();
    const message = t.card(t.dev, PICKER, null);
    await interact(t.deps, t.click(message, "go"));
    expect(t.enqueue.mock.calls[0]?.[0]).toMatchObject({ agentId: t.dev.id, triggerKind: "interaction" });
  });

  it("만료된 컴포넌트 → EXPIRED(저장·소비·런 없음)", async () => {
    const t = setup();
    const message = t.card(t.dev);
    const expiresAt = new Date(message.componentState?.expiresAt ?? "");
    t.setNow(new Date(expiresAt.getTime() + 1));
    await expect(interact(t.deps, t.click(message, "go"))).rejects.toMatchObject({
      body: { code: "EXPIRED" },
    });
    expect(t.interactionRows()).toEqual([]);
    expect(t.enqueue).not.toHaveBeenCalled();
    expect(t.updated).toEqual([]);
  });

  it("reusable 카드도 상호작용마다 message.updated 를 쏜다 — 결과 줄이 실시간으로 는다", async () => {
    const t = setup();
    const message = t.card(t.dev, { ...PICKER, reusable: true });
    await interact(t.deps, t.click(message, "go"));
    await interact(t.deps, t.click(message, "go"));
    expect(t.enqueue).toHaveBeenCalledTimes(2);
    expect(t.interactionRows()).toHaveLength(2);
    expect(t.updated.map((m) => m.id)).toEqual([message.id, message.id]);
    // 소비 규칙은 그대로 — reusable 은 consumed 가 비어 있다
    expect(t.updated[1]?.componentState?.consumed).toEqual([]);
    expect(getMessage(t.db, message.id)?.componentState?.consumed).toEqual([]);
    // 결과 줄은 wire 경계(팬아웃)가 붙인다 — 그 메시지를 하이드레이션하면 2건(팬아웃 쪽은 wire.runs.test)
    const [hydrated] = withInteractions(t.db, t.updated.slice(1));
    expect(hydrated?.interactions.map((i) => i.itemId)).toEqual(["go", "go"]);
  });

  it("interact() 안에서 읽은 메시지·버스 페이로드에는 interactions 가 없다 — 내부 경로는 하이드레이션하지 않는다", async () => {
    const t = setup();
    const message = t.card(t.dev, { ...PICKER, reusable: true });
    await interact(t.deps, t.click(message, "go"));
    const reads = countInteractionReads(t.db);
    try {
      await interact(t.deps, t.click(message, "go"));
      expect(reads.count()).toBe(0);
      // 대조 — 하이드레이션을 부르면 세어진다(세는 방법이 헛돌지 않는다)
      withInteractions(t.db, [message]);
      expect(reads.count()).toBe(1);
    } finally {
      reads.restore();
    }
    // DB 에는 2건이 있어도 버스로 나간 Message 는 비어 있다 — 붙이는 것은 팬아웃(클라이언트 경계)의 몫
    expect(t.interactionRows()).toHaveLength(2);
    expect(t.updated[1]?.interactions).toEqual([]);
  });

  it("components 없는 메시지는 질의 0회, interactions 는 []", () => {
    const t = setup();
    createUserMessage(t.db, t.bus, {
      conversationId: channelConversation(t.db, t.channel.id),
      authorId: t.userId,
      bodyMd: "안녕",
      clientMsgId: "c1",
    });
    createAgentMessage(t.db, t.bus, {
      conversationId: channelConversation(t.db, t.channel.id),
      agentId: t.dev.id,
      externalId: "p",
      bodyMd: "네",
    });
    const reads = countInteractionReads(t.db);
    try {
      const page = listMessages(t.db, t.channel.id, { limit: 50 });
      expect(page.messages).toHaveLength(2);
      expect(page.messages.map((m) => m.interactions)).toEqual([[], []]);
      expect(reads.count()).toBe(0);
    } finally {
      reads.restore();
    }
  });

  it("한도에 걸리면 RUN_LIMIT — 저장·소비·런 없음, 누를 수 없는 아이템은 그 사유가 먼저", async () => {
    const t = setup();
    const message = t.card(t.dev); // 오늘 런 1개(카드를 낸 런)
    const consumed = t.card(t.dev);
    await interact(t.deps, t.click(consumed, "go"));
    t.enqueue.mockClear();
    t.updated.length = 0;
    patchOpsSettings(t.db, t.workspaceId, { dailyRunLimit: 2 }); // 오늘 런 2개 — 찼다

    await expect(interact(t.deps, t.click(message, "go"))).rejects.toMatchObject({
      body: { code: "RUN_LIMIT" },
    });
    await expect(interact(t.deps, t.click(consumed, "go"))).rejects.toMatchObject({
      body: { code: "CONSUMED" },
    });
    expect(t.enqueue).not.toHaveBeenCalled();
    expect(t.interactionRows()).toHaveLength(1); // 앞서 소비한 것뿐
    expect(t.updated).toEqual([]);
    expect(getMessage(t.db, message.id)?.componentState?.consumed).toEqual([]);
    expect(t.ops.record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "run_limit", key: "workspace" }),
    );

    patchOpsSettings(t.db, t.workspaceId, { dailyRunLimit: 3 });
    await interact(t.deps, t.click(message, "go"));
    expect(t.enqueue).toHaveBeenCalledTimes(1);
  });

  it("retry_run → 원래 런의 트리거로 새 런(parentRunId), 1회용 소비", async () => {
    const t = setup();
    const { run: failed, notice } = failedRun(t, {
      agent: t.dev,
      triggerKind: "relay",
      relayDepth: 2,
      fromAgent: t.fin,
    });

    await interact(t.deps, t.click(notice, "retry_run"));
    expect(t.enqueue).toHaveBeenCalledTimes(1);
    expect(t.enqueue).toHaveBeenCalledWith(
      {
        agentId: t.dev.id,
        channelId: t.channel.id,
        conversationId: channelConversation(t.db, t.channel.id),
        triggerKind: "relay",
        rootMessageId: failed.rootMessageId,
        relayDepth: 2,
        parentRunId: failed.id,
      },
      // 시킨 사람은 원래 런의 값 — 이 런은 requested_by 없이 넣었다
      { message: expect.objectContaining({ id: failed.triggerMessageId }), requestedBy: null },
    );
    expect(getMessage(t.db, notice.id)?.componentState?.consumed).toEqual(["retry_run"]);
    await expect(interact(t.deps, t.click(notice, "retry_run"))).rejects.toMatchObject({
      body: { code: "CONSUMED" },
    });
  });

  it("retry_run 대상이 error 가 아니거나 트리거 메시지가 없거나 런이 없으면 VALIDATION — 버튼은 남는다", async () => {
    const t = setup();
    const base = {
      channelId: t.channel.id,
      conversationId: channelConversation(t.db, t.channel.id),
      agentId: t.dev.id,
      rootMessageId: uuid(),
      relayDepth: 0,
      sessionKey: "k",
      createdAt: new Date(),
    };
    const done = insertRun(t.db, { ...base, triggerKind: "mention", triggerMessageId: uuid() });
    const noTrigger = insertRun(t.db, { ...base, triggerKind: "interaction" });
    updateRun(t.db, noTrigger.id, { status: "error", error: { code: "TIMEOUT", message: "t" } });
    for (const runId of [done.id, noTrigger.id, uuid()]) {
      const notice = retryNotice(t, runId);
      await expect(interact(t.deps, t.click(notice, "retry_run"))).rejects.toMatchObject({
        body: { code: "VALIDATION" },
      });
      expect(getMessage(t.db, notice.id)?.componentState?.consumed).toEqual([]);
    }
    expect(t.enqueue).not.toHaveBeenCalled();
    expect(t.interactionRows()).toEqual([]);
  });

  it("retry_run 대상 에이전트가 비활성이면 VALIDATION — 저장·소비·런 없음(되살리면 다시 누를 수 있다)", async () => {
    const t = setup();
    const { notice } = failedRun(t, { agent: t.dev, triggerKind: "mention" });
    updateAgent(t.db, t.dev.id, { enabled: false });
    await expect(interact(t.deps, t.click(notice, "retry_run"))).rejects.toMatchObject({
      body: { code: "VALIDATION" },
    });
    expect(t.enqueue).not.toHaveBeenCalled();
    expect(t.interactionRows()).toEqual([]);
    expect(getMessage(t.db, notice.id)?.componentState?.consumed).toEqual([]);

    updateAgent(t.db, t.dev.id, { enabled: true });
    await interact(t.deps, t.click(notice, "retry_run"));
    expect(t.enqueue).toHaveBeenCalledTimes(1);
  });

  it("retry_run 대상 에이전트가 채널에서 빠졌으면 VALIDATION — 저장·소비·런 없음", async () => {
    const t = setup();
    const { notice } = failedRun(t, { agent: t.dev, triggerKind: "mention" });
    removeMember(t.db, t.channel.id, t.dev.id);
    await expect(interact(t.deps, t.click(notice, "retry_run"))).rejects.toMatchObject({
      body: { code: "VALIDATION" },
    });
    expect(t.enqueue).not.toHaveBeenCalled();
    expect(t.interactionRows()).toEqual([]);
    expect(getMessage(t.db, notice.id)?.componentState?.consumed).toEqual([]);
  });

  it("relay 런 retry 는 턴 상한을 다시 보지 않는다 — 이어가기처럼 사람이 누른 것(판정 R2)", async () => {
    const t = setup({ maxRelayTurns: 1 });
    const { run, notice } = failedRun(t, {
      agent: t.fin,
      triggerKind: "relay",
      relayDepth: 3,
      fromAgent: t.dev,
    });
    await interact(t.deps, t.click(notice, "retry_run"));
    expect(t.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: t.fin.id,
        triggerKind: "relay",
        relayDepth: 3,
        parentRunId: run.id,
      }),
      expect.anything(),
    );
  });

  it("relay 런 retry 는 지금 allowPairs 에서 빠진 쌍이면 VALIDATION — 버튼은 남고, 쌍을 되돌리면 통과(판정 R2)", async () => {
    const t = setup();
    const { notice } = failedRun(t, { agent: t.fin, triggerKind: "relay", relayDepth: 1, fromAgent: t.dev });
    // 반대 방향(fin → dev)만 남긴다 — 원래 런의 쌍은 dev → fin
    updateChannel(t.db, t.channel.id, {
      relayPolicy: { maxRelayTurns: 4, allowPairs: [{ from: t.fin.id, to: t.dev.id }] },
    });
    await expect(interact(t.deps, t.click(notice, "retry_run"))).rejects.toMatchObject({
      body: { code: "VALIDATION" },
    });
    expect(t.enqueue).not.toHaveBeenCalled();
    expect(t.interactionRows()).toEqual([]);
    expect(getMessage(t.db, notice.id)?.componentState?.consumed).toEqual([]);

    updateChannel(t.db, t.channel.id, {
      relayPolicy: { maxRelayTurns: 4, allowPairs: [{ from: t.dev.id, to: t.fin.id }] },
    });
    await interact(t.deps, t.click(notice, "retry_run"));
    expect(t.enqueue).toHaveBeenCalledTimes(1);
  });

  it("mention 런 retry 는 allowPairs 와 무관하다", async () => {
    const t = setup({ maxRelayTurns: 4, allowPairs: [] });
    const { notice } = failedRun(t, { agent: t.dev, triggerKind: "mention" });
    await interact(t.deps, t.click(notice, "retry_run"));
    expect(t.enqueue).toHaveBeenCalledTimes(1);
  });

  it("같은 아이템을 동시에 눌러도 한 번만 통과한다", async () => {
    const t = setup();
    const message = t.card(t.dev);
    const results = await Promise.allSettled([
      interact(t.deps, t.click(message, "go")),
      interact(t.deps, t.click(message, "go")),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.reason).toMatchObject({ body: { code: "CONSUMED" } });
    expect(t.interactionRows()).toHaveLength(1);
    expect(t.enqueue).toHaveBeenCalledTimes(1);
    expect(t.updated).toHaveLength(1);
    expect(getMessage(t.db, message.id)?.componentState?.consumed).toEqual(["go"]);
  });

  it("오류 코드와 순서는 계약 9.3 — NOT_FOUND → EXPIRED → FORBIDDEN → CONSUMED → VALIDATION", async () => {
    const t = setup();
    const code = (input: InteractInput) =>
      interact(t.deps, input).then(
        () => "ok",
        (err: { body?: { code?: string } }) => err.body?.code,
      );
    const message = t.card(t.dev);

    expect(await code({ ...t.click(message, "go"), messageId: uuid() })).toBe("NOT_FOUND");
    expect(await code({ ...t.click(message, "go"), componentId: "cmp_other" })).toBe("NOT_FOUND");
    expect(await code(t.click(message, "nope"))).toBe("NOT_FOUND");
    expect(await code(t.click(message, "boss_only"))).toBe("FORBIDDEN");
    expect(await code(t.click(message, "target", { values: ["mobile"] }))).toBe("VALIDATION");
    expect(await code(t.click(message, "go", { extra: 1 }))).toBe("VALIDATION");

    // 소비된 아이템에 잘못된 값 → CONSUMED 가 먼저
    expect(await code(t.click(message, "go"))).toBe("ok");
    expect(await code(t.click(message, "go", { extra: 1 }))).toBe("CONSUMED");
    // 만료 + 허용 밖 → EXPIRED 가 먼저
    t.setNow(new Date(Date.now() + 86_400_000 * 2));
    expect(await code(t.click(message, "boss_only"))).toBe("EXPIRED");

    // 컴포넌트가 없는 메시지
    const plain = createAgentMessage(t.db, t.bus, {
      conversationId: channelConversation(t.db, t.channel.id),
      agentId: t.dev.id,
      externalId: "plain",
      bodyMd: "그냥 글",
    });
    t.setNow(new Date());
    expect(await code({ ...t.click(plain, "go"), componentId: "cmp_x" })).toBe("NOT_FOUND");
    expect(t.enqueue).toHaveBeenCalledTimes(1);
  });

  it("다른 워크스페이스 채널의 메시지는 NOT_FOUND", async () => {
    const t = setup();
    const other = seedWorkspace(t.db, { userHandle: "stranger" });
    const channel = createChannel(t.db, {
      workspaceId: other.workspaceId,
      createdBy: other.userId,
      name: "x",
    });
    const agent = createAgent(t.db, {
      workspaceId: other.workspaceId,
      providerAgentId: "ext",
      handle: "ext",
      name: "ext",
    });
    const message = createAgentMessage(t.db, t.bus, {
      conversationId: channelConversation(t.db, channel.id),
      agentId: agent.id,
      externalId: "other-ws",
      bodyMd: "남의 카드",
      components: PICKER,
    });
    await expect(interact(t.deps, t.click(message, "go"))).rejects.toMatchObject({
      body: { code: "NOT_FOUND" },
    });
    expect(t.interactionRows()).toEqual([]);
  });
});

describe("components service — 스레드 안의 카드(스펙 2.2)", () => {
  function threadSetup() {
    const t = setup();
    const root = createUserMessage(t.db, t.bus, {
      conversationId: channelConversation(t.db, t.channel.id),
      authorId: t.userId,
      bodyMd: "루트",
      clientMsgId: "root",
    });
    return { ...t, root };
  }

  it("스레드 안 에이전트 카드 → 그 스레드의 interaction 런", async () => {
    const t = threadSetup();
    const card = createAgentMessage(t.db, t.bus, {
      conversationId: channelConversation(t.db, t.channel.id),
      agentId: t.dev.id,
      runId: t.runOf(t.dev).id,
      externalId: "thread-card",
      bodyMd: "골라 주세요",
      components: PICKER,
      threadRootId: t.root.id,
    });
    await interact(t.deps, t.click(card, "go"));
    expect(t.enqueue.mock.calls[0]?.[0]).toMatchObject({
      agentId: t.dev.id,
      triggerKind: "interaction",
      threadRootId: t.root.id,
    });
  });

  it("스레드 안 relay_limit 의 이어가기 → 그 스레드의 continue 런", async () => {
    const t = threadSetup();
    const limit = createSystemMessage(t.db, t.bus, {
      conversationId: channelConversation(t.db, t.channel.id),
      threadRootId: t.root.id,
      kind: "relay_limit",
      bodyMd: "한도",
      systemMeta: {
        kind: "relay_limit",
        relay: { fromAgentId: t.dev.id, toAgentId: t.fin.id, sourceRunId: uuid(), rootMessageId: uuid() },
      },
      components: {
        blocks: [{ type: "actions", items: [{ type: "button", id: "continue_relay", label: "이어가기" }] }],
      },
    });
    await interact(t.deps, t.click(limit, "continue_relay"));
    expect(t.enqueue.mock.calls[0]?.[0]).toMatchObject({
      agentId: t.fin.id,
      triggerKind: "continue",
      threadRootId: t.root.id,
    });
  });

  it("스레드 런의 다시 실행 → 원래 런의 스레드", async () => {
    const t = threadSetup();
    const trigger = createUserMessage(t.db, t.bus, {
      conversationId: channelConversation(t.db, t.channel.id),
      authorId: t.userId,
      bodyMd: "@dev 해줘",
      clientMsgId: "t1",
      threadRootId: t.root.id,
    });
    const run = insertRun(t.db, {
      channelId: t.channel.id,
      conversationId: channelConversation(t.db, t.channel.id),
      agentId: t.dev.id,
      triggerKind: "mention",
      triggerMessageId: trigger.id,
      rootMessageId: trigger.id,
      relayDepth: 0,
      sessionKey: "k",
      threadRootId: t.root.id,
      createdAt: new Date(),
    });
    updateRun(t.db, run.id, { status: "error", error: { code: "PLUGIN_OUTDATED", message: "p" } });
    const notice = createSystemMessage(t.db, t.bus, {
      conversationId: channelConversation(t.db, t.channel.id),
      threadRootId: t.root.id,
      kind: "run_error",
      bodyMd: "실패",
      systemMeta: { kind: "run_error", runId: run.id },
      components: {
        blocks: [{ type: "actions", items: [{ type: "button", id: "retry_run", label: "다시 실행" }] }],
      },
    });
    await interact(t.deps, t.click(notice, "retry_run"));
    expect(t.enqueue.mock.calls[0]?.[0]).toMatchObject({
      agentId: t.dev.id,
      parentRunId: run.id,
      threadRootId: t.root.id,
    });
  });

  it("스레드 안 카드가 한도에 막히면 run_limit 알림도 그 스레드에", async () => {
    const t = threadSetup();
    patchOpsSettings(t.db, t.workspaceId, { dailyRunLimit: 1 });
    const card = createAgentMessage(t.db, t.bus, {
      conversationId: channelConversation(t.db, t.channel.id),
      agentId: t.dev.id,
      runId: t.runOf(t.dev).id, // 오늘 런 1개
      externalId: "thread-card-2",
      bodyMd: "골라 주세요",
      components: PICKER,
      threadRootId: t.root.id,
    });
    await expect(interact(t.deps, t.click(card, "go"))).rejects.toMatchObject({
      body: { code: "RUN_LIMIT" },
    });
    const notices = listMessages(t.db, t.channel.id, {
      limit: 50,
      scope: { threadRootId: t.root.id },
    }).messages.filter((m) => m.systemMeta?.kind === "run_limit");
    expect(notices).toHaveLength(1);
  });
});

describe("components service — 채널의 둘째 대화에 있는 카드", () => {
  /** 채널에 둘째 대화 B 와 B 의 카드 — 카드를 낸 런이 오늘 런 1개다. legacy 가 false 면 「이전 대화」가 없는 채널 */
  function conversationSetup(opts: { legacy: boolean }) {
    const t = setup();
    if (!opts.legacy) t.db.delete(conversations).where(eq(conversations.id, t.channel.id)).run();
    const conversationId = uuid();
    t.db
      .insert(conversations)
      .values({
        id: conversationId,
        channelId: t.channel.id,
        title: "세션 B",
        titleSource: "user",
        createdByType: "user",
        createdById: t.userId,
        createdAt: new Date(),
      })
      .run();
    const run = insertRun(t.db, {
      channelId: t.channel.id,
      conversationId,
      agentId: t.dev.id,
      triggerKind: "mention",
      rootMessageId: uuid(),
      relayDepth: 0,
      sessionKey: `agent:dev:dodok:channel:${conversationId}`,
      createdAt: new Date(),
    });
    const card = createAgentMessage(t.db, t.bus, {
      conversationId,
      agentId: t.dev.id,
      runId: run.id,
      externalId: "conversation-b-card",
      bodyMd: "골라 주세요",
      components: PICKER,
    });
    patchOpsSettings(t.db, t.workspaceId, { dailyRunLimit: 1 });
    return { ...t, conversationId, card };
  }

  it("한도면 RUN_LIMIT — 상호작용을 저장·소비하지 않는다(「이전 대화」가 없는 채널)", async () => {
    const t = conversationSetup({ legacy: false });
    await expect(interact(t.deps, t.click(t.card, "go"))).rejects.toMatchObject({
      body: { code: "RUN_LIMIT" },
    });
    expect(t.interactionRows()).toEqual([]);
    expect(getMessage(t.db, t.card.id)?.componentState?.consumed).toEqual([]);
    expect(t.enqueue).not.toHaveBeenCalled();
  });

  it("run_limit 알림은 「이전 대화」가 아니라 카드가 있는 대화 B 에 남는다", async () => {
    const t = conversationSetup({ legacy: true });
    await expect(interact(t.deps, t.click(t.card, "go"))).rejects.toMatchObject({
      body: { code: "RUN_LIMIT" },
    });
    const notices = listMessages(t.db, t.channel.id, { limit: 50 }).messages.filter(
      (m) => m.systemMeta?.kind === "run_limit",
    );
    expect(notices.map((m) => m.conversationId)).toEqual([t.conversationId]);
  });
});

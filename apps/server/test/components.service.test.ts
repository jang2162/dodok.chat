import type { Agent, Message, RelayPolicy, Run } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { componentInteractions } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { type InteractInput, interact } from "../src/modules/components/service";
import { createAgentMessage, getMessage } from "../src/modules/messages/service";
import type { RunPlan } from "../src/modules/router/decide";
import { createRouter } from "../src/modules/router/service";
import type { EnqueueTrigger } from "../src/modules/runs/orchestrator";
import { insertRun } from "../src/modules/runs/store";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

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
  const deps = { db, bus, workspaceId, enqueue, now: () => clock };
  const setNow = (d: Date) => {
    clock = d;
  };
  const updated: Message[] = [];
  bus.on("message.updated", (p) => updated.push(p.message));

  let n = 0;
  const runOf = (agent: Agent, relayDepth = 0) =>
    insertRun(db, {
      channelId: channel.id,
      agentId: agent.id,
      triggerKind: "mention",
      rootMessageId: uuid(),
      relayDepth,
      sessionKey: `agent:${agent.providerAgentId}:dodok:channel:${channel.id}`,
      createdAt: new Date(),
    });
  const card = (agent: Agent, components: CardComponents = PICKER, run: Run | null = runOf(agent)) =>
    createAgentMessage(db, bus, {
      channelId: channel.id,
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
    deps,
    setNow,
    updated,
    runOf,
    card,
    click,
    interactionRows,
  };
}

describe("components service — interact", () => {
  it("continue_relay 클릭 → continue 런(relay.toAgentId, rootMessageId = 시스템 메시지, depth 0) + 소비 + message.updated", async () => {
    const t = setup({ maxRelayTurns: 1 });
    const created: Message[] = [];
    t.bus.on("message.created", (p) => created.push(p.message));
    const router = createRouter({ db: t.db, bus: t.bus, logger: t.logger, enqueue: t.enqueue });
    const source = t.runOf(t.dev, 1);
    await router.routeMessage(
      createAgentMessage(t.db, t.bus, {
        channelId: t.channel.id,
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

  it("reusable 컴포넌트는 소비하지 않고 message.updated 도 내지 않는다", async () => {
    const t = setup();
    const message = t.card(t.dev, { ...PICKER, reusable: true });
    await interact(t.deps, t.click(message, "go"));
    await interact(t.deps, t.click(message, "go"));
    expect(t.enqueue).toHaveBeenCalledTimes(2);
    expect(t.interactionRows()).toHaveLength(2);
    expect(t.updated).toEqual([]);
    expect(getMessage(t.db, message.id)?.componentState?.consumed).toEqual([]);
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
      channelId: t.channel.id,
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
      channelId: channel.id,
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

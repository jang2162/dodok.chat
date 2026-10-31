/**
 * 그 런을 시킨 사람(제어 MCP 스펙 「그 런을 시킨 사람」 절 표) — 실제 앱의 라우터·관문·오케스트레이터·카드 서비스로 런을 만들고
 * runs.requested_by 를 본다. 릴레이 사슬은 처음 사람을 물려받고, 자동화 글로 시작한 사슬은 null 이다(Review Focus 3)
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import type { Agent, Message } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { runs } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { postAutomationMessage } from "../src/modules/automations/post";
import { insertAutomation } from "../src/modules/automations/store";
import { addMember, type ChannelRecord, createChannel } from "../src/modules/channels/service";
import { createAgentMessage, createSystemMessage, createUserMessage } from "../src/modules/messages/service";
import { getRunRequestedBy, insertRun, updateRun } from "../src/modules/runs/store";
import { bootTestApp, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { channelConversation } from "./helpers/seed";

describe("runs.requested_by", () => {
  let app: App;
  let mia: string;
  let owner: string;
  let n = 0;

  beforeAll(async () => {
    app = await bootTestApp({}, { adapters: [new FakeAdapter()], automationTickMs: 3_600_000 });
    owner = app.ownerUserId;
    mia = (await userWithRole(app, "mia", "member")).id;
  });
  afterAll(async () => {
    await app.close();
  });

  const agent = (): Agent => {
    const handle = `rb${++n}`;
    return createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: handle,
      handle,
      name: handle,
    });
  };
  /** 에이전트 셋(a·b·c)과 사람 둘(owner·mia)이 든 새 채널 */
  const room = (opts: { maxRelayTurns?: number; autoRespond?: boolean } = {}) => {
    const channel = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: owner,
      name: `rb-${++n}`,
      relayPolicy: { maxRelayTurns: opts.maxRelayTurns ?? 4, allowPairs: "all" },
    });
    const [a, b, c] = [agent(), agent(), agent()] as [Agent, Agent, Agent];
    addMember(
      app.db,
      channel.id,
      { memberType: "agent", memberId: a.id, autoRespond: opts.autoRespond ?? false },
      app.logger,
    );
    for (const x of [b, c])
      addMember(app.db, channel.id, { memberType: "agent", memberId: x.id }, app.logger);
    addMember(app.db, channel.id, { memberType: "user", memberId: mia }, app.logger); // 만든 owner 는 이미 멤버다
    return { channel, a, b, c };
  };

  const route = (message: Message) => app.services.router.routeMessage(message);
  const say = async (channel: ChannelRecord, authorId: string, bodyMd: string) => {
    const message = createUserMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channel.id),
      authorId,
      bodyMd,
      clientMsgId: `c-${++n}`,
    });
    await route(message);
    return message;
  };
  /** 그 런의 에이전트가 답한다(그 런의 글) — 라우터가 멘션을 릴레이로 만든다 */
  const answer = async (runId: string, bodyMd: string) => {
    const run = app.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) throw new Error("런이 없다");
    const message = createAgentMessage(app.db, app.bus, {
      conversationId: run.conversationId,
      agentId: run.agentId,
      runId,
      externalId: `out-${++n}`,
      bodyMd,
    });
    await route(message);
    return message;
  };
  const runsBy = (column: "triggerMessageId" | "triggerInteractionId" | "parentRunId", id: string) =>
    app.db.select().from(runs).where(eq(runs[column], id)).all();
  const onlyRun = (column: "triggerMessageId" | "triggerInteractionId" | "parentRunId", id: string) => {
    const found = runsBy(column, id);
    expect(found).toHaveLength(1);
    return found[0] as typeof runs.$inferSelect;
  };

  it("사람 글의 멘션 — 그 글의 작성자", async () => {
    const { channel, a } = room();
    const message = await say(channel, mia, `@${a.handle} 해 줘`);
    expect(onlyRun("triggerMessageId", message.id).requestedBy).toBe(mia);
  });

  it("자동 응답 — 그 글의 작성자", async () => {
    const { channel } = room({ autoRespond: true });
    const message = await say(channel, mia, "멘션 없는 글");
    const run = onlyRun("triggerMessageId", message.id);
    expect(run.triggerKind).toBe("auto_respond");
    expect(run.requestedBy).toBe(mia);
  });

  it.each([
    ["mia(member)", () => mia],
    ["owner", () => owner],
  ])("릴레이 사슬 두 단계 — 처음 사람(%s)을 물려받는다 [Review Focus 3]", async (_label, who) => {
    const { channel, a, b, c } = room();
    const human = await say(channel, who(), `@${a.handle} 시작`);
    const first = onlyRun("triggerMessageId", human.id);
    const toB = await answer(first.id, `@${b.handle} 넘길게`);
    const second = onlyRun("triggerMessageId", toB.id);
    const toC = await answer(second.id, `@${c.handle} 마저`);
    const third = onlyRun("triggerMessageId", toC.id);
    expect([second.triggerKind, third.triggerKind]).toEqual(["relay", "relay"]);
    expect([first.requestedBy, second.requestedBy, third.requestedBy]).toEqual([who(), who(), who()]);
  });

  it("늦은 정본 — 앞 런이 끝난 뒤에 저장된 글이 낳은 릴레이는 시킨 사람이 없다(null 이면 쓰기 제어 도구는 FORBIDDEN — control.service 「시킨 사람 없음」)", async () => {
    const { channel, a, b } = room();
    const human = await say(channel, owner, `@${a.handle} 시작`);
    const first = onlyRun("triggerMessageId", human.id);
    expect(first.requestedBy).toBe(owner);
    updateRun(app.db, first.id, {
      status: "error",
      error: { code: "TIMEOUT", message: "t" },
      endedAt: new Date(Date.now() - 1_000),
    });
    const late = await answer(first.id, `@${b.handle} 넘길게`);
    const relay = onlyRun("triggerMessageId", late.id);
    expect(relay.triggerKind).toBe("relay");
    expect(relay.requestedBy).toBeNull();
  });

  it("같은 시각 — 런이 끝난 시각과 글의 createdAt 이 같은 ms 면 물려받는다(스냅샷 폴백 릴레이, server-decided 리뷰 L-1)", async () => {
    const { channel, a, b } = room();
    const human = await say(channel, mia, `@${a.handle} 시작`);
    const first = onlyRun("triggerMessageId", human.id);
    const message = createAgentMessage(app.db, app.bus, {
      conversationId: first.conversationId,
      agentId: first.agentId,
      runId: first.id,
      externalId: `out-${++n}`,
      bodyMd: `@${b.handle} 넘길게`,
    });
    updateRun(app.db, first.id, {
      status: "error",
      error: { code: "TIMEOUT", message: "t" },
      endedAt: new Date(message.createdAt),
    });
    const ended = app.db.select().from(runs).where(eq(runs.id, first.id)).get();
    expect(ended?.endedAt?.toISOString()).toBe(message.createdAt);
    await route(message);
    const relay = onlyRun("triggerMessageId", message.id);
    expect(relay.triggerKind).toBe("relay");
    expect(relay.requestedBy).toBe(mia);
  });

  it("열린 런의 글이 낳은 릴레이는 그대로 물려받는다", async () => {
    const { channel, a, b } = room();
    const human = await say(channel, mia, `@${a.handle} 시작`);
    const first = onlyRun("triggerMessageId", human.id);
    expect(first.endedAt).toBeNull();
    const relay = onlyRun("triggerMessageId", (await answer(first.id, `@${b.handle} 넘길게`)).id);
    expect(relay.requestedBy).toBe(mia);
  });

  it("자동화 글로 시작한 사슬 — 멘션 런도 릴레이 런도 null [Review Focus 3]", async () => {
    const { channel, a, b } = room();
    const automation = insertAutomation(app.db, {
      id: uuid(),
      workspaceId: app.workspaceId,
      name: `rb-auto-${++n}`,
      channelId: channel.id,
      kind: "schedule",
      bodyMd: `@${a.handle} 점검해 줘`,
      enabled: true,
      scheduleJson: { repeat: "daily", time: "09:00" },
      createdBy: owner, // 만든 사람이 있어도 그 글이 시킨 것은 아니다
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const posted = await postAutomationMessage(
      { db: app.db, bus: app.bus, route, logger: app.logger },
      automation,
    );
    expect(posted.authorType).toBe("automation");
    const first = onlyRun("triggerMessageId", posted.id);
    const relay = onlyRun("triggerMessageId", (await answer(first.id, `@${b.handle} 넘길게`)).id);
    expect([first.requestedBy, relay.requestedBy]).toEqual([null, null]);
  });

  it("카드 상호작용 — 누른 사람(그 카드를 낸 런의 사람이 아니다)", async () => {
    const { channel, a } = room();
    const human = await say(channel, mia, `@${a.handle} 골라 줘`);
    const card = createAgentMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channel.id),
      agentId: a.id,
      runId: onlyRun("triggerMessageId", human.id).id,
      externalId: `out-${++n}`,
      bodyMd: "골라 주세요",
      components: { blocks: [{ type: "actions", items: [{ type: "button", id: "go", label: "진행" }] }] },
    });
    const { interactionId } = await app.services.runs.interact({
      userId: owner,
      messageId: card.id,
      componentId: card.components?.id ?? "",
      itemId: "go",
      values: {},
    });
    const run = onlyRun("triggerInteractionId", interactionId);
    expect(run.triggerKind).toBe("interaction");
    expect(run.requestedBy).toBe(owner);
  });

  it("「이어가기」 — 누른 사람", async () => {
    const { channel, a, b } = room({ maxRelayTurns: 1 });
    const created: Message[] = [];
    const off = app.bus.on("message.created", (p) => created.push(p.message));
    const human = await say(channel, mia, `@${a.handle} 시작`);
    const toB = await answer(onlyRun("triggerMessageId", human.id).id, `@${b.handle} 넘길게`);
    await answer(onlyRun("triggerMessageId", toB.id).id, `@${a.handle} 다시`); // 깊이 2 — 한도
    off();
    const limit = created.find((m) => m.channelId === channel.id && m.systemMeta?.kind === "relay_limit");
    if (!limit?.components?.id) throw new Error("relay_limit 카드가 없다");
    const { interactionId } = await app.services.runs.interact({
      userId: owner,
      messageId: limit.id,
      componentId: limit.components.id,
      itemId: "continue_relay",
      values: {},
    });
    const run = onlyRun("triggerInteractionId", interactionId);
    expect(run.triggerKind).toBe("continue");
    expect(run.requestedBy).toBe(owner);
  });

  /** error 로 끝난 런과 그 run_error 카드 — 트리거는 mia 의 글, 런의 requested_by 는 stored 그대로 */
  const failed = (stored: string | null) => {
    const { channel, a } = room();
    const trigger = createUserMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channel.id),
      authorId: mia,
      bodyMd: `@${a.handle} 해 줘`,
      clientMsgId: `c-${++n}`,
    });
    const run = insertRun(app.db, {
      channelId: channel.id,
      conversationId: channelConversation(app.db, channel.id),
      agentId: a.id,
      triggerKind: "mention",
      triggerMessageId: trigger.id,
      rootMessageId: trigger.id,
      relayDepth: 0,
      sessionKey: `agent:${a.providerAgentId}:dodok:channel:${channelConversation(app.db, channel.id)}`,
      connectionId: FAKE_GATEWAY_ID,
      requestedBy: stored,
      createdAt: new Date(),
    });
    updateRun(app.db, run.id, { status: "error", error: { code: "TIMEOUT", message: "t" } });
    const notice = createSystemMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channel.id),
      kind: "run_error",
      bodyMd: `@${a.handle} 실행이 실패했습니다: TIMEOUT`,
      systemMeta: { kind: "run_error", runId: run.id },
      components: {
        blocks: [{ type: "actions", items: [{ type: "button", id: "retry_run", label: "다시 실행" }] }],
      },
    });
    return { run, notice };
  };
  const retry = (notice: Message) =>
    app.services.runs.interact({
      userId: owner,
      messageId: notice.id,
      componentId: notice.components?.id ?? "",
      itemId: "retry_run",
      values: {},
    });

  it("「다시 실행」 — 원래 런의 값(누른 owner 가 아니다)", async () => {
    const { run, notice } = failed(mia);
    await retry(notice);
    const again = onlyRun("parentRunId", run.id);
    expect(again.triggerKind).toBe("mention");
    expect(again.requestedBy).toBe(mia);
  });

  it("「다시 실행」 — 원래 런이 null 이면 null(트리거 글의 작성자로 다시 정하지 않는다)", async () => {
    const { run, notice } = failed(null);
    await retry(notice);
    expect(onlyRun("parentRunId", run.id).requestedBy).toBeNull();
  });

  it("getRunRequestedBy — 없는 런이면 null", () => {
    expect(getRunRequestedBy(app.db, uuid())).toBeNull();
  });
});

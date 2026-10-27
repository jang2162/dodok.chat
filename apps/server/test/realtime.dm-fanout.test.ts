/**
 * DM 의 채널 사실은 주인에게만(에이전트 DM 계획 판정 PD4) — 채널 룸 밖으로 내던 이벤트(channel.created·updated·channel.activity·
 * approval.requested·resolved·system.notice)가 DM 이면 주인의 user 룸으로만 가고, 일반 채널이면 지금처럼 모두에게 간다. 실제 서버를
 * 띄우고 owner·admin·다른 member·DM 주인 mia 의 소켓 넷을 붙여(채널 구독 없이) 받은 것을 본다.
 */
import type { Approval, ServerToClientEvents } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { syncChannelPrompt } from "../src/modules/channels/prompt-sync";
import { createUserMessage } from "../src/modules/messages/service";
import { insertRun, updateRun } from "../src/modules/runs/store";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { createDmChannelForTest, seedConversation } from "./helpers/seed";
import { connectWire, recordEvents, waitFor, type WireClient } from "./helpers/wire";

type Who = "owner" | "admin" | "member" | "mia";
const WHO: Who[] = ["owner", "admin", "member", "mia"];
const EVENTS: (keyof ServerToClientEvents)[] = [
  "channel.created",
  "channel.updated",
  "channel.activity",
  "approval.requested",
  "approval.resolved",
  "system.notice",
  "ops.event",
  "conversation.created",
  "conversation.updated",
];

describe("DM 팬아웃 — 채널 사실은 DM 주인에게만", () => {
  let app: App;
  const tokens = {} as Record<Who, string>;
  const ids = {} as Record<Who, string>;
  const sockets = {} as Record<Who, WireClient>;
  let seen = {} as Record<Who, { event: keyof ServerToClientEvents; payload: unknown }[]>;
  let n = 0;

  beforeAll(async () => {
    app = await bootTestApp();
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    tokens.owner = (await login(app)).token;
    ids.owner = app.ownerUserId;
    for (const who of ["admin", "member", "mia"] as const) {
      const user = await userWithRole(app, `fan-${who}`, who === "admin" ? "admin" : "member");
      tokens[who] = user.token;
      ids[who] = user.id;
    }
  });
  afterEach(() => {
    for (const who of WHO) sockets[who]?.close();
  });
  afterAll(async () => {
    await app.close();
  });

  const connectAll = async () => {
    for (const who of WHO) sockets[who] = await connectWire(app, tokens[who]);
    seen = Object.fromEntries(WHO.map((who) => [who, recordEvents(sockets[who], EVENTS)])) as typeof seen;
  };
  const newAgent = () =>
    createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: `fan${++n}`,
      handle: `fan${n}`,
      name: `fan${n}`,
    });
  const dm = () => {
    const agent = newAgent();
    const channel = createDmChannelForTest(app.db, {
      workspaceId: app.workspaceId,
      ownerId: ids.mia,
      agentId: agent.id,
    });
    return { agent, channel, conversationId: seedConversation(app.db, channel.id, { createdBy: ids.mia }) };
  };
  const plain = () =>
    createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: `fan-ch-${++n}`,
    });
  /** 그 채널을 가리키는 이벤트를 받은 사람 */
  const receivers = (event: keyof ServerToClientEvents, channelId: string): Who[] =>
    WHO.filter((who) =>
      seen[who].some((e) => e.event === event && JSON.stringify(e.payload).includes(channelId)),
    );
  /**
   * DM 쪽 이벤트를 먼저 내고 일반 채널 쪽을 뒤에 낸다 — 같은 버스·같은 소켓이라 뒤의 것이 모두에게 닿았으면 앞의 것도 닿았을
   * 것은 다 닿아 있다(「받지 않음」이 팬아웃이 멈춰서 통과하지 않게)
   */
  const both = async (
    event: keyof ServerToClientEvents,
    emit: (channelId: string, conversationId: string) => void,
  ) => {
    const d = dm();
    const p = plain();
    const pConversation = seedConversation(app.db, p.id);
    const arrived = WHO.map((who) =>
      waitFor(sockets[who], event, (payload) => JSON.stringify(payload).includes(p.id)),
    );
    emit(d.channel.id, d.conversationId);
    emit(p.id, pConversation);
    await Promise.all(arrived);
    return { dm: receivers(event, d.channel.id), plain: receivers(event, p.id) };
  };
  it.each(["channel.created", "channel.updated"] as const)(
    "%s — DM 은 주인만, 일반 채널은 모두",
    async (event) => {
      await connectAll();
      const d = dm();
      const p = plain();
      const arrived = WHO.map((who) =>
        waitFor(sockets[who], event, (payload) => payload.channel.id === p.id),
      );
      app.bus.emit(event, { channel: d.channel });
      app.bus.emit(event, { channel: p });
      await Promise.all(arrived);
      expect(receivers(event, d.channel.id)).toEqual(["mia"]);
      expect(receivers(event, p.id)).toEqual(WHO);
    },
  );

  it.each(["conversation.created", "conversation.updated"] as const)(
    "%s — 채널 룸 이벤트라 DM 은 주인 말고 아무도 받지 않는다(제목이 첫 글로 지어지므로 새면 본문이 샌다)",
    async (event) => {
      await connectAll();
      const d = dm();
      const p = plain();
      const pConversation = seedConversation(app.db, p.id);
      // 모두 일반 채널을 구독하고 DM 도 구독하려 한다 — 주인만 붙고 나머지는 NOT_FOUND
      for (const who of WHO) {
        expect((await sockets[who].emitWithAck("channel.subscribe", { channelId: p.id })).ok).toBe(true);
        const sub = await sockets[who].emitWithAck("channel.subscribe", { channelId: d.channel.id });
        expect(sub.ok ? "ok" : sub.error.code, who).toBe(who === "mia" ? "ok" : "NOT_FOUND");
      }
      const arrived = WHO.map((who) =>
        waitFor(sockets[who], event, (payload) => payload.conversation.channelId === p.id),
      );
      const conversation = (channelId: string, id: string) =>
        ({ id, channelId, title: "오로라 이야기", status: "open" }) as never;
      app.bus.emit(event, { conversation: conversation(d.channel.id, d.conversationId) });
      app.bus.emit(event, { conversation: conversation(p.id, pConversation) });
      await Promise.all(arrived);
      expect(receivers(event, d.channel.id)).toEqual(["mia"]);
      expect(receivers(event, p.id)).toEqual(WHO);
    },
  );

  it("channel.activity — DM 의 새 글 신호는 주인만, 일반 채널은 모두", async () => {
    await connectAll();
    const got = await both("channel.activity", (channelId, conversationId) =>
      app.bus.emit("message.created", {
        message: {
          id: uuid(),
          channelId,
          conversationId,
          seq: ++n,
          kind: "normal",
          authorType: "agent",
          authorId: uuid(),
          bodyMd: "x",
          mentions: { users: [ids.owner], agents: [] },
          reactions: [],
        } as never,
      }),
    );
    expect(got.dm).toEqual(["mia"]);
    expect(got.plain).toEqual(WHO);
  });

  it("channel.activity — DM 에이전트 글은 mentionedUserIds 가 [주인], 사람 글·일반 채널 에이전트 글은 메시지의 멘션 그대로", async () => {
    await connectAll();
    const d = dm();
    const p = plain();
    const pConversation = seedConversation(app.db, p.id);
    const activity = (
      channelId: string,
      conversationId: string,
      authorType: "agent" | "user",
      authorId: string,
      users: string[],
    ) => {
      const id = uuid();
      app.bus.emit("message.created", {
        message: {
          id,
          channelId,
          conversationId,
          seq: ++n,
          kind: "normal",
          authorType,
          authorId,
          bodyMd: "x",
          mentions: { users, agents: [] },
          reactions: [],
        } as never,
      });
      return n;
    };
    const mentionedOf = (who: Who, seq: number) =>
      (
        seen[who].find((e) => e.event === "channel.activity" && (e.payload as { seq: number }).seq === seq)
          ?.payload as { mentionedUserIds: string[] } | undefined
      )?.mentionedUserIds;
    const dmAgent = activity(d.channel.id, d.conversationId, "agent", d.agent.id, []);
    const dmUser = activity(d.channel.id, d.conversationId, "user", ids.mia, []);
    const plainAgent = activity(p.id, pConversation, "agent", uuid(), [ids.owner]);
    const plainQuiet = activity(p.id, pConversation, "agent", uuid(), []);
    // 일반 채널의 마지막 글이 모두에게 닿았으면 앞의 것도 닿아 있다(같은 버스·같은 소켓 — both 와 같은 까닭)
    await Promise.all(
      WHO.map((who) => waitFor(sockets[who], "channel.activity", (payload) => payload.seq === plainQuiet)),
    );
    expect(mentionedOf("mia", dmAgent)).toEqual([ids.mia]);
    expect(mentionedOf("mia", dmUser)).toEqual([]);
    expect(mentionedOf("owner", plainAgent)).toEqual([ids.owner]);
    expect(mentionedOf("mia", plainQuiet)).toEqual([]);
  });

  it.each(["approval.requested", "approval.resolved"] as const)(
    "%s — DM 의 승인은 주인만, 일반 채널은 모두",
    async (event) => {
      await connectAll();
      const got = await both(event, (channelId, conversationId) =>
        app.bus.emit(event, {
          approval: {
            id: uuid(),
            channelId,
            conversationId,
            kind: "tool",
            status: event === "approval.requested" ? "pending" : "approved",
            title: "도구",
          } as unknown as Approval,
        }),
      );
      expect(got.dm).toEqual(["mia"]);
      expect(got.plain).toEqual(WHO);
    },
  );

  it("system.notice — DM 의 지시 반영 실패는 주인에게만 「DM」 으로, 일반 채널은 모두에게 #이름으로", async () => {
    await connectAll();
    const d = dm();
    const p = plain();
    // 일반 채널에도 OpenClaw 에이전트가 있어야 보낼 Gateway 가 생긴다
    const plainAgent = newAgent();
    addMember(app.db, p.id, { memberType: "agent", memberId: plainAgent.id }, app.logger);
    const failing = {
      db: app.db,
      bus: app.bus,
      logger: { warn: () => undefined } as never,
      registry: {
        forProvider: () => ({ syncChannelConfig: () => Promise.reject(new Error("gateway down")) }) as never,
      },
    };
    const notices = (who: Who) =>
      seen[who]
        .filter((e) => e.event === "system.notice")
        .map((e) => (e.payload as { message: string }).message);
    const plainArrived = WHO.map((who) =>
      waitFor(sockets[who], "system.notice", (payload) => payload.message.includes(p.name)),
    );
    const dmArrived = waitFor(sockets.mia, "system.notice", (payload) => payload.message.startsWith("DM"));
    syncChannelPrompt(failing, d.channel);
    syncChannelPrompt(failing, p);
    await Promise.all([...plainArrived, dmArrived]);
    expect(notices("mia")).toEqual([
      "DM 의 지시를 Gateway 에 반영하지 못했다: gateway down",
      `#${p.name} 채널 프롬프트를 Gateway 에 반영하지 못했다: gateway down`,
    ]);
    for (const who of ["owner", "admin", "member"] as const)
      expect(notices(who)).toEqual([`#${p.name} 채널 프롬프트를 Gateway 에 반영하지 못했다: gateway down`]);
    // 페이로드에 받을 사람 id 가 실리지 않는다 — 팬아웃이 룸을 고르는 데만 쓴다
    expect(seen.mia.find((e) => e.event === "system.notice")?.payload).not.toHaveProperty("userId");
  });

  it("ops.event control_change — DM 의 제어 쓰기는 VALIDATION 이고 운영 사건이 생기지 않는다(일반 채널은 채널 id 를 싣는다)", async () => {
    await connectAll();
    const d = dm();
    const p = plain();
    const changed = (who: "owner" | "admin", userId: string) =>
      waitFor(
        sockets[who],
        "ops.event",
        (e) => e.event.kind === "control_change" && e.event.key === `control:update_channel:${userId}`,
      );
    expect(
      await app.control.call({ userId: ids.mia, via: "pat" }, "update_channel", {
        channelId: d.channel.id,
        topic: "주제",
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    // 일반 채널은 그대로 채널 id 를 싣는다 — 이 사건이 닿은 뒤에는 앞의 DM 쪽 사건도 (있었다면) 닿아 있다
    const theirs = [changed("owner", ids.owner), changed("admin", ids.owner)];
    expect(
      await app.control.call({ userId: ids.owner, via: "pat" }, "update_channel", {
        channelId: p.id,
        topic: "주제",
      }),
    ).toMatchObject({ ok: true });
    for (const { event } of await Promise.all(theirs))
      expect(event.detail).toMatchObject({ channelId: p.id });
    for (const who of ["owner", "admin"] as const) {
      const events = seen[who].filter((e) => e.event === "ops.event").map((e) => JSON.stringify(e.payload));
      expect(events.filter((e) => e.includes(`control:update_channel:${ids.mia}`))).toEqual([]);
      expect(events.filter((e) => e.includes(d.channel.id))).toEqual([]);
    }
  });

  it("확인 카드 — DM 런의 제어 쓰기 카드는 주인만 받고, 출처 줄은 #dm 이 아니라 「DM」", async () => {
    await connectAll();
    const d = dm();
    const root = createUserMessage(app.db, app.bus, {
      conversationId: d.conversationId,
      authorId: ids.mia,
      bodyMd: "채널 하나 만들어 줘",
      clientMsgId: `fan-root-${++n}`,
    });
    const queued = insertRun(app.db, {
      channelId: d.channel.id,
      conversationId: d.conversationId,
      agentId: d.agent.id,
      triggerKind: "auto_respond",
      triggerMessageId: root.id,
      rootMessageId: root.id,
      relayDepth: 0,
      sessionKey: `agent:${d.agent.providerAgentId}:dodok:channel:${d.conversationId}`,
      connectionId: FAKE_GATEWAY_ID,
      requestedBy: ids.mia,
      createdAt: new Date(),
    });
    const run = updateRun(app.db, queued.id, { status: "tool", startedAt: new Date() });
    const requested = waitFor(sockets.mia, "approval.requested", (p) => p.approval.runId === run.id);
    // DM 을 바꾸는 도구는 VALIDATION(계획 판정 PD9) — DM 에서 뜨는 카드는 채널을 받지 않는 쓰기(member 도 되는 create_channel)다
    const call = app.control.call(
      { userId: ids.mia, via: "agent", agentId: d.agent.id, runId: run.id },
      "create_channel",
      { name: `fan-new-${++n}` },
    );
    const { approval } = await requested;
    expect(approval.title).toContain("만들려 합니다");
    expect(approval.title).not.toContain("#dm");
    expect(approval.detail).toContain(" · DM · ");
    expect(approval.detail).not.toContain("#dm");
    const resolved = waitFor(sockets.mia, "approval.resolved", (p) => p.approval.id === approval.id);
    expect(
      await sockets.mia.emitWithAck("approval.resolve", { approvalId: approval.id, decision: "deny" }),
    ).toMatchObject({
      ok: true,
    });
    await resolved;
    await call;
    // 같은 연결의 ack 왕복 — 그 앞에 서버가 이 소켓에 보낸 이벤트는 모두 와 있다
    for (const who of ["owner", "admin", "member"] as const) {
      await sockets[who].emitWithAck("channel.unsubscribe", { channelId: uuid() });
      expect(seen[who].filter((e) => e.event.startsWith("approval."))).toEqual([]);
    }
  });
});

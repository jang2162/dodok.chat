/**
 * 채널 세션 — 세션 닫기(스펙 「세션 만들기·닫기」 절·「오류 처리」 장)와 런·에이전트가 세션 단위로 도는 것(「누가 답하나」·「에이전트가
 * 받는 것」 절). 실제 서버(실제 OpenClawAdapter) + 가짜 Gateway + 가짜 플러그인 + wire 클라이언트.
 * 닫는 순간 도는 런은 멈추고(가짜 Gateway 에 chat.abort), 그 뒤 온 늦은 정본은 그 세션에 저장만 된다(릴레이·푸시 없음).
 * 한 채널의 두 세션은 세션 키·맥락이 따로이고 병렬로 돌며, 릴레이는 그 세션 안에서만 잇고, 세션 키의 대화 밖으로 온 정본은 저장하지 않는다
 */
import { randomUUID } from "node:crypto";
import {
  type Channel,
  type ChannelMember,
  type Conversation,
  dodokSessionKey,
  formatSessionLine,
  type Message,
  PushPayload,
  REACTION_EMOJIS,
} from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversations, messages, runs, users } from "../../src/db/schema.sqlite";
import { getRun } from "../../src/modules/runs/store";
import { createScenario } from "../fakes/scenario";
import { bootLiveApp, type LiveApp } from "../helpers/live-app";
import { userWithRole } from "../helpers/app";
import { openChannelWire, rest, sendMessage, setupRelayChannel, WAIT_MS } from "../helpers/scenario-steps";
import { channelConversation } from "../helpers/seed";
import { connectWire, type WireClient } from "../helpers/wire";

const PUSH_KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

describe("통합 — 세션 닫기", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  it("[Review Focus 3] 닫으면 도는 런이 멈추고(Gateway 에 abort), 늦은 정본은 그 세션에 저장만 — 릴레이·푸시 없음, 보내기는 409", async () => {
    live = await bootLiveApp();
    const { channel, dev, fin } = await setupRelayChannel(live, { maxRelayTurns: 3, allowPairs: "all" });
    const log = await openChannelWire(live, channel.id, sockets);
    // dev 는 델타까지만 흘리고 멈춘다 — 런이 진행 중으로 남는다
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: {
        dev: () => ({ deltas: ["생각 중"], reply: "끝", holdFinal: true }),
        fin: () => ({ reply: "fin" }),
      },
    });
    const silent: Array<{ message: Message; silent?: true }> = [];
    live.app.bus.on("message.created", (p) => silent.push(p));

    const trigger = await sendMessage(log.socket, channel.id, "@dev 길게 봐줘");
    const conversationId = trigger.conversationId;
    const run = await log.until(
      () => log.states.find((s) => s.agentId === dev.id && s.status === "streaming"),
      "dev 런 streaming",
    );

    const closed = await rest<{ conversation: { closedAt?: string } }>(
      live,
      "PATCH",
      `/conversations/${conversationId}`,
      {
        closed: true,
      },
    );
    expect(closed.status).toBe(200);
    expect(closed.body.conversation.closedAt).toBeDefined();
    expect((await log.terminal(run.id)).status).toBe("aborted");
    expect(
      live.gateway.requests.some(
        (r) => r.method === "chat.abort" && (r.params as { runId?: unknown }).runId === run.id,
      ),
    ).toBe(true);
    const notice = await log.until(
      () => log.created.find((m) => m.kind === "system" && m.bodyMd.endsWith("이 세션을 닫았습니다")),
      "닫기 시스템 메시지",
    );
    expect(notice.conversationId).toBe(conversationId);

    // 닫힌 세션에 사람은 못 쓴다
    const refused = await log.socket.emitWithAck("message.send", {
      channelId: channel.id,
      conversationId,
      clientMsgId: "after-close",
      bodyMd: "@dev 하나 더",
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "CONVERSATION_CLOSED" } });

    // 그 런의 늦은 정본 — 멘션이 있어도 fin 을 깨우지 않고, 푸시 트리거가 건너뛰는 silent 로 남는다
    const sessionKey = scenario.turns[0]?.delivery.sessionKey ?? "";
    const late = await live.plugin.sendOutbound({
      conversationId,
      agentId: "dev",
      sessionKey,
      runId: run.id,
      text: "@fin 늦었지만 답",
      attachmentIds: [],
    });
    const stored = await log.until(() => log.created.find((m) => m.id === late.messageId), "늦은 정본");
    expect(stored).toMatchObject({ conversationId, authorId: dev.id, runId: run.id });
    expect(silent.find((p) => p.message.id === late.messageId)?.silent).toBe(true);
    await scenario.idle();
    expect(scenario.turns.map((t) => t.agentId)).toEqual(["dev"]);
    expect(log.states.some((s) => s.agentId === fin.id)).toBe(false);
    expect(getRun(live.app.db, run.id)?.status).toBe("aborted");
  });
});

/** 세션을 골라(또는 새로 만들어) 보낸다 — ack 의 메시지와 (서버가 고른·만든) 세션 */
async function sendIn(
  socket: WireClient,
  channelId: string,
  bodyMd: string,
  where: { conversationId: string } | { newConversation: { title: string } },
  threadRootId?: string,
): Promise<{ message: Message; conversation?: Conversation }> {
  const res = await socket.emitWithAck("message.send", {
    channelId,
    clientMsgId: randomUUID(),
    bodyMd,
    ...where,
    ...(threadRootId === undefined ? {} : { threadRootId }),
  });
  if (!res.ok) throw new Error(`message.send 실패: ${res.error.code} ${res.error.message}`);
  return res.data;
}

describe("통합 — 런과 에이전트가 세션 단위로", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  it("한 채널의 두 세션 — 세션 키가 따로, 맥락이 섞이지 않고, 병렬로 돌며, 스레드는 그 세션 안의 하위 키, 헤더 제목은 그 세션", async () => {
    live = await bootLiveApp();
    const { channel, dev } = await setupRelayChannel(live, { maxRelayTurns: 3, allowPairs: "all" });
    const log = await openChannelWire(live, channel.id, sockets);
    // dev 의 첫 인바운드(세션 A)는 델타까지만 — A 런이 도는 동안 B 런이 시작하는지 잰다
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: {
        dev: ({ index }) =>
          index === 0 ? { deltas: ["A 생각 중"], reply: "A", holdFinal: true } : { reply: "B 답" },
        fin: () => ({ reply: "fin" }),
      },
    });

    // 글의 seq 가 두 세션에 엇갈리게 — 채널 단위 질의면 B 의 맥락에 A 의 글이 섞인다
    const a = (await sendIn(log.socket, channel.id, "A 의 앞 글", { newConversation: { title: "세션 A" } }))
      .conversation;
    const b = (await sendIn(log.socket, channel.id, "B 의 앞 글", { newConversation: { title: "세션 B" } }))
      .conversation;
    if (!a || !b) throw new Error("세션이 없다");
    await sendIn(log.socket, channel.id, "A 의 둘째 글", { conversationId: a.id });

    const inA = await sendIn(log.socket, channel.id, "@dev A 질문", { conversationId: a.id });
    const runA = await log.until(
      () => log.states.find((s) => s.agentId === dev.id && s.status === "streaming"),
      "A 런 streaming",
    );
    expect(runA.conversationId).toBe(a.id);
    await sendIn(log.socket, channel.id, "@dev B 질문", { conversationId: b.id });
    const runB = await log.until(
      () => log.states.find((s) => s.agentId === dev.id && s.conversationId === b.id && s.status === "done"),
      "B 런 done",
    );
    // B 가 끝나는 동안 A 는 여전히 돈다 — 세션 큐가 따로다
    expect(getRun(live.app.db, runA.id)?.status).toBe("streaming");
    expect(runB.id).not.toBe(runA.id);

    const [turnA, turnB] = scenario.turns;
    expect(turnA?.delivery).toMatchObject({
      conversationId: a.id,
      conversationTitle: "세션 A",
      sessionKey: dodokSessionKey("dev", a.id),
    });
    expect(turnB?.delivery).toMatchObject({
      conversationId: b.id,
      conversationTitle: "세션 B",
      sessionKey: dodokSessionKey("dev", b.id),
    });
    // 헤더 줄은 플러그인이 이 값으로 만든다(packages/openclaw-plugin/src/context.ts)
    expect(formatSessionLine(turnB?.delivery.conversationTitle ?? "")).toBe("세션: 세션 B");
    expect(turnA?.delivery.context.recentMessages.map((m) => m.text)).toEqual(["A 의 앞 글", "A 의 둘째 글"]);
    expect(turnB?.delivery.context.recentMessages.map((m) => m.text)).toEqual(["B 의 앞 글"]);

    // 스레드는 그 세션 안의 하위 세션 — 루트는 A 의 글
    await sendIn(log.socket, channel.id, "@dev 스레드에서", { conversationId: a.id }, inA.message.id);
    const turnThread = await log.until(() => scenario.turns[2], "스레드 인바운드");
    expect(turnThread.delivery).toMatchObject({
      conversationId: a.id,
      threadId: inA.message.id,
      sessionKey: dodokSessionKey("dev", a.id, inA.message.id),
    });
  });

  it("릴레이는 같은 세션 안에서만 — 세션 A 의 에이전트 답은 A 에서, B 의 답은 B 에서 다음 에이전트를 깨운다", async () => {
    live = await bootLiveApp();
    const { channel, fin } = await setupRelayChannel(live, { maxRelayTurns: 3, allowPairs: "all" });
    const log = await openChannelWire(live, channel.id, sockets);
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: {
        dev: ({ delivery }) => ({ reply: `@fin 이어서 (${delivery.conversationTitle})` }),
        fin: () => ({ reply: "받았습니다" }),
      },
    });
    const a = (await sendIn(log.socket, channel.id, "@dev A 부탁", { newConversation: { title: "세션 A" } }))
      .conversation;
    if (!a) throw new Error("세션이 없다");
    await log.until(() => log.states.find((s) => s.agentId === fin.id && s.status === "done"), "A 의 fin 런");
    const b = (await sendIn(log.socket, channel.id, "@dev B 부탁", { newConversation: { title: "세션 B" } }))
      .conversation;
    if (!b) throw new Error("세션이 없다");
    await log.until(
      () => log.states.filter((s) => s.agentId === fin.id && s.status === "done").length >= 2 || undefined,
      "B 의 fin 런",
    );
    await scenario.idle();
    const finTurns = scenario.turns.filter((t) => t.agentId === "fin").map((t) => t.delivery);
    expect(finTurns.map((d) => [d.conversationId, d.sessionKey])).toEqual([
      [a.id, dodokSessionKey("fin", a.id)],
      [b.id, dodokSessionKey("fin", b.id)],
    ]);
    // fin 이 받은 트리거는 그 세션의 dev 답이다
    expect(finTurns.map((d) => d.message.text)).toEqual(["@fin 이어서 (세션 A)", "@fin 이어서 (세션 B)"]);
  });

  it("릴레이 대상은 답 메시지의 세션 — 다른 세션의 활동 시각이 더 늦어도(시계가 뒤로 감) 릴레이 런은 답이 난 세션에 생긴다", async () => {
    live = await bootLiveApp();
    const { channel, fin } = await setupRelayChannel(live, { maxRelayTurns: 3, allowPairs: "all" });
    const log = await openChannelWire(live, channel.id, sockets);
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: {
        dev: () => ({ reply: "@fin 이어서" }),
        fin: () => ({ reply: "받았습니다" }),
      },
    });
    const b = (await sendIn(log.socket, channel.id, "B 의 글", { newConversation: { title: "세션 B" } }))
      .conversation;
    if (!b) throw new Error("세션이 없다");
    // B 가 「최근 열린 대화」 1순위가 되게 — 릴레이가 그 함수로 자리를 고르면 fin 런이 B 로 간다
    live.app.db
      .update(conversations)
      .set({ lastMessageAt: new Date(Date.now() + 3600_000) })
      .where(eq(conversations.id, b.id))
      .run();
    const a = (await sendIn(log.socket, channel.id, "@dev A 부탁", { newConversation: { title: "세션 A" } }))
      .conversation;
    if (!a) throw new Error("세션이 없다");
    const finRun = await log.until(
      () => log.states.find((s) => s.agentId === fin.id && s.status === "done"),
      "fin 릴레이 런 done",
    );
    await scenario.idle();
    expect(finRun.conversationId).toBe(a.id);
    expect(log.states.some((s) => s.conversationId === b.id)).toBe(false);
    expect(scenario.turns.map((t) => [t.agentId, t.delivery.conversationId])).toEqual([
      ["dev", a.id],
      ["fin", a.id],
    ]);
  });

  it("리액션 사실은 그 세션 몫만 — 세션 A 의 에이전트 답에 단 리액션은 B 런에 실리지 않고 A 의 다음 런에 실린다", async () => {
    live = await bootLiveApp();
    const { channel, dev } = await setupRelayChannel(live, { maxRelayTurns: 3, allowPairs: "all" });
    const log = await openChannelWire(live, channel.id, sockets);
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: {
        dev: ({ delivery }) => ({ reply: `${delivery.conversationTitle} 의 답 ${delivery.message.text}` }),
        fin: () => ({ reply: "fin" }),
      },
    });
    const doneIn = (conversationId: string, n: number) =>
      log.until(
        () =>
          log.states.filter(
            (s) => s.agentId === dev.id && s.conversationId === conversationId && s.status === "done",
          ).length >= n || undefined,
        `dev 런 ${n}개 done`,
      );

    const a = (await sendIn(log.socket, channel.id, "@dev A 질문", { newConversation: { title: "세션 A" } }))
      .conversation;
    if (!a) throw new Error("세션이 없다");
    await doneIn(a.id, 1);
    // B 의 세션 행(리액션 커서)을 A 의 리액션보다 먼저 만든다 — 대화로 좁히지 않으면 B 의 커서 뒤 리액션으로 걸린다
    const b = (
      await sendIn(log.socket, channel.id, "@dev B 첫 질문", { newConversation: { title: "세션 B" } })
    ).conversation;
    if (!b) throw new Error("세션이 없다");
    await doneIn(b.id, 1);
    await scenario.idle();

    const answerA = live.app.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, a.id), eq(messages.authorType, "agent")))
      .get();
    if (!answerA) throw new Error("A 의 답이 없다");
    const reacted = await (log.socket.emitWithAck as (e: string, p: unknown) => Promise<{ ok: boolean }>)(
      "reaction.set",
      { messageId: answerA.id, emoji: "👍", on: true },
    );
    expect(reacted.ok).toBe(true);

    await sendIn(log.socket, channel.id, "@dev B 둘째 질문", { conversationId: b.id });
    await doneIn(b.id, 2);
    await sendIn(log.socket, channel.id, "@dev A 둘째 질문", { conversationId: a.id });
    await doneIn(a.id, 2);
    await scenario.idle();

    const devTurns = scenario.turns.filter((t) => t.agentId === "dev").map((t) => t.delivery);
    const second = (conversationId: string) => devTurns.filter((d) => d.conversationId === conversationId)[1];
    expect(second(b.id)?.context.reactions ?? []).toEqual([]);
    expect(second(a.id)?.context.reactions?.map((r) => [r.messageId, r.emoji])).toEqual([[answerA.id, "👍"]]);
  });

  it("[Review Focus 4] 세션 키가 A 인 정본이 같은 채널의 세션 B·다른 채널의 세션으로 오면 — 런이 있든 없든 FORBIDDEN, 저장하지 않는다", async () => {
    live = await bootLiveApp();
    const { channel, dev } = await setupRelayChannel(live, { maxRelayTurns: 3, allowPairs: "all" });
    const log = await openChannelWire(live, channel.id, sockets);
    createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: {
        dev: () => ({ deltas: ["생각 중"], reply: "끝", holdFinal: true }),
        fin: () => ({ reply: "fin" }),
      },
    });
    const a = (
      await sendIn(log.socket, channel.id, "@dev 붙잡아 둬", { newConversation: { title: "세션 A" } })
    ).conversation;
    const b = (await sendIn(log.socket, channel.id, "B 의 글", { newConversation: { title: "세션 B" } }))
      .conversation;
    if (!a || !b) throw new Error("세션이 없다");
    const runA = await log.until(
      () => log.states.find((s) => s.agentId === dev.id && s.status === "streaming"),
      "A 런 streaming",
    );
    const other = await rest<{ channel: { id: string } }>(live, "POST", "/channels", { name: "other" });
    const otherConversation = channelConversation(live.app.db, other.body.channel.id);
    const keyA = dodokSessionKey("dev", a.id);
    const storedFor = (outboundId: string) =>
      live.app.db.select().from(messages).where(eq(messages.externalId, outboundId)).all();

    for (const [label, conversationId] of [
      ["같은 채널의 다른 세션", b.id],
      ["채널 id", channel.id],
      ["다른 채널의 세션", otherConversation],
    ] as const) {
      for (const runId of [runA.id, undefined]) {
        const outboundId = `outside-${label}-${runId ?? "no-run"}`;
        await expect(
          live.plugin.sendOutbound({
            outboundId,
            conversationId,
            agentId: "dev",
            sessionKey: keyA,
            ...(runId === undefined ? {} : { runId }),
            text: "다른 대화에 씁니다",
            attachmentIds: [],
          }),
        ).rejects.toThrow("FORBIDDEN: 이 대화에만 보낼 수 있습니다");
        expect(storedFor(outboundId)).toEqual([]);
      }
    }
    expect(
      live.app.db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, b.id), eq(messages.authorType, "agent")))
        .all(),
    ).toEqual([]);
    // 런은 그대로 돈다 — 거절은 그 정본만
    expect(getRun(live.app.db, runA.id)?.status).toBe("streaming");
    // 세션 키의 대화로 오면 받는다(런 없는 정본 — 그 세션의 글)
    const ok = await live.plugin.sendOutbound({
      conversationId: a.id,
      agentId: "dev",
      sessionKey: keyA,
      text: "그 세션에",
      attachmentIds: [],
    });
    expect(ok.messageId).toBeDefined();
  });

  it("[Review Focus 4] 런 없는 정본은 서버가 그 에이전트에게 만든 세션의 키로만 — 대상에 맞춘 키·남의 세션 키·코어 sendText 꼴은 FORBIDDEN, 자기 세션의 늦은 글은 받는다", async () => {
    live = await bootLiveApp();
    const { channel, dev } = await setupRelayChannel(live, { maxRelayTurns: 3, allowPairs: "all" });
    // 코어 일반 전송(sendText)은 agentId 「unknown」으로 온다 — 그 id 로 등록된 에이전트가 있어도 세션이 없으면 막힌다
    const unknown = await rest(live, "POST", "/agents", {
      providerAgentId: "unknown",
      handle: "unknown",
      name: "Unknown",
      gatewayId: live.gatewayId,
    });
    expect(unknown.status).toBe(201);
    const log = await openChannelWire(live, channel.id, sockets);
    createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: {
        dev: ({ delivery }) =>
          delivery.message.text.includes("붙잡아")
            ? { deltas: ["생각 중"], reply: "끝", holdFinal: true }
            : { reply: "답" },
        fin: () => ({ reply: "fin" }),
      },
    });
    const created: Array<{ message: Message; silent?: true }> = [];
    live.app.bus.on("message.created", (p) => created.push(p));
    const doneRuns = () => log.states.filter((s) => s.agentId === dev.id && s.status === "done");
    const storedFor = (outboundId: string) =>
      live.app.db.select().from(messages).where(eq(messages.externalId, outboundId)).all();
    const runless = (
      outboundId: string,
      fields: { conversationId: string; agentId: string; sessionKey: string },
    ) => live.plugin.sendOutbound({ outboundId, ...fields, text: `${outboundId} 글`, attachmentIds: [] });

    const inA = await sendIn(log.socket, channel.id, "@dev A 질문", { newConversation: { title: "세션 A" } });
    const a = inA.conversation;
    if (!a) throw new Error("세션이 없다");
    await log.until(() => doneRuns().length >= 1 || undefined, "A 런 done");
    await sendIn(log.socket, channel.id, "@dev 스레드에서", { conversationId: a.id }, inA.message.id);
    await log.until(() => doneRuns().length >= 2 || undefined, "스레드 런 done");
    const keyA = dodokSessionKey("dev", a.id);
    const threadKeyA = dodokSessionKey("dev", a.id, inA.message.id);

    // 막힘 — 리뷰 실측 꼴: dev 가 멤버가 아닌 채널의 대화로, 그 대화로 만든 키(세션 키 없는 툴 호출을 플러그인이 `to` 로 채운 꼴)
    const otherX = await rest<{ channel: { id: string } }>(live, "POST", "/channels", { name: "other-x" });
    const otherConversation = channelConversation(live.app.db, otherX.body.channel.id);
    // 사례마다 결과를 모아 한 번에 견준다 — 하나가 새면 어느 것인지 diff 에 다 보이게
    const refusals: Array<[string, string, number]> = [];
    for (const [outboundId, fields] of [
      [
        "not-member",
        {
          conversationId: otherConversation,
          agentId: "dev",
          sessionKey: dodokSessionKey("dev", otherConversation),
        },
      ],
      // 남의 세션 키 — 그 세션 행의 에이전트(dev)가 정본의 에이전트(fin)가 아니다
      ["others-key", { conversationId: a.id, agentId: "fin", sessionKey: keyA }],
      [
        "send-text",
        { conversationId: a.id, agentId: "unknown", sessionKey: dodokSessionKey("unknown", a.id) },
      ],
    ] as const) {
      const outcome = await runless(outboundId, fields).then(
        () => "stored",
        (err: Error) => err.message,
      );
      refusals.push([outboundId, outcome, storedFor(outboundId).length]);
    }
    const refused = "FORBIDDEN: 이 대화에만 보낼 수 있습니다";
    expect(refusals).toEqual([
      ["not-member", refused, 0],
      ["others-key", refused, 0],
      ["send-text", refused, 0],
    ]);

    // 통과 — 런이 끝난 뒤 자기 세션·자기 스레드 하위 세션으로 온 늦은 글
    const late = await runless("late-own", { conversationId: a.id, agentId: "dev", sessionKey: keyA });
    expect(storedFor("late-own")).toEqual([
      expect.objectContaining({ id: late.messageId, conversationId: a.id, authorId: dev.id, runId: null }),
    ]);
    const lateThread = await live.plugin.sendOutbound({
      outboundId: "late-thread",
      conversationId: a.id,
      threadId: inA.message.id,
      agentId: "dev",
      sessionKey: threadKeyA,
      text: "스레드에 늦게",
      attachmentIds: [],
    });
    expect(storedFor("late-thread")).toEqual([
      expect.objectContaining({ id: lateThread.messageId, threadRootId: inA.message.id, runId: null }),
    ]);

    // 통과 — 런이 열린 동안은 런 갈래(세션의 미종료 런에 붙는다)
    const hold = await sendIn(log.socket, channel.id, "@dev 붙잡아 둬", { conversationId: a.id });
    const held = await log.until(() => {
      const run = live.app.db.select().from(runs).where(eq(runs.triggerMessageId, hold.message.id)).get();
      return run?.status === "streaming" ? run : undefined;
    }, "붙잡은 런 streaming");
    await runless("while-open", { conversationId: a.id, agentId: "dev", sessionKey: keyA });
    expect(storedFor("while-open")).toEqual([expect.objectContaining({ runId: held.id })]);

    // 통과 — 닫힌 자기 세션의 늦은 글은 저장만(silent)
    const closed = await rest(live, "PATCH", `/conversations/${a.id}`, { closed: true });
    expect(closed.status).toBe(200);
    await log.terminal(held.id);
    const inClosed = await runless("closed-own", { conversationId: a.id, agentId: "dev", sessionKey: keyA });
    expect(created.find((p) => p.message.id === inClosed.messageId)?.silent).toBe(true);

    // 통과 — 보관한 채널의 자기 세션 늦은 글도 저장만(silent)
    const b = (await sendIn(log.socket, channel.id, "@dev B 질문", { newConversation: { title: "세션 B" } }))
      .conversation;
    if (!b) throw new Error("세션이 없다");
    await log.until(
      () => log.states.find((s) => s.agentId === dev.id && s.conversationId === b.id && s.status === "done"),
      "B 런 done",
    );
    const archived = await rest(live, "POST", `/channels/${channel.id}/archive`);
    expect(archived.status).toBe(200);
    const inArchived = await runless("archived-own", {
      conversationId: b.id,
      agentId: "dev",
      sessionKey: dodokSessionKey("dev", b.id),
    });
    expect(created.find((p) => p.message.id === inArchived.messageId)?.silent).toBe(true);
  });

  it("[에이전트 DM 스펙 4장] DM 과 일반 채널 사이 — DM 런의 정본이 채널 대화로, 채널 런의 정본이 DM 대화로 오면 FORBIDDEN·저장 0, 런 없는 정본은 세션 행 규칙", async () => {
    live = await bootLiveApp();
    const { channel, dev } = await setupRelayChannel(live, { maxRelayTurns: 3, allowPairs: "all" });
    const opened = await rest<{ channel: Channel }>(live, "POST", "/dms", { agentId: dev.id });
    expect(opened.status).toBe(200);
    const dm = opened.body.channel;
    const log = await openChannelWire(live, channel.id, sockets);
    const dmLog = await openChannelWire(live, dm.id, sockets);
    const delivered: Array<{ conversationId: string; dm?: { ownerHandle: string } }> = [];
    createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: {
        dev: ({ delivery }) => {
          delivered.push({
            conversationId: delivery.conversationId,
            ...(delivery.dm ? { dm: delivery.dm } : {}),
          });
          return { deltas: ["생각 중"], reply: "끝", holdFinal: true };
        },
        fin: () => ({ reply: "fin" }),
      },
    });
    // DM 은 멘션 없이도 그 에이전트의 런이 된다(계획 PD6)
    const inDm = (await sendIn(dmLog.socket, dm.id, "붙잡아 둬", { newConversation: { title: "DM 세션" } }))
      .conversation;
    const inChannel = (
      await sendIn(log.socket, channel.id, "@dev 붙잡아 둬", { newConversation: { title: "채널 세션" } })
    ).conversation;
    if (!inDm || !inChannel) throw new Error("세션이 없다");
    const dmRun = await dmLog.until(
      () => dmLog.states.find((s) => s.agentId === dev.id && s.status === "streaming"),
      "DM 런 streaming",
    );
    const channelRun = await log.until(
      () => log.states.find((s) => s.agentId === dev.id && s.status === "streaming"),
      "채널 런 streaming",
    );
    const owner = live.app.db
      .select({ handle: users.handle })
      .from(users)
      .where(eq(users.id, dm.dmOwnerId ?? ""))
      .get();
    expect(delivered).toEqual([
      { conversationId: inDm.id, dm: { ownerHandle: owner?.handle } },
      { conversationId: inChannel.id },
    ]);

    const dmKey = dodokSessionKey("dev", inDm.id);
    const channelKey = dodokSessionKey("dev", inChannel.id);
    const storedFor = (outboundId: string) =>
      live.app.db.select().from(messages).where(eq(messages.externalId, outboundId)).all();
    // 사례마다 결과를 모아 한 번에 견준다 — 하나가 새면 어느 것인지 diff 에 다 보이게
    const outcomes: Array<[string, string, number]> = [];
    for (const [label, fields] of [
      // 런의 세션 키는 DM, 대상은 일반 채널 대화 — 런이 있든 없든
      [
        "dm→channel run",
        { conversationId: inChannel.id, agentId: "dev", sessionKey: dmKey, runId: dmRun.id },
      ],
      ["dm→channel no-run", { conversationId: inChannel.id, agentId: "dev", sessionKey: dmKey }],
      // 런의 세션 키는 일반 채널, 대상은 DM 대화
      [
        "channel→dm run",
        { conversationId: inDm.id, agentId: "dev", sessionKey: channelKey, runId: channelRun.id },
      ],
      ["channel→dm no-run", { conversationId: inDm.id, agentId: "dev", sessionKey: channelKey }],
      // 런 없는 정본 — DM 대화로 만든 키지만 그 에이전트(fin)에게 서버가 만든 세션 행이 없다
      [
        "fin dm-key",
        { conversationId: inDm.id, agentId: "fin", sessionKey: dodokSessionKey("fin", inDm.id) },
      ],
    ] as const) {
      const outboundId = `dm-boundary-${label}`;
      const outcome = await live.plugin
        .sendOutbound({ outboundId, ...fields, text: "경계를 넘습니다", attachmentIds: [] })
        .then(
          () => "stored",
          (err: Error) => err.message,
        );
      outcomes.push([label, outcome, storedFor(outboundId).length]);
    }
    const refused = "FORBIDDEN: 이 대화에만 보낼 수 있습니다";
    expect(outcomes).toEqual([
      ["dm→channel run", refused, 0],
      ["dm→channel no-run", refused, 0],
      ["channel→dm run", refused, 0],
      ["channel→dm no-run", refused, 0],
      ["fin dm-key", refused, 0],
    ]);
    // 두 런은 그대로 돈다 — 거절은 그 정본만. 자기 DM 세션으로 온 정본은 그 런에 붙는다
    expect(getRun(live.app.db, dmRun.id)?.status).toBe("streaming");
    expect(getRun(live.app.db, channelRun.id)?.status).toBe("streaming");
    await live.plugin.sendOutbound({
      outboundId: "dm-own",
      conversationId: inDm.id,
      agentId: "dev",
      sessionKey: dmKey,
      text: "DM 에",
      attachmentIds: [],
    });
    expect(storedFor("dm-own")).toEqual([
      expect.objectContaining({ conversationId: inDm.id, channelId: dm.id, runId: dmRun.id }),
    ]);

    // 런 없는 정본 — DM 의 세션 키를 다른 에이전트(fin)가 댄다. 그 키에 열린 런이 있으면 런 갈래(그 런의 에이전트 글)라 세션 행
    // 규칙에 닿지 않으므로, DM 세션을 닫아 런을 끝낸 뒤에 본다
    const closed = await rest(live, "PATCH", `/conversations/${inDm.id}`, { closed: true });
    expect(closed.status).toBe(200);
    await dmLog.terminal(dmRun.id);
    const othersKey = await live.plugin
      .sendOutbound({
        outboundId: "dm-boundary-fin-others-dm-key",
        conversationId: inDm.id,
        agentId: "fin",
        sessionKey: dmKey,
        text: "남의 DM 키로",
        attachmentIds: [],
      })
      .then(
        () => "stored",
        (err: Error) => err.message,
      );
    expect([othersKey, storedFor("dm-boundary-fin-others-dm-key").length]).toEqual([refused, 0]);
  });
});

/** 사람 하나의 REST(세션 토큰) — `rest` 는 owner 만 */
async function restAs<T = unknown>(
  live: LiveApp,
  token: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: object,
): Promise<{ status: number; body: T }> {
  const res = await live.app.fastify.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: (res.body === "" ? undefined : res.json()) as T };
}

type Listed = { conversations: Conversation[] };
const bodiesOf = (page: { messages: Message[] }) => page.messages.map((m) => m.bodyMd);

describe("통합 — 완료 기준(스펙 9장)", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];
  type Sent = { payload: PushPayload };
  let pushed: Sent[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  /** 가짜 발송기는 wire 이벤트가 아니다 — 짧게 되풀이해 본다(상한은 실패를 드러내는 용도) */
  async function untilMentions(n: number): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (pushed.filter((p) => p.payload.kind === "mention").length < n) {
      if (Date.now() > deadline) throw new Error(`멘션 푸시 ${n}건을 기다렸는데 ${pushed.length}건`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("[완료 기준 1] 한 채널의 세션 여럿 — 메시지가 세션마다 따로 쌓이고, 같은 에이전트가 세션마다 그 세션 글만 맥락으로 답한다", async () => {
    live = await bootLiveApp();
    const { channel, dev } = await setupRelayChannel(live, { maxRelayTurns: 3, allowPairs: "all" });
    const log = await openChannelWire(live, channel.id, sockets);
    // 답에 받은 맥락을 그대로 싣는다 — 다른 세션 글이 섞이면 답 본문에 보인다
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: {
        dev: ({ delivery }) => ({
          reply: `맥락: ${delivery.context.recentMessages.map((m) => m.text).join(" / ")}`,
        }),
        fin: () => ({ reply: "fin" }),
      },
    });

    const opened = [
      { title: "배포", first: "배포는 금요일", ask: "@dev 배포 언제?" },
      { title: "휴가", first: "휴가는 다음 주", ask: "@dev 휴가 언제?" },
      { title: "점심", first: "점심은 국수", ask: "@dev 점심 뭐?" },
    ];
    const ids: string[] = [];
    for (const s of opened) {
      const made = await sendIn(log.socket, channel.id, s.first, { newConversation: { title: s.title } });
      if (!made.conversation) throw new Error("세션이 없다");
      ids.push(made.conversation.id);
    }
    for (const [i, s] of opened.entries())
      await sendIn(log.socket, channel.id, s.ask, { conversationId: ids[i] as string });
    const replies = await log.until(() => {
      const got = log.created.filter((m) => m.authorType === "agent" && m.authorId === dev.id);
      return got.length === opened.length && got;
    }, "dev 답 셋");
    await scenario.idle();

    const listed = await rest<Listed>(live, "GET", `/channels/${channel.id}/conversations?status=open`);
    expect(listed.body.conversations.map((c) => c.title).sort()).toEqual(["배포", "점심", "휴가"]);
    for (const [i, s] of opened.entries()) {
      const id = ids[i] as string;
      const reply = replies.find((m) => m.conversationId === id);
      // 그 세션의 첫 글만 맥락 — 다른 두 세션의 글은 없다
      expect(reply?.bodyMd).toBe(`맥락: ${s.first}`);
      const page = await rest<{ messages: Message[] }>(live, "GET", `/conversations/${id}/messages`);
      expect(page.status).toBe(200);
      // 멘션은 저장 때 토큰이 된다(`<@a:<id>>`)
      expect(bodiesOf(page.body)).toEqual([
        s.first,
        s.ask.replace("@dev", `<@a:${dev.id}>`),
        `맥락: ${s.first}`,
      ]);
      expect(page.body.messages.every((m) => m.conversationId === id)).toBe(true);
    }
    // 같은 에이전트의 세션 키가 세션마다 따로
    const keys = scenario.turns.map((t) => t.delivery.sessionKey);
    expect(new Set(keys).size).toBe(opened.length);
    expect(keys.sort()).toEqual(ids.map((id) => dodokSessionKey("dev", id)).sort());
    expect(scenario.errors).toEqual([]);
  });

  it("[완료 기준 2] 닫힌 세션은 읽기만(보내기·리액션 409) 되고 다시 열 수 있다 — 목록의 열림·닫힘 필터와 제목 검색으로 찾는다", async () => {
    live = await bootLiveApp();
    const { channel } = await setupRelayChannel(live, { maxRelayTurns: 3, allowPairs: "all" });
    const log = await openChannelWire(live, channel.id, sockets);
    const retro = await sendIn(log.socket, channel.id, "회고 첫 글", {
      newConversation: { title: "배포 회고" },
    });
    const lunch = await sendIn(log.socket, channel.id, "국수?", { newConversation: { title: "점심 메뉴" } });
    const retroId = retro.conversation?.id as string;
    const lunchId = lunch.conversation?.id as string;
    const list = (query: string) =>
      rest<Listed>(live, "GET", `/channels/${channel.id}/conversations?${query}`).then((r) =>
        r.body.conversations.map((c) => c.id),
      );

    const closed = await rest(live, "PATCH", `/conversations/${retroId}`, { closed: true });
    expect(closed.status).toBe(200);
    expect(await list("status=open")).toEqual([lunchId]);
    expect(await list("status=closed")).toEqual([retroId]);
    // 제목 부분 일치·대소문자 무시는 목록 q — 닫힌 세션도 그 필터로 찾는다
    expect(await list("status=closed&q=회고")).toEqual([retroId]);
    expect(await list("status=closed&q=점심")).toEqual([]);
    expect(await list("status=all&q=메뉴")).toEqual([lunchId]);

    // 읽기는 된다 — 첫 글과 닫기 시스템 메시지
    const page = await rest<{ messages: Message[] }>(live, "GET", `/conversations/${retroId}/messages`);
    expect(page.status).toBe(200);
    expect(bodiesOf(page.body)[0]).toBe("회고 첫 글");
    expect(page.body.messages.at(-1)?.bodyMd).toMatch(/이 세션을 닫았습니다$/);
    // 쓰기는 409 — 보내기·리액션
    const send = await log.socket.emitWithAck("message.send", {
      channelId: channel.id,
      conversationId: retroId,
      clientMsgId: randomUUID(),
      bodyMd: "닫힌 뒤 글",
    });
    expect(send).toMatchObject({ ok: false, error: { code: "CONVERSATION_CLOSED" } });
    const react = await log.socket.emitWithAck("reaction.set", {
      messageId: retro.message.id,
      emoji: REACTION_EMOJIS[0],
      on: true,
    });
    expect(react).toMatchObject({ ok: false, error: { code: "CONVERSATION_CLOSED" } });

    // 다시 열면 열림 목록에 돌아오고 쓸 수 있다
    expect((await rest(live, "PATCH", `/conversations/${retroId}`, { closed: false })).status).toBe(200);
    expect((await list("status=open")).sort()).toEqual([lunchId, retroId].sort());
    expect(await list("status=closed")).toEqual([]);
    const after = await sendIn(log.socket, channel.id, "다시 연 뒤 글", { conversationId: retroId });
    expect(after.message.conversationId).toBe(retroId);
    const reopened = await rest<{ messages: Message[] }>(live, "GET", `/conversations/${retroId}/messages`);
    expect(bodiesOf(reopened.body).slice(-2)).toEqual([
      expect.stringMatching(/이 세션을 다시 열었습니다$/),
      "다시 연 뒤 글",
    ]);
  });

  it("[완료 기준 3] 정책 「세션 관리자만」 — member 는 새 세션을 못 만들고, 세션 관리자는 만들고 남의 세션도 닫는다. 해제하면 다시 못 만든다", async () => {
    live = await bootLiveApp();
    const { channel } = await setupRelayChannel(live, { maxRelayTurns: 3, allowPairs: "all" });
    const owner = await openChannelWire(live, channel.id, sockets);
    const mia = await userWithRole(live.app, "mia", "member");
    const noa = await userWithRole(live.app, "noa", "member");
    const miaWire = await connectWire(live.app, mia.token);
    sockets.push(miaWire);
    const newSession = (socket: WireClient, title: string) =>
      socket.emitWithAck("message.send", {
        channelId: channel.id,
        newConversation: { title },
        clientMsgId: randomUUID(),
        bodyMd: `${title} 첫 글`,
      });

    const ownerSession = (
      await sendIn(owner.socket, channel.id, "owner 의 글", { newConversation: { title: "owner 세션" } })
    ).conversation?.id as string;
    const policy = await rest<{ channel: Channel }>(live, "PATCH", `/channels/${channel.id}`, {
      sessionPolicy: { create: "managers" },
    });
    expect(policy.body.channel.sessionPolicy).toEqual({ create: "managers" });

    expect(await newSession(miaWire, "mia 시도")).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    // 열린 세션에 쓰는 것은 정책과 무관하다
    expect(
      (await sendIn(miaWire, channel.id, "mia 의 답", { conversationId: ownerSession })).message.authorId,
    ).toBe(mia.id);

    const promoted = await restAs<{ member: ChannelMember }>(
      live,
      live.auth.token,
      "PUT",
      `/channels/${channel.id}/session-managers/${mia.id}`,
    );
    expect(promoted.body.member).toMatchObject({ memberId: mia.id, role: "manager" });
    const made = await newSession(miaWire, "mia 세션");
    if (!made.ok) throw new Error(`세션 관리자 새 세션 실패: ${made.error.code}`);
    const miaSession = made.data.conversation?.id as string;
    expect(made.data.conversation).toMatchObject({
      title: "mia 세션",
      createdBy: { type: "user", id: mia.id },
    });
    // 남의 세션 — 세션 관리자는 닫고, 그냥 member 는 못 닫는다
    expect(
      (await restAs(live, noa.token, "PATCH", `/conversations/${ownerSession}`, { closed: true })).status,
    ).toBe(403);
    expect(
      (await restAs(live, mia.token, "PATCH", `/conversations/${ownerSession}`, { closed: true })).status,
    ).toBe(200);
    expect(
      (await restAs(live, mia.token, "PATCH", `/conversations/${miaSession}`, { closed: true })).status,
    ).toBe(200);
    // member 는 세션 관리자를 못 정한다(admin 이상)
    expect(
      (await restAs(live, noa.token, "PUT", `/channels/${channel.id}/session-managers/${noa.id}`)).status,
    ).toBe(403);

    expect(
      (await restAs(live, live.auth.token, "DELETE", `/channels/${channel.id}/session-managers/${mia.id}`))
        .status,
    ).toBe(200);
    expect(await newSession(miaWire, "해제 뒤")).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const titles = (
      await rest<Listed>(live, "GET", `/channels/${channel.id}/conversations?status=all`)
    ).body.conversations.map((c) => c.title);
    expect(titles.sort()).toEqual(["mia 세션", "owner 세션"]);
  });

  it("[완료 기준 4] 읽지 않음·검색·푸시 링크가 세션을 가리킨다 — 같은 채널 두 세션의 현황이 따로, 결과·알림 URL 은 그 세션", async () => {
    pushed = [];
    live = await bootLiveApp({
      deps: {
        pushSend: async (_sub, body) => {
          pushed.push({ payload: PushPayload.parse(JSON.parse(body)) });
          return { statusCode: 201 };
        },
      },
    });
    const { channel } = await setupRelayChannel(live, { maxRelayTurns: 3, allowPairs: "all" });
    const log = await openChannelWire(live, channel.id, sockets);
    const subscribed = await live.app.fastify.inject({
      method: "POST",
      url: "/api/v1/push/subscriptions",
      headers: live.auth.headers,
      payload: { endpoint: "https://push.invalid/sessions-owner", keys: PUSH_KEYS },
    });
    expect(subscribed.statusCode).toBe(204);
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: { dev: () => ({ reply: "@owner 확인했습니다" }), fin: () => ({ reply: "fin" }) },
    });
    const mia = await userWithRole(live.app, "mia", "member");
    const a = (await sendIn(log.socket, channel.id, "세션 A 의 공지", { newConversation: { title: "공지" } }))
      .conversation?.id as string;
    const bConv = await sendIn(log.socket, channel.id, "@mia 견적서 검토 부탁", {
      newConversation: { title: "견적" },
    });
    const b = bConv.conversation?.id as string;

    // 읽지 않음 — 세션마다 따로(A 는 굵게만, B 는 mia 멘션 배지)
    type Snapshot = {
      conversations: Array<{ conversationId: string; channelId: string; unread: boolean; mentions: number }>;
    };
    const unread = async () =>
      (await restAs<Snapshot>(live, mia.token, "GET", "/me/unread")).body.conversations.filter(
        (c) => c.channelId === channel.id,
      );
    expect((await unread()).sort((x, y) => x.conversationId.localeCompare(y.conversationId))).toEqual(
      [
        { conversationId: a, channelId: channel.id, unread: true, mentions: 0 },
        { conversationId: b, channelId: channel.id, unread: true, mentions: 1 },
      ]
        .sort((x, y) => x.conversationId.localeCompare(y.conversationId))
        .map((e) => expect.objectContaining(e)),
    );
    // A 끝까지 읽어도 B 는 남는다(seq 는 채널 하나의 번호 — B 의 글이 A 의 글보다 뒤다)
    const miaWire = await connectWire(live.app, mia.token);
    sockets.push(miaWire);
    const lastSeq = Math.max(...log.created.map((m) => m.seq));
    const read = await miaWire.emitWithAck("conversation.read", { conversationId: a, seq: lastSeq });
    expect(read.ok).toBe(true);
    expect(await unread()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: a, unread: false, mentions: 0 }),
        expect.objectContaining({ conversationId: b, unread: true, mentions: 1 }),
      ]),
    );

    // 검색 — 결과가 세션과 그 제목을 싣고, 세션으로 거른다
    const search = (query: string) =>
      rest<{ hits: Array<{ messageId: string; conversationId: string; conversationTitle: string }> }>(
        live,
        "GET",
        `/search?${query}`,
      ).then((r) => r.body.hits);
    expect(await search("q=견적서")).toEqual([
      expect.objectContaining({ messageId: bConv.message.id, conversationId: b, conversationTitle: "견적" }),
    ]);
    expect(await search(`q=견적서&conversationId=${a}`)).toEqual([]);

    // 푸시 링크 — 세션 B 의 최상위 답은 /s/<B>, 그 세션 스레드의 답은 /s/<B>/t/<root>
    await sendIn(log.socket, channel.id, "@dev 봐줘", { conversationId: b });
    await untilMentions(1);
    await sendIn(log.socket, channel.id, "@dev 스레드에서", { conversationId: b }, bConv.message.id);
    await untilMentions(2);
    await scenario.idle();
    expect(pushed.filter((p) => p.payload.kind === "mention").map((p) => p.payload.url)).toEqual([
      `/c/${channel.id}/s/${b}`,
      `/c/${channel.id}/s/${b}/t/${bConv.message.id}`,
    ]);
  });
});

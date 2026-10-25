/**
 * 채널 세션 — 세션 닫기(스펙 「세션 만들기·닫기」 절·「오류 처리」 장)와 런·에이전트가 세션 단위로 도는 것(「누가 답하나」·「에이전트가
 * 받는 것」 절). 실제 서버(실제 OpenClawAdapter) + 가짜 Gateway + 가짜 플러그인 + wire 클라이언트.
 * 닫는 순간 도는 런은 멈추고(가짜 Gateway 에 chat.abort), 그 뒤 온 늦은 정본은 그 세션에 저장만 된다(릴레이·푸시 없음).
 * 한 채널의 두 세션은 세션 키·맥락이 따로이고 병렬로 돌며, 릴레이는 그 세션 안에서만 잇고, 세션 키의 대화 밖으로 온 정본은 저장하지 않는다
 */
import { randomUUID } from "node:crypto";
import { type Conversation, dodokSessionKey, formatSessionLine, type Message } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messages } from "../../src/db/schema.sqlite";
import { getRun } from "../../src/modules/runs/store";
import { createScenario } from "../fakes/scenario";
import { bootLiveApp, type LiveApp } from "../helpers/live-app";
import { openChannelWire, rest, sendMessage, setupRelayChannel } from "../helpers/scenario-steps";
import { channelConversation } from "../helpers/seed";
import type { WireClient } from "../helpers/wire";

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
});

/**
 * 채널 세션 계획 태스크 3 — 세션 닫기(스펙 「세션 만들기·닫기」 절·「오류 처리」 장). 실제 서버(실제 OpenClawAdapter) + 가짜 Gateway + 가짜 플러그인 + wire 클라이언트.
 * 닫는 순간 도는 런은 멈추고(가짜 Gateway 에 chat.abort), 그 뒤 온 늦은 정본은 그 세션에 저장만 된다(릴레이·푸시 없음)
 */
import type { Message } from "@dodok/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRun } from "../../src/modules/runs/store";
import { createScenario } from "../fakes/scenario";
import { bootLiveApp, type LiveApp } from "../helpers/live-app";
import { openChannelWire, rest, sendMessage, setupRelayChannel } from "../helpers/scenario-steps";
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

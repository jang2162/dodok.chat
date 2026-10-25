/**
 * 리액션 계획 태스크 2 — wire reaction.set·다음 런에 싣기·커서(계획 docs/superpowers/plans/2026-10-05-reactions.md 「계획 판정」 절
 * PR1, Review Focus 2·3·4). 실제 서버(실제 OpenClawAdapter) + 가짜 Gateway·플러그인 + wire 클라이언트 둘(owner·mia). 러너 사례는
 * 가짜 러너가 받은 RunnerRunStart.deliver 까지만 본다 — 턴 사실 블록은 러너 어댑터 쪽이다. 기다림은 wire 이벤트(WireLog.until)로 한다.
 */
import {
  type Agent,
  type Channel,
  type InboundDeliver,
  IssueRunnerTokenResult,
  type Message,
  REACTION_EMOJIS,
  type ReactionEmoji,
  type Result,
  type RunState,
} from "@dodok/shared";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSystemMessage } from "../../src/modules/messages/service";
import { LIMITS } from "../../src/modules/ops/limits";
import { type FakeRunner, startFakeRunner } from "../fakes/fake-runner";
import { createScenario, type Scenario } from "../fakes/scenario";
import { userWithRole } from "../helpers/app";
import { bootLiveApp, type LiveApp, type LiveAppOptions, waitForAdapterConnected } from "../helpers/live-app";
import {
  openChannelWire,
  recordWire,
  rest,
  sendMessage,
  setupRelayChannel,
  subscribe,
  type WireLog,
} from "../helpers/scenario-steps";
import { connectWire, type WireClient } from "../helpers/wire";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const RELAY_POLICY = { maxRelayTurns: 3, allowPairs: "all" as const };
const OK = { ok: true, data: null };

type Started = {
  channel: Channel;
  dev: Agent;
  owner: WireLog;
  mia: WireLog;
  miaId: string;
  scenario: Scenario;
};

type Turn = { run: RunState; answer: Message | undefined; delivery: InboundDeliver | undefined };

describe("통합 — 리액션", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];
  const runners: FakeRunner[] = [];

  afterEach(async () => {
    for (const runner of runners.splice(0)) runner.close();
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  /** 채널(dev·fin) + owner·mia 가 구독한 소켓 + dev 는 받은 차례대로 「답 n」 */
  async function start(opts: LiveAppOptions = {}): Promise<Started> {
    live = await bootLiveApp(opts);
    const { channel, dev } = await setupRelayChannel(live, RELAY_POLICY);
    const owner = await openChannelWire(live, channel.id, sockets);
    const mia = await openUserWire(channel.id, "mia");
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: { dev: ({ index }) => ({ reply: `답 ${index} — 배포 순서는 먼저 DB 마이그레이션` }) },
    });
    return { channel, dev, owner, mia: mia.log, miaId: mia.id, scenario };
  }

  async function openUserWire(channelId: string, handle: string): Promise<{ id: string; log: WireLog }> {
    const user = await userWithRole(live.app, handle, "member");
    const socket = await connectWire(live.app, user.token);
    sockets.push(socket);
    const log = recordWire(socket);
    await subscribe(socket, channelId);
    return { id: user.id, log };
  }

  const react = (log: WireLog, messageId: string, emoji: string, on = true): Promise<Result<null>> =>
    (log.socket.emitWithAck as (e: string, p: unknown) => Promise<Result<null>>)("reaction.set", {
      messageId,
      emoji,
      on,
    });

  /** 같은 연결의 ack 왕복 — 그 전에 서버가 이 소켓에 보낸 이벤트는 모두 도착해 있다 */
  const roundTrip = (log: WireLog) =>
    log.socket.emitWithAck("channel.unsubscribe", { channelId: randomUUID() });

  /** owner 가 보낸 글 하나로 생긴 런 하나를 끝까지 — 플러그인이 받은 인바운드(못 받았으면 undefined)와 답(끝났을 때만) */
  async function turn(
    t: Pick<Started, "owner" | "channel">,
    body: string,
    threadRootId?: string,
  ): Promise<Turn> {
    const seen = new Set(t.owner.states.map((s) => s.id));
    await sendMessage(t.owner.socket, t.channel.id, body, threadRootId === undefined ? {} : { threadRootId });
    const started = await t.owner.until(() => t.owner.states.find((s) => !seen.has(s.id)), `「${body}」 런`);
    const run = await t.owner.terminal(started.id);
    const answer =
      run.status === "done"
        ? await t.owner.until(
            () => t.owner.created.find((m) => m.authorType === "agent" && m.runId === run.id),
            `「${body}」 답`,
          )
        : undefined;
    return { run, answer, delivery: live.plugin.received.find((d) => d.runId === run.id) };
  }

  /** 인바운드에 실린 리액션 — `by emoji 메시지 id` */
  const facts = (delivery: InboundDeliver | undefined) =>
    delivery?.context.reactions?.map((r) => `${r.by} ${r.emoji} ${r.messageId}`);

  it("mia 가 에이전트 답에 👍 → owner·mia 둘 다 message.updated(👍 1), 같은 요청 다시는 이벤트 없음 → 다음 멘션 런에 실리고 그다음 런에는 없다", async () => {
    const t = await start();
    const { answer } = await turn(t, "@dev 배포 순서 알려줘");
    if (!answer) throw new Error("답이 없다");

    expect(await react(t.mia, answer.id, "👍")).toEqual(OK);
    for (const log of [t.owner, t.mia]) {
      const updated = await log.until(
        () => log.updated.find((m) => m.id === answer.id && m.reactions.length > 0),
        "👍 message.updated",
      );
      expect(updated.reactions).toEqual([{ emoji: "👍", count: 1, userIds: [t.miaId] }]);
    }
    expect(await react(t.mia, answer.id, "👍")).toEqual(OK);
    await roundTrip(t.owner);
    await roundTrip(t.mia);
    for (const log of [t.owner, t.mia]) expect(log.updated.filter((m) => m.id === answer.id)).toHaveLength(1);

    const next = await turn(t, "@dev 다음은?");
    expect(next.delivery?.context.reactions).toEqual([
      {
        messageId: answer.id,
        excerpt: "답 0 — 배포 순서는 먼저 DB 마이그레이션",
        emoji: "👍",
        by: "mia",
        at: expect.any(String),
      },
    ]);
    expect(next.delivery?.context.reactionsOmitted).toBeUndefined();
    const after = await turn(t, "@dev 또?");
    expect(after.delivery?.context.reactions).toBeUndefined();
    expect(t.scenario.errors).toEqual([]);
  });

  it("끄면 아직 알리지 않은 리액션은 다음 런에 실리지 않는다", async () => {
    const t = await start();
    const { answer } = await turn(t, "@dev 처음");
    if (!answer) throw new Error("답이 없다");
    expect(await react(t.mia, answer.id, "👍")).toEqual(OK);
    expect(await react(t.mia, answer.id, "👍", false)).toEqual(OK);
    expect((await turn(t, "@dev 다음")).delivery?.context.reactions).toBeUndefined();
  });

  it("인바운드가 플러그인에 닿은 뒤 ack 전에 중지한 런은 커서를 올리지 않는다 — 다음 런에 다시 실린다(Review Focus 2)", async () => {
    const t = await start();
    const { answer } = await turn(t, "@dev 처음");
    if (!answer) throw new Error("답이 없다");
    expect(await react(t.mia, answer.id, "👍")).toEqual(OK);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const play = live.plugin.onInbound;
    live.plugin.onInbound = async (delivery) => {
      await gate;
      return play(delivery);
    };
    const seen = new Set(t.owner.states.map((s) => s.id));
    await sendMessage(t.owner.socket, t.channel.id, "@dev 멈출 거야");
    const run = await t.owner.until(() => t.owner.states.find((s) => !seen.has(s.id)), "멈출 런");
    await vi.waitFor(() => expect(live.plugin.received.some((d) => d.runId === run.id)).toBe(true));
    expect(facts(live.plugin.received.find((d) => d.runId === run.id))).toEqual([`mia 👍 ${answer.id}`]);

    expect(await t.owner.socket.emitWithAck("run.abort", { runId: run.id })).toEqual(OK);
    expect((await t.owner.terminal(run.id)).status).toBe("aborted");
    release();
    live.plugin.onInbound = play;
    await t.scenario.idle();

    expect(facts((await turn(t, "@dev 다시")).delivery)).toEqual([`mia 👍 ${answer.id}`]);
  });

  it("플러그인이 끊겨 send 가 실패한 런은 커서를 올리지 않는다 — 다시 붙은 뒤 다음 런에 실린다", async () => {
    const t = await start({ timeouts: { queuedMs: 500 } });
    const { answer } = await turn(t, "@dev 처음");
    if (!answer) throw new Error("답이 없다");
    expect(await react(t.mia, answer.id, "👍")).toEqual(OK);

    live.plugin.disconnect();
    await t.owner.until(() => t.owner.adapterStatus.find((s) => s.bridge === "down"), "bridge down");
    const failed = await turn(t, "@dev 안 닿음");
    expect(failed.run).toMatchObject({ status: "error", error: { code: "ADAPTER_UNAVAILABLE" } });
    expect(failed.delivery).toBeUndefined();

    await live.plugin.reconnect();
    await waitForAdapterConnected(live.app);
    expect(facts((await turn(t, "@dev 다시")).delivery)).toEqual([`mia 👍 ${answer.id}`]);
  });

  it("에이전트 답이 스레드 루트 — 루트 리액션은 스레드·채널 두 세션 모두에, 스레드 답글 리액션은 스레드에만. 커서는 세션마다 따로(Review Focus 3)", async () => {
    const t = await start();
    const { answer: root } = await turn(t, "@dev 채널에서 시작");
    if (!root) throw new Error("루트 답이 없다");
    // 스레드 세션이 리액션보다 먼저 생기게 — 새 세션은 만들기 전에 달린 리액션을 받지 않는다
    const { answer: reply } = await turn(t, "@dev 스레드에서 이어서", root.id);
    if (!reply) throw new Error("스레드 답이 없다");
    expect(reply.threadRootId).toBe(root.id);
    expect(await react(t.mia, root.id, "👍")).toEqual(OK);
    expect(await react(t.mia, reply.id, "🎉")).toEqual(OK);

    expect(facts((await turn(t, "@dev 스레드 또", root.id)).delivery)).toEqual([
      `mia 👍 ${root.id}`,
      `mia 🎉 ${reply.id}`,
    ]);
    // 스레드 런이 자기 커서를 올려도 채널 세션은 루트 리액션을 그대로 받는다
    expect(facts((await turn(t, "@dev 채널 또")).delivery)).toEqual([`mia 👍 ${root.id}`]);
    expect((await turn(t, "@dev 스레드 셋째", root.id)).delivery?.context.reactions).toBeUndefined();
    expect((await turn(t, "@dev 채널 셋째")).delivery?.context.reactions).toBeUndefined();
  });

  it("채널에서 뺐다가 다시 넣은 에이전트 — 빠진 동안 쌓인 25개는 첫 런에 최근 20개 + reactionsOmitted 5(Review Focus 4)", async () => {
    const t = await start();
    const first = (await turn(t, "@dev 하나")).answer;
    const second = (await turn(t, "@dev 둘")).answer;
    if (!first || !second) throw new Error("답이 없다");
    const removed = await live.app.fastify.inject({
      method: "DELETE",
      url: `/api/v1/channels/${t.channel.id}/members/${t.dev.id}`,
      headers: live.auth.headers,
    });
    expect(removed.statusCode).toBe(200);

    // mia 8 + owner 8(첫 답) + mia 8 + owner 1(둘째 답) = 25, 단 순서대로 적어 둔다
    const order: string[] = [];
    const plan: Array<[WireLog, string, string, ReactionEmoji]> = [
      ...REACTION_EMOJIS.map((e): [WireLog, string, string, ReactionEmoji] => [t.mia, "mia", first.id, e]),
      ...REACTION_EMOJIS.map((e): [WireLog, string, string, ReactionEmoji] => [
        t.owner,
        "owner",
        first.id,
        e,
      ]),
      ...REACTION_EMOJIS.map((e): [WireLog, string, string, ReactionEmoji] => [t.mia, "mia", second.id, e]),
      [t.owner, "owner", second.id, "👍"],
    ];
    for (const [log, handle, messageId, emoji] of plan) {
      expect(await react(log, messageId, emoji)).toEqual(OK);
      order.push(`${handle} ${emoji} ${messageId}`);
    }
    expect(order).toHaveLength(25);

    const added = await rest(live, "POST", `/channels/${t.channel.id}/members`, {
      memberType: "agent",
      memberId: t.dev.id,
    });
    expect(added.status).toBeLessThan(300);
    const back = await turn(t, "@dev 돌아왔어");
    expect(facts(back.delivery)).toEqual(order.slice(5));
    expect(back.delivery?.context.reactionsOmitted).toBe(5);
  });

  it("러너 에이전트 — 다음 런의 RunnerRunStart.deliver.context.reactions 에 실리고 그다음 런에는 없다", async () => {
    live = await bootLiveApp();
    const issued = IssueRunnerTokenResult.parse(
      (await rest(live, "POST", "/setup/runner-tokens", { label: "macbook" })).body,
    );
    const runner = await startFakeRunner({ url: live.app.url, token: issued.token });
    runners.push(runner);
    const coder = (
      await rest<{ agent: Agent }>(live, "POST", "/agents", {
        provider: "claude",
        providerAgentId: "coder",
        handle: "coder",
        name: "Coder",
      })
    ).body.agent;
    const channel = (await rest<{ channel: Channel }>(live, "POST", "/channels", { name: "runner" })).body
      .channel;
    expect(
      (
        await rest(live, "POST", `/channels/${channel.id}/members`, {
          memberType: "agent",
          memberId: coder.id,
        })
      ).status,
    ).toBeLessThan(300);
    const owner = await openChannelWire(live, channel.id, sockets);
    const mia = await openUserWire(channel.id, "mia");

    const { answer } = await turn({ owner, channel }, "@coder 처음");
    if (!answer) throw new Error("러너 답이 없다");
    expect(await react(mia.log, answer.id, "👍")).toEqual(OK);
    await turn({ owner, channel }, "@coder 다음");
    await turn({ owner, channel }, "@coder 또");

    expect(runner.runStarts).toHaveLength(3);
    expect(runner.runStarts[0]?.deliver.context.reactions).toBeUndefined();
    expect(runner.runStarts[1]?.deliver.context.reactions).toEqual([
      expect.objectContaining({ messageId: answer.id, emoji: "👍", by: "mia" }),
    ]);
    expect(runner.runStarts[2]?.deliver.context.reactions).toBeUndefined();
  });

  describe("거절", () => {
    it("형식 틀림·목록 밖 이모지·시스템 메시지는 VALIDATION, 없는 메시지는 NOT_FOUND — 이벤트 없음", async () => {
      const t = await start();
      const { answer } = await turn(t, "@dev 처음");
      if (!answer) throw new Error("답이 없다");
      const notice = createSystemMessage(live.app.db, live.app.bus, {
        conversationId: t.channel.id,
        bodyMd: "공지",
        kind: "info",
      });
      const before = t.mia.updated.length;
      const emit = (payload: unknown) =>
        (t.mia.socket.emitWithAck as (e: string, p: unknown) => Promise<Result<null>>)(
          "reaction.set",
          payload,
        );

      expect(await emit({ messageId: "nope", emoji: "👍", on: true })).toMatchObject({
        ok: false,
        error: { code: "VALIDATION" },
      });
      expect(await emit({ messageId: answer.id, emoji: "👍" })).toMatchObject({
        ok: false,
        error: { code: "VALIDATION" },
      });
      expect(await react(t.mia, answer.id, "🔥")).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
      expect(await react(t.mia, notice.id, "👍")).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
      expect(await react(t.mia, randomUUID(), "👍")).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
      await roundTrip(t.mia);
      expect(t.mia.updated.slice(before)).toEqual([]);
    });

    it("보관한 채널의 메시지는 켜기·끄기 모두 CHANNEL_ARCHIVED — 이벤트 없음", async () => {
      const t = await start();
      const { answer } = await turn(t, "@dev 처음");
      if (!answer) throw new Error("답이 없다");
      expect(await react(t.mia, answer.id, "👍")).toEqual(OK);
      expect((await rest(live, "POST", `/channels/${t.channel.id}/archive`)).status).toBe(200);
      const before = t.mia.updated.length;

      for (const on of [true, false])
        expect(await react(t.mia, answer.id, on ? "🎉" : "👍", on)).toMatchObject({
          ok: false,
          error: { code: "CHANNEL_ARCHIVED" },
        });
      await roundTrip(t.mia);
      expect(t.mia.updated.slice(before)).toEqual([]);
    });

    it("chatter 버킷을 넘으면 RATE_LIMITED", async () => {
      const t = await start();
      const emit = () =>
        (t.mia.socket.emitWithAck as (e: string, p: unknown) => Promise<Result<null>>)("reaction.set", {});
      // 레이트리밋은 파싱 전이라 틀린 페이로드도 토큰을 쓴다 — burst 만큼은 VALIDATION, 그다음이 RATE_LIMITED
      for (let i = 0; i < LIMITS.wire.chatter.burst; i++)
        expect(await emit()).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
      expect(await emit()).toEqual({
        ok: false,
        error: { code: "RATE_LIMITED", message: "too many requests" },
      });
    });
  });
});

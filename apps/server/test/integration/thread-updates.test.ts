/**
 * 스레드 소식(스펙 docs/superpowers/specs/2026-11-24-channel-thread-updates-design.md, 계획 Task 3) — 채널(대화) 세션 런에 지난 턴 뒤
 * 그 대화의 스레드에 새로 달린 답글이 실리고, 같은 것은 한 번만, 스레드 런·옛 플러그인·다른 대화에는 실리지 않는다. 실제 서버(실제
 * OpenClawAdapter) + 가짜 Gateway·플러그인 + owner wire 소켓. 기다림은 wire 이벤트(WireLog.until)로 한다.
 */
import type { Channel, InboundDeliver, Message, RunState } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSessions } from "../../src/db/schema.sqlite";
import { FAKE_PLUGIN_HELLO } from "../fakes/fake-plugin";
import { createScenario, type Scenario } from "../fakes/scenario";
import { bootLiveApp, type LiveApp, type LiveAppOptions, waitForAdapterConnected } from "../helpers/live-app";
import { openChannelWire, sendMessage, setupRelayChannel, type WireLog } from "../helpers/scenario-steps";
import type { WireClient } from "../helpers/wire";
import { channelConversation, seedConversation } from "../helpers/seed";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const RELAY_POLICY = { maxRelayTurns: 3, allowPairs: "all" as const };
const OLD_PLUGIN_HELLO = {
  ...FAKE_PLUGIN_HELLO,
  capabilities: FAKE_PLUGIN_HELLO.capabilities.filter((cap) => cap !== "threadUpdates"),
};

type Started = { channel: Channel; owner: WireLog; scenario: Scenario; conversationId: string };
type Turn = { run: RunState; answer: Message | undefined; delivery: InboundDeliver | undefined };

describe("통합 — 스레드 소식", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  async function start(
    opts: LiveAppOptions = {},
    dev: (index: number) => { reply: string; drop?: string } = (index) => ({ reply: `답 ${index}` }),
  ): Promise<Started> {
    live = await bootLiveApp(opts);
    const { channel } = await setupRelayChannel(live, RELAY_POLICY);
    const owner = await openChannelWire(live, channel.id, sockets);
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: { dev: ({ index }) => dev(index) },
    });
    return { channel, owner, scenario, conversationId: channelConversation(live.app.db, channel.id) };
  }

  /** owner 가 보낸 글 하나로 생긴 런 하나를 끝까지 — 플러그인이 받은 인바운드(못 받았으면 undefined) */
  async function turn(
    t: Started,
    body: string,
    opts: { threadRootId?: string; conversationId?: string } = {},
  ): Promise<Turn> {
    const seen = new Set(t.owner.states.map((s) => s.id));
    await sendMessage(t.owner.socket, t.channel.id, body, {
      ...(opts.threadRootId === undefined ? { conversationId: opts.conversationId ?? t.conversationId } : {}),
      ...(opts.threadRootId === undefined ? {} : { threadRootId: opts.threadRootId }),
    });
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

  /** 멘션 없는 글 — 런을 만들지 않는다 */
  const say = (t: Started, body: string, opts: { threadRootId?: string; conversationId?: string } = {}) =>
    sendMessage(
      t.owner.socket,
      t.channel.id,
      body,
      opts.threadRootId === undefined ? { conversationId: opts.conversationId ?? t.conversationId } : opts,
    );

  /** 루트 글 하나와 스레드 답글들 — 루트 id */
  async function thread(
    t: Started,
    root: string,
    replies: string[],
    conversationId?: string,
  ): Promise<string> {
    const r = await say(t, root, conversationId === undefined ? {} : { conversationId });
    for (const body of replies) await say(t, body, { threadRootId: r.id });
    return r.id;
  }

  const texts = (d: InboundDeliver | undefined) =>
    d?.context.threadUpdates?.map((u) => [u.rootId, u.newReplies, u.recent.map((m) => m.text)]);

  it("채널 루트에 스레드 답글 둘 뒤 채널 멘션 → threadUpdates 에 그 둘, 바로 다음 채널 멘션에는 없다", async () => {
    const t = await start();
    await turn(t, "@dev 시작");
    const root = await thread(t, "erdd 의 pick 폼", ["제출 된 폼인데?", "이미 제출됐습니다"]);

    const first = await turn(t, "@dev 각 작업 현황");
    expect(texts(first.delivery)).toEqual([[root, 2, ["제출 된 폼인데?", "이미 제출됐습니다"]]]);
    expect(first.delivery?.context.threadUpdates?.[0]?.rootExcerpt).toBe("erdd 의 pick 폼");
    expect(first.delivery?.context.threadUpdatesOmitted).toBeUndefined();

    const second = await turn(t, "@dev 또");
    expect(second.delivery?.context).not.toHaveProperty("threadUpdates");
  });

  it("스레드 런에는 threadUpdates 가 없다 — 스레드 세션이 이미 있고 그 뒤 답글이 달려도. 채널 커서도 건드리지 않는다", async () => {
    const t = await start();
    await turn(t, "@dev 시작");
    const root = await thread(t, "루트", ["답글 하나"]);

    // 첫 스레드 런이 스레드 세션 행을 만든다(그 커서는 만든 시각) — 그 뒤 달린 답글이 둘째 스레드 런의 후보가 된다
    const first = await turn(t, "@dev 스레드에서", { threadRootId: root });
    expect(first.delivery?.threadId).toBeDefined();
    expect(first.delivery?.context).not.toHaveProperty("threadUpdates");
    await say(t, "스레드 세션 뒤 답글", { threadRootId: root });
    const second = await turn(t, "@dev 스레드 또", { threadRootId: root });
    expect(second.delivery?.threadId).toBeDefined();
    expect(second.delivery?.context).not.toHaveProperty("threadUpdates");

    // 스레드 런의 멘션 글·에이전트 답글도 스레드 답글이다 — 채널 세션에는 그동안의 여섯 개가 다 실린다(최근 3)
    const channel = await turn(t, "@dev 채널에서");
    const [u] = channel.delivery?.context.threadUpdates ?? [];
    expect(u?.newReplies).toBe(6);
    expect(u?.recent.map((m) => m.text)).toEqual(["스레드 세션 뒤 답글", "@dev 스레드 또", "답 2"]);
  });

  it("다른 대화(같은 채널의 다른 세션)의 스레드 답글은 싣지 않는다", async () => {
    const t = await start();
    await turn(t, "@dev 시작");
    const other = seedConversation(live.app.db, t.channel.id, { createdAt: new Date() });
    await thread(t, "다른 세션 루트", ["다른 세션 답글"], other);
    const mine = await thread(t, "이 세션 루트", ["이 세션 답글"]);

    const out = await turn(t, "@dev 현황");
    expect(texts(out.delivery)).toEqual([[mine, 1, ["이 세션 답글"]]]);
  });

  it("능력 없는 플러그인이면 싣지 않고 커서도 그대로 — 능력을 알린 뒤 첫 채널 런에 그동안의 답글이 실린다", async () => {
    const t = await start({ pluginHello: OLD_PLUGIN_HELLO });
    await turn(t, "@dev 시작");
    const root = await thread(t, "루트", ["옛 플러그인 동안의 답글"]);

    const old = await turn(t, "@dev 옛 플러그인");
    expect(old.delivery?.context).not.toHaveProperty("threadUpdates");

    await live.plugin.reconnect({ hello: FAKE_PLUGIN_HELLO });
    await waitForAdapterConnected(live.app);
    const upgraded = await turn(t, "@dev 새 플러그인");
    expect(texts(upgraded.delivery)).toEqual([[root, 1, ["옛 플러그인 동안의 답글"]]]);
  });

  it("ack 를 기다리는 사이 달린 답글은 다음 채널 런에 실린다 — 커서는 실은 것 가운데 가장 늦은 시각까지만", async () => {
    const t = await start();
    await turn(t, "@dev 시작");
    const root = await thread(t, "루트", ["실린 답글"]);

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
    await sendMessage(t.owner.socket, t.channel.id, "@dev 현황", { conversationId: t.conversationId });
    const held = await t.owner.until(() => t.owner.states.find((s) => !seen.has(s.id)), "붙잡힌 런");
    await vi.waitFor(() => expect(live.plugin.received.some((d) => d.runId === held.id)).toBe(true));
    expect(texts(live.plugin.received.find((d) => d.runId === held.id))).toEqual([[root, 1, ["실린 답글"]]]);

    await say(t, "ack 전 답글", { threadRootId: root });
    release();
    live.plugin.onInbound = play;
    expect((await t.owner.terminal(held.id)).status).toBe("done");
    await t.owner.until(
      () => t.owner.created.find((m) => m.authorType === "agent" && m.runId === held.id),
      "붙잡힌 런의 답",
    );

    const next = await turn(t, "@dev 다음");
    expect(texts(next.delivery)).toEqual([[root, 1, ["ack 전 답글"]]]);
  });

  it("커서가 null 인 세션이면 싣지 않고 커서를 지금으로 채운다 — 그 뒤 달린 답글만 다음 런에 실린다", async () => {
    const t = await start();
    await turn(t, "@dev 시작");
    const root = await thread(t, "루트", ["옛 답글"]);
    live.app.db
      .update(agentSessions)
      .set({ threadRepliesSeenAt: null })
      .where(eq(agentSessions.conversationId, t.conversationId))
      .run();

    const first = await turn(t, "@dev 커서 없음");
    expect(first.delivery?.context).not.toHaveProperty("threadUpdates");
    const row = live.app.db
      .select({ seen: agentSessions.threadRepliesSeenAt })
      .from(agentSessions)
      .where(eq(agentSessions.conversationId, t.conversationId))
      .all();
    expect(row.map((r) => r.seen)).not.toContain(null);

    await say(t, "새 답글", { threadRootId: root });
    const second = await turn(t, "@dev 다음");
    expect(texts(second.delivery)).toEqual([[root, 1, ["새 답글"]]]);
  });

  it("send 가 drop 되면 커서가 그대로라 다음 런에 다시 실린다", async () => {
    const t = await start({}, (index) =>
      index === 1 ? { reply: "", drop: "loop_guard" } : { reply: `답 ${index}` },
    );
    await turn(t, "@dev 시작");
    const root = await thread(t, "루트", ["답글"]);

    const dropped = await turn(t, "@dev 떨어질 런");
    expect(dropped.run.status).toBe("error");
    expect(texts(dropped.delivery)).toEqual([[root, 1, ["답글"]]]);

    const again = await turn(t, "@dev 다시");
    expect(texts(again.delivery)).toEqual([[root, 1, ["답글"]]]);
  });
});

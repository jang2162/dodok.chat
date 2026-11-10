/**
 * 연결을 닫으며 끝낸 런에 늦게 온 정본(멀티 Gateway 태스크 3 조율자 판정) — 어댑터가 Gateway 끄기·삭제·주소/토큰 변경으로 닫은 런
 * (RunSignal gateway_error connectionClosed)은 Gateway 안에서 끝까지 돌 수 있다. 그 정본은 그 런의 답으로 저장하되 릴레이·푸시는
 * 하지 않고, 그 런의 「다시 실행」 카드를 쓴 것으로 닫는다. 표지는 런 행에 있어 재시작 뒤에도 가른다.
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { dodokSessionKey, type Message, type OutboundMessage } from "@dodok/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, AppDeps } from "../src/app";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { setConversationClosed } from "../src/modules/conversations/service";
import { createUserMessage, getMessage, runErrorMessages } from "../src/modules/messages/service";
import { RETRY_RUN_ITEM } from "../src/modules/router/service";
import { getRun } from "../src/modules/runs/store";
import { agents, messages, runs } from "../src/db/schema.sqlite";
import { eq } from "drizzle-orm";
import { bootTestApp, login } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { connectWire, waitFor, type WireClient } from "./helpers/wire";
import { channelConversation, seedAgentSession, seedConversation } from "./helpers/seed";

const KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

type Setup = {
  app: App;
  adapter: FakeAdapter;
  pushes: unknown[];
  channelId: string;
  conversationId: string;
  sessionKey: string;
};

const apps: App[] = [];
const dirs: string[] = [];
const sockets: WireClient[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(overrides: Record<string, string> = {}) {
  const adapter = new FakeAdapter();
  const pushes: unknown[] = [];
  const pushSend: NonNullable<AppDeps["pushSend"]> = async (sub) => {
    pushes.push(sub);
    return { statusCode: 201 };
  };
  const app = await bootTestApp(overrides, { adapters: [adapter], pushSend });
  apps.push(app);
  return { app, adapter, pushes };
}

/** dev·fin 이 든 채널, owner 의 푸시 구독 하나 */
function agentIdByProvider(app: App, providerAgentId: string): string {
  const row = app.db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.providerAgentId, providerAgentId))
    .get();
  if (!row) throw new Error(`no agent ${providerAgentId}`);
  return row.id;
}

async function seed(app: App): Promise<{ channelId: string; conversationId: string; sessionKey: string }> {
  const agent = (handle: string) =>
    createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId: handle,
      handle,
      name: handle,
      gatewayId: FAKE_GATEWAY_ID,
    });
  const [dev, fin] = [agent("dev"), agent("fin")];
  const channel = createChannel(app.db, {
    workspaceId: app.workspaceId,
    createdBy: app.ownerUserId,
    name: "late",
  });
  for (const a of [dev, fin])
    addMember(app.db, channel.id, { memberType: "agent", memberId: a.id }, app.logger);
  const { headers } = await login(app);
  const subscribed = await app.fastify.inject({
    method: "POST",
    url: "/api/v1/push/subscriptions",
    headers,
    payload: { endpoint: "https://push.invalid/late", keys: KEYS },
  });
  expect(subscribed.statusCode).toBe(204);
  const conversationId = seedConversation(app.db, channel.id);
  return { channelId: channel.id, conversationId, sessionKey: dodokSessionKey("dev", conversationId) };
}

/** @dev 멘션 → 런이 어댑터로 나간다 → 어댑터가 연결을 닫으며 그 런을 끝낸다(connectionClosed 를 주면) */
async function closedRun(s: Setup, connectionClosed: boolean): Promise<string> {
  const message = createUserMessage(s.app.db, s.app.bus, {
    conversationId: s.conversationId,
    authorId: s.app.ownerUserId,
    bodyMd: "@dev 정리해 줘",
    clientMsgId: `late-${Math.random()}`,
  });
  await s.app.services.router.routeMessage(message);
  await vi.waitFor(() => expect(s.adapter.calls.send).toHaveLength(1));
  const runId = s.adapter.calls.send[0]?.runId as string;
  s.adapter.emit({
    kind: "run_signal",
    runId,
    signal: {
      kind: "gateway_error",
      code: "ADAPTER_UNAVAILABLE",
      message: "gateway disabled",
      ...(connectionClosed ? { connectionClosed: true as const } : {}),
    },
  });
  await vi.waitFor(() => expect(getRun(s.app.db, runId)?.status).toBe("error"));
  return runId;
}

const late = (s: Pick<Setup, "conversationId" | "sessionKey">, runId: string): OutboundMessage => ({
  outboundId: `late-${runId}`,
  conversationId: s.conversationId,
  agentId: "dev",
  sessionKey: s.sessionKey,
  runId,
  // 릴레이(@fin)와 푸시(@owner)가 날 수 있는 본문
  text: "@fin @owner 늦었지만 정리했습니다",
  attachmentIds: [],
  ts: new Date().toISOString(),
});

const retryCard = (app: App, channelId: string, runId: string): Message => {
  const [card] = runErrorMessages(app.db, channelId, runId);
  if (!card) throw new Error("run_error card missing");
  return card;
};

const runIdsIn = (app: App, channelId: string) =>
  app.db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.channelId, channelId))
    .all()
    .map((r) => r.id);

/** 늦게 끝나는 일(릴레이 enqueue·푸시 발송)이 있으면 닿을 만큼 기다린다 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("연결을 닫으며 끝낸 런에 늦게 온 정본", () => {
  it("표지가 런 행에 남는다 — error JSON 의 connectionClosed, 「다시 실행」 카드는 처음엔 쓸 수 있다", async () => {
    const { app, adapter, pushes } = await boot();
    const s = { app, adapter, pushes, ...(await seed(app)) };
    const runId = await closedRun(s, true);
    expect(getRun(app.db, runId)?.error).toEqual({
      code: "ADAPTER_UNAVAILABLE",
      message: "gateway disabled",
      connectionClosed: true,
    });
    const card = retryCard(app, s.channelId, runId);
    expect(card.components?.blocks).toEqual([
      expect.objectContaining({ items: [expect.objectContaining({ id: RETRY_RUN_ITEM })] }),
    ]);
    expect(card.componentState?.consumed).toEqual([]);
  });

  it("저장한다(그 런의 답) · 릴레이·푸시는 하지 않는다 · 그 런의 「다시 실행」 카드를 쓴 것으로 닫는다", async () => {
    const { app, adapter, pushes } = await boot();
    const s = { app, adapter, pushes, ...(await seed(app)) };
    const runId = await closedRun(s, true);
    const card = retryCard(app, s.channelId, runId);
    const updated: Message[] = [];
    const created: Array<{ message: Message; silent?: true }> = [];
    app.bus.on("message.updated", ({ message }) => updated.push(message));
    app.bus.on("message.created", (p) => created.push(p));

    const ack = await app.orchestrator.onCanonical(late(s, runId), "openclaw", FAKE_GATEWAY_ID);
    await settle();

    expect(getMessage(app.db, ack.messageId ?? "")).toMatchObject({ runId, authorType: "agent" });
    expect(created).toEqual([expect.objectContaining({ silent: true })]);
    // 릴레이 런 없음 — 이 채널의 런은 닫힌 그 하나뿐이고 어댑터에도 더 나가지 않았다
    expect(runIdsIn(app, s.channelId)).toEqual([runId]);
    expect(adapter.calls.send).toHaveLength(1);
    expect(pushes).toEqual([]);
    expect(getMessage(app.db, card.id)?.componentState?.consumed).toEqual([RETRY_RUN_ITEM]);
    expect(updated.map((m) => m.id)).toContain(card.id);
    // 눌러도 같은 일을 두 번 돌리지 않는다
    await expect(
      app.services.runs.interact({
        messageId: card.id,
        componentId: card.components?.id as string,
        itemId: RETRY_RUN_ITEM,
        values: {},
        userId: app.ownerUserId,
      }),
    ).rejects.toMatchObject({ body: { code: "CONSUMED" } });
    expect(getRun(app.db, runId)?.status).toBe("error");
  });

  it("푸시만 건너뛰는 표지(silent)는 서버 안에만 있다 — wire 의 message.created 에는 없다", async () => {
    const { app, adapter, pushes } = await boot();
    const s = { app, adapter, pushes, ...(await seed(app)) };
    const runId = await closedRun(s, true);
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const socket = await connectWire(app, (await login(app)).token);
    sockets.push(socket);
    const subscribed = await socket.emitWithAck("channel.subscribe", { channelId: s.channelId });
    expect(subscribed.ok).toBe(true);
    const received = waitFor(socket, "message.created", (p) => p.message.runId === runId);

    await app.orchestrator.onCanonical(late(s, runId), "openclaw", FAKE_GATEWAY_ID);

    const payload = await received;
    expect(payload.message).toMatchObject({ runId, authorType: "agent" });
    expect(Object.keys(payload)).toEqual(["message"]);
  });

  it("같은 정본이 다시 와도(재전송) 메시지는 하나, 카드는 한 번만 닫힌다", async () => {
    const { app, adapter, pushes } = await boot();
    const s = { app, adapter, pushes, ...(await seed(app)) };
    const runId = await closedRun(s, true);
    const first = await app.orchestrator.onCanonical(late(s, runId), "openclaw", FAKE_GATEWAY_ID);
    const again = await app.orchestrator.onCanonical(late(s, runId), "openclaw", FAKE_GATEWAY_ID);
    expect(again).toEqual(first);
    expect(getMessage(app.db, retryCard(app, s.channelId, runId).id)?.componentState?.consumed).toEqual([
      RETRY_RUN_ITEM,
    ]);
  });

  it("서버를 다시 띄운 뒤 온 늦은 정본도 같다 — 표지는 런 행에서 읽는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-late-canonical-"));
    dirs.push(dir);
    const DB_PATH = join(dir, "db.sqlite");
    const first = await boot({ DB_PATH });
    const seeded = await seed(first.app);
    const runId = await closedRun({ ...first, ...seeded }, true);
    const cardId = retryCard(first.app, seeded.channelId, runId).id;
    await first.app.close();

    const { app, adapter, pushes } = await boot({ DB_PATH });
    await app.orchestrator.onCanonical(late(seeded, runId), "openclaw", FAKE_GATEWAY_ID);
    await settle();
    expect(runIdsIn(app, seeded.channelId)).toEqual([runId]);
    expect(adapter.calls.send).toHaveLength(0);
    expect(pushes).toEqual([]);
    expect(getMessage(app.db, cardId)?.componentState?.consumed).toEqual([RETRY_RUN_ITEM]);
  });

  it("[중간 2] 닫힌 세션 키로 온 런 없는 정본(message 툴) — 저장하고 silent(푸시 없음). 열린 세션이면 같은 글이 푸시된다", async () => {
    const { app, adapter, pushes } = await boot();
    const s = { app, adapter, pushes, ...(await seed(app)) };
    const created: Array<{ message: Message; silent?: true }> = [];
    app.bus.on("message.created", (p) => created.push(p));
    await setConversationClosed(
      { db: app.db, bus: app.bus },
      { conversationId: s.conversationId, byUserId: app.ownerUserId, closed: true },
    );
    // runId 없이 그 세션 키로 — 세션에 열린 런도 없어 런 없는 정본이 된다. 본문은 릴레이(@fin)·푸시(@owner)가 날 수 있는 꼴
    const runless = (conversationId: string, outboundId: string): OutboundMessage => ({
      outboundId,
      conversationId,
      agentId: "dev",
      sessionKey: dodokSessionKey("dev", conversationId),
      text: "@fin @owner 세션에 남깁니다",
      attachmentIds: [],
      ts: new Date().toISOString(),
    });

    // dev 가 두 세션에서 불린 적이 있다 — 런 없는 정본은 서버가 만든 세션의 키로만 받는다
    const devId = agentIdByProvider(app, "dev");
    seedAgentSession(app.db, { conversationId: s.conversationId, agentId: devId });
    const ack = await app.orchestrator.onCanonical(
      runless(s.conversationId, "runless-closed"),
      "openclaw",
      FAKE_GATEWAY_ID,
    );
    await settle();
    expect(getMessage(app.db, ack.messageId ?? "")).toMatchObject({
      conversationId: s.conversationId,
      authorType: "agent",
    });
    expect(getMessage(app.db, ack.messageId ?? "")?.runId).toBeUndefined();
    expect(created.find((p) => p.message.id === ack.messageId)?.silent).toBe(true);
    expect(pushes).toEqual([]);
    expect(runIdsIn(app, s.channelId)).toEqual([]);

    // 대조 — 같은 채널의 열린 세션이면 런 없는 정본도 푸시된다(이 사례가 푸시 경로를 실제로 탄다)
    const open = seedConversation(app.db, s.channelId);
    seedAgentSession(app.db, { conversationId: open, agentId: devId });
    const openAck = await app.orchestrator.onCanonical(
      runless(open, "runless-open"),
      "openclaw",
      FAKE_GATEWAY_ID,
    );
    expect(created.find((p) => p.message.id === openAck.messageId)?.silent).toBeUndefined();
    await vi.waitFor(() => expect(pushes).toHaveLength(1));
  });

  it("[Review Focus 4] 대화 밖 정본은 닫힌 세션의 「저장만」보다 먼저 거절한다 — 다른 세션 키로 닫힌 세션에 쓰거나, 닫힌 세션 키로 다른 세션에 쓰면 FORBIDDEN", async () => {
    const { app, adapter, pushes } = await boot();
    const s = { app, adapter, pushes, ...(await seed(app)) };
    const open = seedConversation(app.db, s.channelId);
    await setConversationClosed(
      { db: app.db, bus: app.bus },
      { conversationId: s.conversationId, byUserId: app.ownerUserId, closed: true },
    );
    const post = (conversationId: string, keyConversation: string, outboundId: string): OutboundMessage => ({
      outboundId,
      conversationId,
      agentId: "dev",
      sessionKey: dodokSessionKey("dev", keyConversation),
      text: "다른 세션에 씁니다",
      attachmentIds: [],
      ts: new Date().toISOString(),
    });
    for (const [conversationId, keyConversation, outboundId] of [
      [s.conversationId, open, "into-closed"],
      [open, s.conversationId, "from-closed"],
    ] as const) {
      await expect(
        app.orchestrator.onCanonical(
          post(conversationId, keyConversation, outboundId),
          "openclaw",
          FAKE_GATEWAY_ID,
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN", message: "이 대화에만 보낼 수 있습니다" });
      expect(app.db.select().from(messages).where(eq(messages.externalId, outboundId)).all()).toEqual([]);
    }
  });

  it("표지가 없는 실패 런(연결을 닫지 않은 ADAPTER_UNAVAILABLE)의 늦은 정본은 지금처럼 릴레이·푸시하고 「다시 실행」 카드는 닫는다", async () => {
    const { app, adapter, pushes } = await boot();
    const s = { app, adapter, pushes, ...(await seed(app)) };
    const runId = await closedRun(s, false);
    const card = retryCard(app, s.channelId, runId);
    await app.orchestrator.onCanonical(late(s, runId), "openclaw", FAKE_GATEWAY_ID);
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(2));
    await vi.waitFor(() => expect(pushes).toHaveLength(1));
    expect(adapter.calls.send[1]?.sessionKey).toBe(
      dodokSessionKey("fin", channelConversation(app.db, s.channelId)),
    );
    expect(getMessage(app.db, card.id)?.componentState?.consumed).toEqual(["retry_run"]);
  });
});

/**
 * 채널 보관·보관 해제(채널 보관·멤버 비활성화 스펙 「채널 보관」 절, 계획 판정 PC1·PC2, Review Focus 1·4). 보관은 기록을 남기고
 * 쓰기만 막는다 — 누구나 읽고, 보관 해제하면 같은 세션으로 이어 답한다.
 */
import { AdapterError, type ProviderApproval } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import {
  type Channel,
  dodokSessionKey,
  type Message,
  type OutboundMessage,
  type SearchHit,
} from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, AppDeps } from "../src/app";
import { workspaces } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { addMember, assertChannelWritable, createChannel } from "../src/modules/channels/service";
import {
  createAgentMessage,
  createSystemMessage,
  createUserMessage,
  runErrorMessages,
} from "../src/modules/messages/service";
import { createRunGate } from "../src/modules/ops/budget";
import { CONTINUE_RELAY_ITEM, RETRY_RUN_ITEM } from "../src/modules/router/service";
import { getRun } from "../src/modules/runs/store";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { connectWire, waitFor } from "./helpers/wire";
import { makePng } from "./helpers/png";
import { channelConversation } from "./helpers/seed";

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** dev·fin 을 둔 채널 하나 + owner 세션 + 멘션·런 도우미 */
async function setup(deps: Pick<AppDeps, "pushSend"> = {}) {
  const adapter = new FakeAdapter();
  const app = await bootTestApp({}, { adapters: [adapter], ...deps });
  apps.push(app);
  const { token, headers } = await login(app);
  const inject = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
    h: Record<string, string> = headers,
  ) => app.fastify.inject({ method, url, headers: h, ...(payload === undefined ? {} : { payload }) });
  const agent = (providerAgentId: string) =>
    createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId,
      handle: providerAgentId,
      name: providerAgentId,
      gatewayId: FAKE_GATEWAY_ID,
    });
  const dev = agent("dev");
  const fin = agent("fin");
  const channel = createChannel(app.db, {
    workspaceId: app.workspaceId,
    createdBy: app.ownerUserId,
    name: "archive",
  });
  for (const a of [dev, fin])
    addMember(app.db, channel.id, { memberType: "agent", memberId: a.id }, app.logger);
  let n = 0;
  const say = async (bodyMd: string, threadRootId?: string) => {
    const message = createUserMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channel.id),
      authorId: app.ownerUserId,
      bodyMd,
      clientMsgId: `archive-${++n}`,
      ...(threadRootId === undefined ? {} : { threadRootId }),
    });
    await app.services.router.routeMessage(message);
    return message;
  };
  const runs = () =>
    app.db.$client
      .prepare("SELECT id FROM runs WHERE channel_id = ? ORDER BY created_at, id")
      .all(channel.id)
      .map((r) => getRun(app.db, (r as { id: string }).id));
  const openRuns = () => runs().filter((r) => r && !["done", "error", "aborted"].includes(r.status));
  const archive = (id: string = channel.id, h: Record<string, string> = headers) =>
    inject("POST", `/api/v1/channels/${id}/archive`, undefined, h);
  const unarchive = (id: string = channel.id, h: Record<string, string> = headers) =>
    inject("POST", `/api/v1/channels/${id}/unarchive`, undefined, h);
  return { app, adapter, token, headers, inject, dev, fin, channel, say, runs, openRuns, archive, unarchive };
}

const archivedError = { code: "CHANNEL_ARCHIVED" };

describe("보관·보관 해제 REST", () => {
  it("admin 이 보관하면 200·archivedAt 이 시각, 다시 해도 200(멱등), member 403, 없는 id 404", async () => {
    const { app, archive } = await setup();
    const admin = { authorization: `Bearer ${(await userWithRole(app, "ada", "admin")).token}` };
    const member = { authorization: `Bearer ${(await userWithRole(app, "bee", "member")).token}` };

    expect((await archive(undefined, member)).statusCode).toBe(403);
    const first = await archive(undefined, admin);
    expect(first.statusCode).toBe(200);
    const archivedAt = (first.json().channel as Channel).archivedAt;
    expect(archivedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(archivedAt ?? ""))).toBe(false);
    const again = await archive(undefined, admin);
    expect(again.statusCode).toBe(200);
    expect((again.json().channel as Channel).archivedAt).toBe(archivedAt);
    expect((await archive(uuid(), admin)).statusCode).toBe(404);
  });

  it("보관 해제는 200·archivedAt null, 살아 있는 채널도 200(멱등), member 403, 없는 id 404", async () => {
    const { app, archive, unarchive } = await setup();
    const member = { authorization: `Bearer ${(await userWithRole(app, "bee", "member")).token}` };
    await archive();
    expect((await unarchive(undefined, member)).statusCode).toBe(403);
    const back = await unarchive();
    expect(back.statusCode).toBe(200);
    expect((back.json().channel as Channel).archivedAt).toBeNull();
    expect((await unarchive()).statusCode).toBe(200);
    expect((await unarchive(uuid())).statusCode).toBe(404);
  });

  it("다른 워크스페이스의 채널은 보관·보관 해제 모두 404 이고 그 채널은 바뀌지 않는다", async () => {
    const { app, archive, unarchive } = await setup();
    const otherWorkspace = uuid();
    app.db.insert(workspaces).values({ id: otherWorkspace, name: "other", createdAt: new Date() }).run();
    const foreign = createChannel(app.db, {
      workspaceId: otherWorkspace,
      createdBy: app.ownerUserId,
      name: "foreign",
    });
    const archivedAt = () =>
      (
        app.db.$client.prepare("SELECT archived_at AS a FROM channels WHERE id = ?").get(foreign.id) as {
          a: number | null;
        }
      ).a;

    expect((await archive(foreign.id)).statusCode).toBe(404);
    expect(archivedAt()).toBeNull();
    app.db.$client.prepare("UPDATE channels SET archived_at = ? WHERE id = ?").run(Date.now(), foreign.id);
    expect((await unarchive(foreign.id)).statusCode).toBe(404);
    expect(archivedAt()).not.toBeNull();
  });

  it("목록은 기본이 살아 있는 채널만, ?archived=1 은 보관한 채널만 — member 도 읽는다", async () => {
    const { app, channel, inject, archive } = await setup();
    const live = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: "live",
    });
    await archive();
    const member = { authorization: `Bearer ${(await userWithRole(app, "bee", "member")).token}` };
    const ids = async (url: string) =>
      ((await inject("GET", url, undefined, member)).json().channels as Channel[]).map((c) => c.id);
    expect(await ids("/api/v1/channels")).toEqual([live.id]);
    expect(await ids("/api/v1/channels?archived=1")).toEqual([channel.id]);
    // 하나짜리 조회는 보관한 채널도 읽힌다 — 결과로 가기·옛 링크가 읽기 전용 화면으로 간다
    const one = await inject("GET", `/api/v1/channels/${channel.id}`, undefined, member);
    expect(one.statusCode).toBe(200);
    expect((one.json().channel as Channel).archivedAt).toEqual(expect.any(String));
  });

  it("보관·보관 해제마다 workspace 룸에 channel.updated 한 번 — 채널을 구독하지 않은 소켓에도 간다", async () => {
    const { app, token, channel, archive, unarchive } = await setup();
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const seen: Channel[] = [];
    app.bus.on("channel.updated", (p) => seen.push(p.channel));
    const socket = await connectWire(app, token);
    try {
      const archived = waitFor(socket, "channel.updated", (p) => p.channel.archivedAt !== null);
      await archive();
      expect((await archived).channel.id).toBe(channel.id);
      const restored = waitFor(socket, "channel.updated", (p) => p.channel.archivedAt === null);
      await unarchive();
      expect((await restored).channel.id).toBe(channel.id);
      expect(seen.map((c) => c.archivedAt === null)).toEqual([false, true]);
    } finally {
      socket.close();
    }
  });
});

describe("보관한 채널의 쓰기 — 409 CHANNEL_ARCHIVED(계획 판정 PC1)", () => {
  it("assertChannelWritable — 없으면 404, 보관이면 409, 살아 있으면 그 채널", async () => {
    const { app, channel, archive } = await setup();
    expect(assertChannelWritable(app.db, channel.id).id).toBe(channel.id);
    expect(() => assertChannelWritable(app.db, uuid())).toThrow(
      expect.objectContaining({ status: 404, body: expect.objectContaining({ code: "NOT_FOUND" }) }),
    );
    await archive();
    expect(() => assertChannelWritable(app.db, channel.id)).toThrow(
      expect.objectContaining({ status: 409, body: expect.objectContaining(archivedError) }),
    );
  });

  it("[Review Focus 1] wire message.send — 최상위·스레드 모두 409, 저장되지 않는다", async () => {
    const { app, token, channel, say, archive } = await setup();
    const root = await say("스레드 루트");
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const socket = await connectWire(app, token);
    try {
      expect((await socket.emitWithAck("channel.subscribe", { channelId: channel.id })).ok).toBe(true);
      await archive();
      const top = await socket.emitWithAck("message.send", {
        channelId: channel.id,
        clientMsgId: "after-archive-top",
        bodyMd: "보내 볼게요",
      });
      expect(top).toMatchObject({ ok: false, error: archivedError });
      const reply = await socket.emitWithAck("message.send", {
        channelId: channel.id,
        clientMsgId: "after-archive-thread",
        bodyMd: "답글",
        threadRootId: root.id,
      });
      expect(reply).toMatchObject({ ok: false, error: archivedError });
      const stored = app.db.$client
        .prepare(
          "SELECT count(*) AS n FROM messages WHERE channel_id = ? AND client_msg_id LIKE 'after-archive-%'",
        )
        .get(channel.id) as { n: number };
      expect(stored.n).toBe(0);
    } finally {
      socket.close();
    }
  });

  it("보관 전에 저장된 메시지를 같은 clientMsgId 로 다시 보내면 409 가 아니라 그 메시지 — ack 를 잃은 탭의 재전송", async () => {
    const { app, token, channel, archive } = await setup();
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const socket = await connectWire(app, token);
    try {
      const send = () =>
        socket.emitWithAck("message.send", {
          channelId: channel.id,
          clientMsgId: "before-archive",
          bodyMd: "보관 전에 보낸 글",
        });
      const first = await send();
      expect(first.ok).toBe(true);
      await archive();
      const again = await send();
      expect(again).toMatchObject({
        ok: true,
        data: { message: { id: first.ok ? first.data.message.id : "" } },
      });
    } finally {
      socket.close();
    }
  });

  it("카드 버튼·셀렉트·모달은 409, 상호작용은 저장·소비되지 않고 런도 없다 — 보관 해제 뒤 다시 누를 수 있다", async () => {
    const { app, dev, channel, runs, archive, unarchive } = await setup();
    const card = createAgentMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channel.id),
      agentId: dev.id,
      externalId: "card-1",
      bodyMd: "골라 주세요",
      components: {
        blocks: [
          { type: "actions", items: [{ type: "button", id: "go", label: "진행" }] },
          {
            type: "actions",
            items: [
              {
                type: "select",
                id: "target",
                placeholder: "대상",
                options: [
                  { value: "web", label: "웹" },
                  { value: "api", label: "API" },
                ],
              },
            ],
          },
        ],
        modal: {
          id: "form",
          title: "양식",
          triggerLabel: "열기",
          fields: [{ type: "text", id: "reason", label: "사유" }],
        },
      },
    });
    const press = (itemId: string, values: Record<string, unknown> = {}) =>
      app.services.runs.interact({
        messageId: card.id,
        componentId: card.components?.id as string,
        itemId,
        values,
        userId: app.ownerUserId,
      });
    await archive();
    for (const [itemId, values] of [
      ["go", {}],
      ["target", { selected: ["web"] }],
      ["form", { fields: { reason: "왜" } }],
    ] as const) {
      await expect(press(itemId, values)).rejects.toMatchObject({ status: 409, body: archivedError });
    }
    const interactions = app.db.$client
      .prepare("SELECT count(*) AS n FROM component_interactions WHERE message_id = ?")
      .get(card.id) as { n: number };
    expect(interactions.n).toBe(0);
    expect(runs()).toHaveLength(0);

    await unarchive();
    await press("go");
    await vi.waitFor(() => expect(runs()).toHaveLength(1));
  });

  it("run_error 「다시 실행」은 409 이고 카드는 소비되지 않는다 — 보관 해제 뒤 같은 카드로 다시 실행", async () => {
    const { app, adapter, channel, say, runs, archive, unarchive } = await setup();
    adapter.script(() => {
      throw new AdapterError("ADAPTER_UNAVAILABLE", "plugin is not connected");
    });
    await say("@dev 안녕");
    await vi.waitFor(() => expect(runs()[0]?.status).toBe("error"));
    const [card] = runErrorMessages(app.db, channel.id, runs()[0]?.id ?? "");
    expect(card?.components?.id).toBeDefined();

    await archive();
    const press = () =>
      app.services.runs.interact({
        messageId: card?.id as string,
        componentId: card?.components?.id as string,
        itemId: RETRY_RUN_ITEM,
        values: {},
        userId: app.ownerUserId,
      });
    await expect(press()).rejects.toMatchObject({ status: 409, body: archivedError });
    const consumed = app.db.$client
      .prepare("SELECT count(*) AS n FROM component_interactions WHERE message_id = ?")
      .get(card?.id) as { n: number };
    expect(consumed.n).toBe(0);
    expect(runs()).toHaveLength(1);

    adapter.script((input) => ({ admission: "dispatch", providerRunId: input.runId }));
    await unarchive();
    await press();
    await vi.waitFor(() => expect(runs()).toHaveLength(2));
    expect(runs()[1]?.parentRunId).toBe(runs()[0]?.id);
  });

  it("릴레이 한도 카드의 「이어가기」는 409", async () => {
    const { app, dev, fin, channel, runs, archive } = await setup();
    const card = createSystemMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channel.id),
      kind: "relay_limit",
      bodyMd: "한도",
      systemMeta: {
        relay: { fromAgentId: dev.id, toAgentId: fin.id, sourceRunId: uuid(), rootMessageId: uuid() },
      },
      components: {
        blocks: [
          { type: "actions", items: [{ type: "button", id: CONTINUE_RELAY_ITEM, label: "이어가기" }] },
        ],
      },
    });
    await archive();
    await expect(
      app.services.runs.interact({
        messageId: card.id,
        componentId: card.components?.id as string,
        itemId: CONTINUE_RELAY_ITEM,
        values: {},
        userId: app.ownerUserId,
      }),
    ).rejects.toMatchObject({ status: 409, body: archivedError });
    expect(runs()).toHaveLength(0);
  });

  it("채널 수정·멤버 넣기·빼기·멤버 설정은 409 — 아무것도 바뀌지 않는다", async () => {
    const { app, dev, fin, channel, inject, archive } = await setup();
    const ops = createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId: "ops",
      handle: "ops",
      name: "ops",
      gatewayId: FAKE_GATEWAY_ID,
    });
    const bee = await userWithRole(app, "bee", "member");
    await archive();
    const cases = [
      inject("PATCH", `/api/v1/channels/${channel.id}`, { name: "renamed" }),
      inject("POST", `/api/v1/channels/${channel.id}/members`, { memberType: "agent", memberId: ops.id }),
      inject("POST", `/api/v1/channels/${channel.id}/members`, { memberType: "user", memberId: bee.id }),
      inject("DELETE", `/api/v1/channels/${channel.id}/members/${fin.id}`),
      inject("PATCH", `/api/v1/channels/${channel.id}/members/${dev.id}`, { autoRespond: true }),
    ];
    for (const res of await Promise.all(cases)) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject(archivedError);
    }
    const row = app.db.$client.prepare("SELECT name FROM channels WHERE id = ?").get(channel.id) as {
      name: string;
    };
    expect(row.name).toBe("archive");
    const members = app.db.$client
      .prepare(
        "SELECT member_id AS id, auto_respond AS a FROM channel_members WHERE channel_id = ? ORDER BY joined_at, id",
      )
      .all(channel.id);
    expect(members).toEqual([
      { id: app.ownerUserId, a: 0 },
      { id: dev.id, a: 0 },
      { id: fin.id, a: 0 },
    ]);
  });

  it("그 채널로 사람이 첨부를 올리면 409 — 다른 채널로는 된다", async () => {
    const { app, headers, channel, archive } = await setup();
    const other = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: "other",
    });
    await archive();
    const upload = (channelId: string) =>
      app.fastify.inject({
        method: "POST",
        url: `/api/v1/attachments?channelId=${channelId}`,
        headers: { ...headers, "content-type": "image/png" },
        payload: makePng(4, 4),
      });
    const blocked = await upload(channel.id);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject(archivedError);
    expect((await upload(other.id)).statusCode).toBe(200);
  });
});

describe("[Review Focus 4] 보관한 채널 읽기", () => {
  it("메시지 목록·스레드·검색은 200 이고 검색 결과에 channelArchived: true", async () => {
    const { app, channel, inject, say, archive } = await setup();
    const live = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: "live",
    });
    const root = await say("배포 일정 정리");
    await say("배포 답글", root.id);
    createUserMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, live.id),
      authorId: app.ownerUserId,
      bodyMd: "배포 살아 있는 채널",
      clientMsgId: "live-1",
    });
    await archive();
    const member = { authorization: `Bearer ${(await userWithRole(app, "bee", "member")).token}` };

    const list = await inject("GET", `/api/v1/channels/${channel.id}/messages`, undefined, member);
    expect(list.statusCode).toBe(200);
    expect((list.json().messages as Message[]).map((m) => m.id)).toContain(root.id);
    const thread = await inject(
      "GET",
      `/api/v1/channels/${channel.id}/threads/${root.id}/messages`,
      undefined,
      member,
    );
    expect(thread.statusCode).toBe(200);
    expect((thread.json().messages as Message[]).map((m) => m.bodyMd)).toContain("배포 답글");

    // 2글자는 LIKE 경로 — 보관한 채널의 두 메시지와 살아 있는 채널의 하나가 함께 나오고, 보관한 쪽만 표시가 붙는다
    const search = await inject("GET", `/api/v1/search?q=${encodeURIComponent("배포")}`, undefined, member);
    expect(search.statusCode).toBe(200);
    const hits = search.json().hits as SearchHit[];
    expect(hits).toHaveLength(3);
    for (const hit of hits) expect(hit.channelArchived).toBe(hit.channelId === channel.id);
    // 3글자 이상은 FTS 경로 — 같은 표시를 싣는다
    const long = (
      await inject("GET", `/api/v1/search?q=${encodeURIComponent("배포 일정")}`, undefined, member)
    ).json().hits as SearchHit[];
    expect(long.map((h) => [h.channelId, h.channelArchived])).toEqual([[channel.id, true]]);
  });
});

describe("보관과 런(계획 판정 PC2)", () => {
  it("열린 런(진행 하나·대기 하나)이 있는 채로 보관하면 둘 다 닫히고, 대기 런은 보내지 않는다", async () => {
    const { adapter, say, runs, openRuns, archive } = await setup();
    await say("@dev 하나");
    await say("@dev 둘");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(1));
    expect(openRuns()).toHaveLength(2);
    const [inflight] = runs();

    expect((await archive()).statusCode).toBe(200);
    await vi.waitFor(() => expect(openRuns()).toHaveLength(0));
    expect(runs().map((r) => r?.status)).toEqual(["aborted", "aborted"]);
    expect(adapter.calls.abort.map((a) => a.runId)).toEqual([inflight?.id]);
    expect(adapter.calls.send.map((s) => s.runId)).toEqual([inflight?.id]);
  });

  it("걸린 승인이 있는 런을 보관하면 승인은 cancelled 로 닫힌다", async () => {
    const { app, adapter, channel, say, runs, archive } = await setup();
    await say("@dev 파일 써줘");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(1));
    const createdAt = new Date();
    const approval: ProviderApproval = {
      providerApprovalId: `plugin:${uuid()}`,
      kind: "plugin",
      sessionKey: adapter.sessionKeyFor("dev", channelConversation(app.db, channel.id)),
      providerAgentId: "dev",
      conversationId: channelConversation(app.db, channel.id),
      toolCallId: "toolu_channel_archive",
      toolName: "Write",
      pluginId: "fs",
      title: "Write 실행",
      description: "{}",
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      status: "pending",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 120_000).toISOString(),
    };
    adapter.emitApproval(approval);
    await vi.waitFor(() => expect(runs()[0]?.status).toBe("awaiting_approval"));

    await archive();
    await vi.waitFor(() => expect(runs()[0]?.status).toBe("aborted"));
    const rows = app.db.$client
      .prepare("SELECT status FROM approvals WHERE run_id = ?")
      .all(runs()[0]?.id) as Array<{ status: string }>;
    expect(rows).toEqual([{ status: "cancelled" }]);
  });

  it("런 관문이 보관한 채널을 막는다 — 라우터 판정을 지난 계획이 늦게 와도 런 행이 생기지 않는다", async () => {
    const { app, dev, channel, runs, archive } = await setup();
    await archive();
    const gate = createRunGate({
      db: app.db,
      bus: app.bus,
      ops: app.services.ops,
      workspaceId: app.workspaceId,
      enqueue: (plan, trigger) => app.services.orchestrator.enqueueRun(plan, trigger),
    });
    const enqueued = await gate.enqueue(
      {
        agentId: dev.id,
        channelId: channel.id,
        conversationId: channelConversation(app.db, channel.id),
        triggerKind: "mention",
        rootMessageId: uuid(),
        relayDepth: 0,
      },
      {},
    );
    expect(enqueued).toBeNull();
    expect(runs()).toHaveLength(0);
  });

  it("보관 쓰기만 하고 훑기 전에 대기 런이 디스패치 차례를 받아도 보내지 않고 「중지」로 닫는다", async () => {
    const { app, adapter, channel, say, runs, openRuns } = await setup();
    await say("@dev 하나");
    await say("@dev 둘");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(1));
    app.db.$client.prepare("UPDATE channels SET archived_at = ? WHERE id = ?").run(Date.now(), channel.id);
    const [inflight] = runs();
    await app.services.orchestrator.signal(inflight?.id ?? "", {
      kind: "gateway_error",
      code: "X",
      message: "x",
    });
    await vi.waitFor(() => expect(openRuns()).toHaveLength(0));
    expect(runs()[1]?.status).toBe("aborted");
    expect(adapter.calls.send).toHaveLength(1);
  });

  it("보관한 채널의 늦은 정본은 저장만 한다 — 릴레이·푸시 없음, 보관 해제 뒤에 온 정본은 지금처럼 릴레이·푸시", async () => {
    const pushes: unknown[] = [];
    const { app, adapter, headers, inject, channel, say, runs, archive, unarchive } = await setup({
      pushSend: async (sub) => {
        pushes.push(sub);
        return { statusCode: 201 };
      },
    });
    const subscribed = await inject(
      "POST",
      "/api/v1/push/subscriptions",
      {
        endpoint: "https://push.invalid/channel-archive",
        keys: {
          p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
          auth: "tBHItJI5svbpez7KI4CCXg",
        },
      },
      headers,
    );
    expect(subscribed.statusCode).toBe(204);
    await say("@dev 정리해 줘");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(1));
    const [run] = runs();
    await archive();
    await vi.waitFor(() => expect(runs()[0]?.status).toBe("aborted"));
    const created: Array<{ message: Message; silent?: true }> = [];
    app.bus.on("message.created", (p) => created.push(p));
    const late = (outboundId: string, runId: string | undefined = run?.id): OutboundMessage => ({
      outboundId,
      conversationId: channelConversation(app.db, channel.id),
      agentId: "dev",
      sessionKey: run?.sessionKey ?? "",
      runId: runId ?? "",
      // 릴레이(@fin)와 푸시(@owner)가 날 수 있는 본문
      text: "@fin @owner 늦었지만 정리했습니다",
      attachmentIds: [],
      ts: new Date().toISOString(),
    });

    const ack = await app.orchestrator.onCanonical(late("late-archived"), "openclaw", FAKE_GATEWAY_ID);
    // 그 채널 세션의 런을 모르는 정본도 보관한 채널이면 조용히 저장만(다른 채널 세션의 새 글은 아래 테스트 — 거절)
    await app.orchestrator.onCanonical(late("late-no-run", uuid()), "openclaw", FAKE_GATEWAY_ID);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ack.messageId).toBeDefined();
    expect(created).toEqual([
      expect.objectContaining({ silent: true }),
      expect.objectContaining({ silent: true }),
    ]);
    expect(runs()).toHaveLength(1);
    expect(adapter.calls.send).toHaveLength(1);
    expect(pushes).toEqual([]);

    await unarchive();
    await app.orchestrator.onCanonical(late("late-unarchived"), "openclaw", FAKE_GATEWAY_ID);
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(2));
    await vi.waitFor(() => expect(pushes).toHaveLength(1));
  });

  it("다른 채널 세션의 에이전트가 보관한 채널에 쓰는 런 없는 새 글은 CHANNEL_ARCHIVED 로 거절한다 — 같은 채널 세션(스레드 포함)의 런 없는 답은 저장만", async () => {
    const { app, channel, say, archive } = await setup();
    const root = await say("스레드 루트");
    const other = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: "other",
    });
    await archive();
    const created: Array<{ message: Message; silent?: true }> = [];
    app.bus.on("message.created", (p) => created.push(p));
    const post = (outboundId: string, sessionKey: string, threadId?: string): OutboundMessage => ({
      outboundId,
      conversationId: channelConversation(app.db, channel.id),
      ...(threadId === undefined ? {} : { threadId }),
      agentId: "dev",
      sessionKey,
      runId: uuid(),
      text: "#archive 에 올립니다",
      attachmentIds: [],
      ts: new Date().toISOString(),
    });
    const stored = (outboundId: string) =>
      app.db.$client.prepare("SELECT count(*) AS n FROM messages WHERE external_id = ?").get(outboundId) as {
        n: number;
      };

    await expect(
      app.orchestrator.onCanonical(
        post("cross-channel", dodokSessionKey("dev", channelConversation(app.db, other.id))),
        "openclaw",
        FAKE_GATEWAY_ID,
      ),
    ).rejects.toMatchObject({ code: "CHANNEL_ARCHIVED" });
    expect(stored("cross-channel").n).toBe(0);
    // 세션 키를 풀 수 없으면 어느 채널의 답인지 모른다 — 새 글로 보고 거절한다
    await expect(
      app.orchestrator.onCanonical(post("unparsable", "agent:dev:main"), "openclaw", FAKE_GATEWAY_ID),
    ).rejects.toMatchObject({ code: "CHANNEL_ARCHIVED" });
    expect(stored("unparsable").n).toBe(0);
    expect(created).toEqual([]);

    await app.orchestrator.onCanonical(
      post("same-thread", dodokSessionKey("dev", channelConversation(app.db, channel.id), root.id), root.id),
      "openclaw",
      FAKE_GATEWAY_ID,
    );
    expect(stored("same-thread").n).toBe(1);
    expect(created).toEqual([expect.objectContaining({ silent: true })]);
  });

  it("보관한 채널을 겨눈 승인 요청은 푸시하지 않는다", async () => {
    const pushes: unknown[] = [];
    const { app, headers, inject, channel, archive } = await setup({
      pushSend: async (sub) => {
        pushes.push(sub);
        return { statusCode: 201 };
      },
    });
    await inject(
      "POST",
      "/api/v1/push/subscriptions",
      {
        endpoint: "https://push.invalid/channel-archive-approval",
        keys: {
          p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
          auth: "tBHItJI5svbpez7KI4CCXg",
        },
      },
      headers,
    );
    const request = () => {
      const now = new Date().toISOString();
      app.bus.emit("approval.requested", {
        approval: {
          id: uuid(),
          providerApprovalId: `plugin:${uuid()}`,
          runId: uuid(),
          channelId: channel.id,
          conversationId: channelConversation(app.db, channel.id),
          agentId: uuid(),
          kind: "plugin",
          toolName: "Write",
          title: "Write",
          severity: "warning",
          allowedDecisions: ["allow-once", "deny"],
          status: "pending",
          createdAt: now,
          expiresAt: now,
        },
      });
    };
    // 살아 있는 채널이면 간다 — 아래 「안 감」이 구독 탓이 아님을 먼저 본다
    request();
    await vi.waitFor(() => expect(pushes).toHaveLength(1));
    await archive();
    request();
    expect(pushes).toHaveLength(1);
  });

  it("보관 → 보관 해제 → 멘션은 같은 agent_sessions 행·세션 키로 런을 만든다", async () => {
    const { app, adapter, dev, channel, say, runs, archive, unarchive } = await setup();
    await say("@dev 처음");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(1));
    const sessionRows = () =>
      app.db.$client
        .prepare(
          "SELECT id, session_key AS sessionKey FROM agent_sessions WHERE channel_id = ? AND agent_id = ?",
        )
        .all(channel.id, dev.id);
    const before = sessionRows();
    expect(before).toHaveLength(1);

    await archive();
    await vi.waitFor(() => expect(runs()[0]?.status).toBe("aborted"));
    expect(sessionRows()).toEqual(before);
    expect((await unarchive()).statusCode).toBe(200);

    await say("@dev 다시");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(2));
    expect(sessionRows()).toEqual(before);
    const { sessionKey } = (before as Array<{ sessionKey: string }>)[0] ?? { sessionKey: "" };
    expect(runs()[1]?.sessionKey).toBe(sessionKey);
  });
});

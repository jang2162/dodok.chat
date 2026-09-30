import type { ComponentsV1, Message } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { messages } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { createAgentMessage, createUserMessage } from "../src/modules/messages/service";
import { bootTestApp, login } from "./helpers/app";
import { connectWire, type WireClient } from "./helpers/wire";

/**
 * 계약이 카드 id constructor·__proto__ 를 거절하기 전에 저장된 옛 행 — 쓰기 경계만 거절하고 읽기는 받는다.
 * 그 행 하나가 그 메시지가 든 페이지(채널·스레드 목록, wire 이어 받기)를 500 으로 만들면 안 된다
 */
describe.each(["constructor", "__proto__"])("옛 카드 id %s", (bad) => {
  let app: App;
  let headers: { authorization: string };
  let token: string;
  const sockets: WireClient[] = [];
  const logger = { warn: () => {}, error: () => {} };
  let n = 0;

  beforeAll(async () => {
    app = await bootTestApp();
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    ({ token, headers } = await login(app));
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });
  afterAll(async () => {
    await app.close();
  });

  const api = (url: string) => app.fastify.inject({ method: "GET", url: `/api/v1${url}`, headers });

  /** 지금 계약으로 카드를 만든 뒤 행을 직접 고쳐 옛 id 를 넣는다 — 거절 전 판이 저장했던 모양 */
  function legacyCard(
    components: ComponentsV1Input,
    rename: Record<string, string>,
    consumed: string[] = [],
  ) {
    const channel = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: `legacy-${++n}`,
    });
    const handle = `legacy${n}`;
    const agent = createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId: handle,
      handle,
      name: handle,
    });
    addMember(app.db, channel.id, { memberType: "agent", memberId: agent.id }, logger);
    const created = createAgentMessage(app.db, app.bus, {
      channelId: channel.id,
      agentId: agent.id,
      externalId: `legacy-out-${n}`,
      bodyMd: "옛 카드",
      components,
    });
    let json = JSON.stringify(created.components);
    for (const [from, to] of Object.entries(rename)) json = json.replaceAll(`"id":"${from}"`, `"id":"${to}"`);
    const state = created.componentState;
    if (!state) throw new Error("componentState 없음");
    app.db
      .update(messages)
      .set({ components: JSON.parse(json) as ComponentsV1, componentState: { ...state, consumed } })
      .where(eq(messages.id, created.id))
      .run();
    return { channel, message: created };
  }

  const buttons: ComponentsV1Input = {
    blocks: [
      {
        type: "actions",
        items: [
          { type: "button", id: "old", label: "옛 버튼" },
          { type: "button", id: "go", label: "진행" },
        ],
      },
    ],
  };
  const modal: ComponentsV1Input = {
    modal: {
      id: "form",
      title: "양식",
      triggerLabel: "열기",
      fields: [
        { type: "text", id: "old", label: "옛 칸" },
        { type: "text", id: "note", label: "메모" },
      ],
    },
  };
  const cardOf = (page: { messages: Message[] }, id: string) => page.messages.find((m) => m.id === id);

  it("채널·스레드 목록은 200 이고 그 카드를 그대로 싣는다", async () => {
    const { channel, message } = legacyCard(buttons, { old: bad }, [bad]);
    createUserMessage(app.db, app.bus, {
      channelId: channel.id,
      authorId: app.ownerUserId,
      bodyMd: "스레드 답글",
      clientMsgId: `legacy-reply-${n}`,
      threadRootId: message.id,
    });

    const list = await api(`/channels/${channel.id}/messages?limit=50`);
    expect(list.statusCode, list.body).toBe(200);
    const card = cardOf(list.json(), message.id);
    expect(card?.components?.blocks[0]).toMatchObject({ items: [{ id: bad }, { id: "go" }] });
    expect(card?.componentState?.consumed).toEqual([bad]);

    const thread = await api(`/channels/${channel.id}/threads/${message.id}/messages?limit=50`);
    expect(thread.statusCode, thread.body).toBe(200);
    expect((thread.json() as { root: Message }).root.components?.blocks[0]).toMatchObject({
      items: [{ id: bad }, { id: "go" }],
    });
  });

  it("wire 이어 받기(lastSeq)도 그 카드를 싣는다", async () => {
    const { channel, message } = legacyCard(modal, { old: bad });
    const socket = await connectWire(app, token);
    sockets.push(socket);
    const res = await socket.emitWithAck("channel.subscribe", { channelId: channel.id, lastSeq: 0 });
    if (!res.ok) throw new Error(`subscribe 실패: ${res.error.code} ${res.error.message}`);
    const card = cardOf(res.data, message.id);
    expect(card?.components?.modal?.fields.map((f) => f.id)).toEqual([bad, "note"]);
  });

  it("그 카드의 다른 아이템은 누를 수 있고, 옛 id 아이템·옛 id 칸이 든 모달은 VALIDATION", async () => {
    const socket = await connectWire(app, token);
    sockets.push(socket);
    const interact = (message: Message, itemId: string, values: Record<string, unknown>) =>
      socket.emitWithAck("component.interact", {
        messageId: message.id,
        componentId: message.components?.id ?? "",
        itemId,
        values,
      });

    const { message } = legacyCard(buttons, { old: bad });
    expect(await interact(message, "go", {})).toMatchObject({ ok: true });
    expect(await interact(message, bad, {})).toMatchObject({ ok: false, error: { code: "VALIDATION" } });

    const form = legacyCard(modal, { old: bad }).message;
    expect(await interact(form, "form", { fields: { note: "x" } })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
  });

  it("새로 쓰려는 카드는 여전히 VALIDATION", () => {
    const channel = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: `legacy-new-${++n}`,
    });
    const handle = `fresh${n}`;
    const agent = createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId: handle,
      handle,
      name: handle,
    });
    expect(() =>
      createAgentMessage(app.db, app.bus, {
        channelId: channel.id,
        agentId: agent.id,
        externalId: `fresh-out-${n}`,
        bodyMd: "새 카드",
        components: { blocks: [{ type: "actions", items: [{ type: "button", id: bad, label: "B" }] }] },
      }),
    ).toThrow(
      expect.objectContaining({
        body: expect.objectContaining({
          code: "VALIDATION",
          details: {
            issues: [{ path: "blocks.0.items.0.id", message: "id 로 constructor·__proto__ 는 쓸 수 없다" }],
          },
        }),
      }),
    );
  });
});

type ComponentsV1Input = NonNullable<Parameters<typeof createAgentMessage>[2]["components"]>;

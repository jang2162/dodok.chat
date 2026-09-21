import { INTERACTIONS_MAX, Message } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client";
import { componentInteractions } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import {
  createAgentMessage,
  createSystemMessage,
  createUserMessage,
  getMessage,
  listMessages,
  withInteractions,
} from "../src/modules/messages/service";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

function setup() {
  const db = newTestDb();
  const bus = new ServerBus();
  const created: Message[] = [];
  bus.on("message.created", ({ message }) => created.push(message));
  const { workspaceId, userId } = seedWorkspace(db, { userHandle: "jang" });
  const logger = { warn: vi.fn() };
  const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
  const dev = createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev", name: "Dev" });
  addMember(db, channel.id, { memberType: "agent", memberId: dev.id, aliases: ["reviewer"] }, logger);
  return { db, bus, created, userId, channelId: channel.id, devId: dev.id };
}

afterEach(() => {
  vi.useRealTimers();
});

const CARD = {
  blocks: [{ type: "actions" as const, items: [{ type: "button" as const, id: "ok", label: "OK" }] }],
};

/** component_interactions 에 한 줄을 바로 넣는다 — interact() 의 검사·런 전달 없이 하이드레이션만 볼 때 */
function insertInteraction(db: Db, message: Message, userId: string, itemId: string, createdAt: Date): void {
  db.insert(componentInteractions)
    .values({
      id: uuid(),
      messageId: message.id,
      componentId: message.components?.id ?? "",
      userId,
      itemId,
      values: {},
      createdAt,
    })
    .run();
}

describe("messages service", () => {
  it("createUserMessage 는 seq 를 1·2 로 발급하고 @handle 을 토큰으로 바꿔 mentions 를 채운다", () => {
    const { db, bus, created, userId, channelId, devId } = setup();
    const first = createUserMessage(db, bus, {
      channelId,
      authorId: userId,
      bodyMd: "@dev 안녕",
      clientMsgId: "c1",
    });
    const second = createUserMessage(db, bus, {
      channelId,
      authorId: userId,
      bodyMd: "@reviewer 와 @jang, `@dev` 는 코드",
      clientMsgId: "c2",
    });

    expect(Message.parse(first)).toEqual(first);
    expect(first).toMatchObject({
      seq: 1,
      kind: "normal",
      authorType: "user",
      authorId: userId,
      bodyMd: `<@a:${devId}> 안녕`,
      mentions: { agents: [devId], users: [] },
      attachments: [],
      clientMsgId: "c1",
    });
    expect(second.seq).toBe(2);
    expect(second.bodyMd).toBe(`<@a:${devId}> 와 <@u:${userId}>, \`@dev\` 는 코드`);
    expect(second.mentions).toEqual({ agents: [devId], users: [userId] });
    expect(created.map((m) => m.id)).toEqual([first.id, second.id]);
    expect(getMessage(db, first.id)).toEqual(first);
    expect(getMessage(db, uuid())).toBeUndefined();
  });

  it("같은 clientMsgId 재호출은 같은 행을 돌려주고 seq·이벤트를 더 쓰지 않는다", () => {
    const { db, bus, created, userId, channelId } = setup();
    const input = { channelId, authorId: userId, bodyMd: "hi", clientMsgId: "same" };
    const a = createUserMessage(db, bus, input);
    const b = createUserMessage(db, bus, { ...input, bodyMd: "다른 본문" });
    expect(b).toEqual(a);
    expect(created).toHaveLength(1);
    expect(createUserMessage(db, bus, { ...input, clientMsgId: "next" }).seq).toBe(2);
  });

  it("없는 채널이면 NOT_FOUND, 첨부가 있으면 VALIDATION — 둘 다 저장·이벤트가 없다", () => {
    const { db, bus, created, userId, channelId } = setup();
    expect(() =>
      createUserMessage(db, bus, { channelId: uuid(), authorId: userId, bodyMd: "x", clientMsgId: "c" }),
    ).toThrow(expect.objectContaining({ status: 404 }));
    expect(() =>
      createUserMessage(db, bus, {
        channelId,
        authorId: userId,
        bodyMd: "x",
        clientMsgId: "c",
        attachments: [uuid()],
      }),
    ).toThrow(expect.objectContaining({ status: 400 }));
    expect(created).toHaveLength(0);
    expect(listMessages(db, channelId, { limit: 10 }).messages).toEqual([]);
  });

  it("createAgentMessage 는 externalId 로 중복을 흡수하고 components 에 id·componentState 를 붙인다", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    const { db, bus, created, userId, channelId, devId } = setup();
    const runId = uuid();
    const input = {
      channelId,
      agentId: devId,
      runId,
      externalId: "out-1",
      bodyMd: "@jang 골라 주세요",
      components: {
        ttlMs: 60_000,
        blocks: [{ type: "actions" as const, items: [{ type: "button" as const, id: "ok", label: "OK" }] }],
      },
    };
    const a = createAgentMessage(db, bus, input);
    expect(Message.parse(a)).toEqual(a);
    expect(a).toMatchObject({
      seq: 1,
      kind: "normal",
      authorType: "agent",
      authorId: devId,
      runId,
      externalId: "out-1",
      bodyMd: `<@u:${userId}> 골라 주세요`,
      mentions: { agents: [], users: [userId] },
      componentState: { expiresAt: "2026-09-15T00:01:00.000Z", consumed: [] },
    });
    expect(a.components?.id).toMatch(/^cmp_[0-9a-f-]{36}$/);
    expect(a.components?.reusable).toBe(false);

    const again = createAgentMessage(db, bus, { ...input, bodyMd: "재전송" });
    expect(again).toEqual(a);
    expect(created).toHaveLength(1);

    const plain = createAgentMessage(db, bus, {
      channelId,
      agentId: devId,
      externalId: "out-2",
      bodyMd: "끝",
    });
    expect(plain.seq).toBe(2);
    expect(plain.components).toBeUndefined();
    expect(plain.componentState).toBeUndefined();
  });

  it("components 에 ttlMs 가 없으면 30분 뒤 만료", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    const { db, bus, channelId, devId } = setup();
    const m = createAgentMessage(db, bus, {
      channelId,
      agentId: devId,
      externalId: "out-ttl",
      bodyMd: "x",
      components: { blocks: [{ type: "actions", items: [{ type: "button", id: "go", label: "Go" }] }] },
    });
    expect(m.componentState?.expiresAt).toBe("2026-09-15T00:30:00.000Z");
  });

  it("createSystemMessage 는 authorId 없이 system 종류와 systemMeta 를 저장한다", () => {
    const { db, bus, created, channelId, devId } = setup();
    const runId = uuid();
    const m = createSystemMessage(db, bus, {
      channelId,
      kind: "run_error",
      bodyMd: "@dev 실행이 실패했습니다",
      systemMeta: { runId },
    });
    expect(Message.parse(m)).toEqual(m);
    expect(m).toMatchObject({
      seq: 1,
      kind: "system",
      authorType: "system",
      bodyMd: "@dev 실행이 실패했습니다",
      mentions: { agents: [], users: [] },
      systemMeta: { kind: "run_error", runId },
    });
    expect(m.authorId).toBeUndefined();
    expect(created).toHaveLength(1);

    const relay = { fromAgentId: devId, toAgentId: devId, sourceRunId: runId, rootMessageId: m.id };
    const withButton = createSystemMessage(db, bus, {
      channelId,
      kind: "relay_limit",
      bodyMd: "릴레이 상한",
      systemMeta: { kind: "relay_limit", relay },
      components: {
        blocks: [{ type: "actions", items: [{ type: "button", id: "continue_relay", label: "이어가기" }] }],
      },
    });
    expect(withButton.systemMeta).toEqual({ kind: "relay_limit", relay });
    expect(withButton.componentState?.consumed).toEqual([]);
    expect(created).toHaveLength(2);
  });

  it("listMessages 는 beforeSeq 미만·afterSeq 초과를 seq 오름차순으로 잘라 hasMore 를 준다", () => {
    const { db, bus, userId, channelId } = setup();
    for (let i = 1; i <= 5; i++) {
      createUserMessage(db, bus, { channelId, authorId: userId, bodyMd: `m${i}`, clientMsgId: `c${i}` });
    }
    const seqs = (page: { messages: Message[] }) => page.messages.map((m) => m.seq);

    const before = listMessages(db, channelId, { beforeSeq: 3, limit: 2 });
    expect(seqs(before)).toEqual([1, 2]);
    expect(before.hasMore).toBe(false);

    const olderMore = listMessages(db, channelId, { beforeSeq: 5, limit: 2 });
    expect(seqs(olderMore)).toEqual([3, 4]);
    expect(olderMore.hasMore).toBe(true);

    const latest = listMessages(db, channelId, { limit: 2 });
    expect(seqs(latest)).toEqual([4, 5]);
    expect(latest.hasMore).toBe(true);

    const after = listMessages(db, channelId, { afterSeq: 1, limit: 2 });
    expect(seqs(after)).toEqual([2, 3]);
    expect(after.hasMore).toBe(true);
    expect(listMessages(db, channelId, { afterSeq: 3, limit: 2 })).toMatchObject({ hasMore: false });
    expect(seqs(listMessages(db, channelId, { afterSeq: 0, limit: 200 }))).toEqual([1, 2, 3, 4, 5]);
    expect(seqs(listMessages(db, channelId, { afterSeq: 1, beforeSeq: 4, limit: 50 }))).toEqual([2, 3]);
    expect(listMessages(db, uuid(), { limit: 10 })).toEqual({ messages: [], hasMore: false });
  });

  it("withInteractions — components 있는 메시지에만 붙고, 최신 20건이 오름차순", () => {
    const { db, bus, userId, channelId, devId } = setup();
    const card = (externalId: string) =>
      createAgentMessage(db, bus, {
        channelId,
        agentId: devId,
        externalId,
        bodyMd: "골라",
        components: CARD,
      });
    const msgWithComponents = card("out-c");
    const other = card("out-other");
    const msgPlain = createAgentMessage(db, bus, {
      channelId,
      agentId: devId,
      externalId: "out-p",
      bodyMd: "끝",
    });
    // 21건을 createdAt 이 1분씩 늘게 — 넣는 순서는 거꾸로라 행 순서·id 순서로는 정렬이 맞지 않는다
    const t0 = Date.parse("2026-09-21T00:00:00.000Z");
    for (let i = 20; i >= 0; i--) {
      insertInteraction(
        db,
        msgWithComponents,
        userId,
        i === 0 ? "oldest" : `n${i}`,
        new Date(t0 + i * 60_000),
      );
    }
    insertInteraction(db, other, userId, "ok", new Date(t0));

    const [withC, otherC, plain] = withInteractions(db, [msgWithComponents, other, msgPlain]);
    if (!withC || !otherC || !plain) throw new Error("메시지 셋이 그대로 돌아와야 한다");
    expect(withC.interactions).toHaveLength(INTERACTIONS_MAX);
    expect((withC.interactions[0]?.createdAt ?? "") < (withC.interactions[19]?.createdAt ?? "")).toBe(true);
    // 잘린 것은 가장 오래된 1건 — 최신 20건이 오름차순으로 남는다
    expect(withC.interactions.some((i) => i.itemId === "oldest")).toBe(false);
    expect(withC.interactions.map((i) => i.itemId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `n${i + 1}`),
    );
    expect(withC.interactions[0]).toEqual({
      id: expect.any(String),
      componentId: msgWithComponents.components?.id,
      userId,
      itemId: "n1",
      values: {},
      createdAt: "2026-09-21T00:01:00.000Z",
    });
    expect(Message.parse(withC)).toEqual(withC);
    // 메시지별로 나뉜다
    expect(otherC.interactions.map((i) => i.itemId)).toEqual(["ok"]);
    expect(plain.interactions).toEqual([]);
  });

  it("components 가 하나도 없으면 질의하지 않는다", () => {
    const { db, bus, userId, channelId } = setup();
    const msgPlain = createUserMessage(db, bus, {
      channelId,
      authorId: userId,
      bodyMd: "hi",
      clientMsgId: "c1",
    });
    const spy = vi.spyOn(db, "select");
    expect(withInteractions(db, [msgPlain])).toEqual([msgPlain]);
    expect(withInteractions(db, [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("listMessages 는 components 카드에 상호작용 기록을 싣는다 — REST 히스토리·구독 ack 가 이 경로다", () => {
    const { db, bus, userId, channelId, devId } = setup();
    createUserMessage(db, bus, { channelId, authorId: userId, bodyMd: "골라 줘", clientMsgId: "c1" });
    const card = createAgentMessage(db, bus, {
      channelId,
      agentId: devId,
      externalId: "out-1",
      bodyMd: "골라",
      components: CARD,
    });
    insertInteraction(db, card, userId, "ok", new Date());

    const [user, listed] = listMessages(db, channelId, { limit: 50 }).messages;
    expect(user?.interactions).toEqual([]);
    expect(listed?.interactions).toMatchObject([{ userId, itemId: "ok", componentId: card.components?.id }]);
    // 서버 내부 읽기(getMessage)는 거치지 않는다
    expect(getMessage(db, card.id)?.interactions).toEqual([]);
  });

  it("listMessages 의 limit 은 200 을 넘지 않는다", () => {
    const { db, bus, userId, channelId } = setup();
    for (let i = 1; i <= 201; i++) {
      createUserMessage(db, bus, { channelId, authorId: userId, bodyMd: "m", clientMsgId: `c${i}` });
    }
    const page = listMessages(db, channelId, { afterSeq: 0, limit: 1000 });
    expect(page.messages).toHaveLength(200);
    expect(page.hasMore).toBe(true);
  });
});

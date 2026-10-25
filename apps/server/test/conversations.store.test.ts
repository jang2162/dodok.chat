import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { conversations } from "../src/db/schema.sqlite";
import { createChannel } from "../src/modules/channels/service";
import { getConversation, latestOpenConversation } from "../src/modules/conversations/store";
import { createSystemMessage, createUserMessage } from "../src/modules/messages/service";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { seedConversation, seedWorkspace } from "./helpers/seed";

const T0 = new Date("2026-10-25T00:00:00.000Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);

function setup() {
  const db = newTestDb();
  const bus = new ServerBus();
  const { workspaceId, userId } = seedWorkspace(db, { userHandle: "mia" });
  const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
  // 채널의 첫 대화 — 채널을 만들어도 대화는 생기지 않는다(채널 세션 스펙 결정 7)
  const first = seedConversation(db, channel.id, { createdAt: at(0) });
  /** 같은 채널의 둘째 대화 — 저장소 테스트라 행만 넣는다 */
  const addConversation = (createdAt: Date) => {
    const id = uuid();
    db.insert(conversations)
      .values({
        id,
        channelId: channel.id,
        title: "둘째",
        titleSource: "user",
        createdByType: "user",
        createdById: userId,
        createdAt,
      })
      .run();
    return id;
  };
  const close = (id: string) =>
    db
      .update(conversations)
      .set({ closedAt: at(100), closedBy: userId })
      .where(eq(conversations.id, id))
      .run();
  let n = 0;
  const say = (conversationId: string, threadRootId?: string) =>
    createUserMessage(db, bus, {
      conversationId,
      authorId: userId,
      bodyMd: `m${++n}`,
      clientMsgId: `c${n}`,
      ...(threadRootId === undefined ? {} : { threadRootId }),
    });
  return { db, bus, workspaceId, userId, channel, first, addConversation, close, say };
}

describe("conversations store", () => {
  it("createChannel 은 대화를 만들지 않는다 — 빈 세션은 없다. getConversation 은 워크스페이스로 가린다", () => {
    const db = newTestDb();
    const { workspaceId, userId } = seedWorkspace(db, { userHandle: "mia" });
    const channel = createChannel(db, { workspaceId, createdBy: userId, name: "empty" });
    expect(db.select().from(conversations).where(eq(conversations.channelId, channel.id)).all()).toEqual([]);
    expect(latestOpenConversation(db, channel.id)).toBeUndefined();

    const id = seedConversation(db, channel.id, { createdAt: at(0), title: "배포" });
    expect(getConversation(db, id, workspaceId)).toEqual({
      id,
      channelId: channel.id,
      title: "배포",
      titleSource: "user",
      createdBy: { type: "user", id: userId },
      createdAt: at(0).toISOString(),
      lastSeq: 0,
    });
    // 다른 워크스페이스로 물으면 없다
    expect(getConversation(db, id, uuid())).toBeUndefined();
    expect(getConversation(db, uuid())).toBeUndefined();
  });

  it("latestOpenConversation 은 닫힌 대화를 건너뛰고 최근 활동(last_message_at, 없으면 created_at)순으로 고른다", () => {
    const { db, channel, first: legacy, addConversation, close, say } = setup();
    // 둘째 대화가 더 늦게 만들어졌다 — 메시지가 없으면 만든 시각으로 견준다
    const second = addConversation(at(10_000));
    expect(latestOpenConversation(db, channel.id)).toBe(second);
    // 「이전 대화」에 글이 오면 그쪽이 최근이다
    say(legacy);
    db.update(conversations)
      .set({ lastMessageAt: at(20_000) })
      .where(eq(conversations.id, legacy))
      .run();
    expect(latestOpenConversation(db, channel.id)).toBe(legacy);
    close(legacy);
    expect(latestOpenConversation(db, channel.id)).toBe(second);
    close(second);
    expect(latestOpenConversation(db, channel.id)).toBeUndefined();
    expect(latestOpenConversation(db, uuid())).toBeUndefined();
  });

  it("메시지를 저장하면 그 대화의 last_seq·last_message_at 이 오른다 — 스레드 답글도. 시스템 메시지는 last_seq 만", () => {
    const { db, bus, workspaceId, first: conversation, addConversation, say } = setup();
    const second = addConversation(at(1));
    const first = say(conversation);
    expect(getConversation(db, conversation, workspaceId)).toMatchObject({
      lastSeq: first.seq,
      lastMessageAt: first.createdAt,
    });
    // seq 는 채널 하나를 같이 쓴다 — 다른 대화의 글은 이 대화를 건드리지 않는다
    const elsewhere = say(second);
    expect(elsewhere.seq).toBe(first.seq + 1);
    expect(getConversation(db, conversation, workspaceId)?.lastSeq).toBe(first.seq);
    expect(getConversation(db, second, workspaceId)?.lastSeq).toBe(elsewhere.seq);
    const reply = say(conversation, first.id);
    const notice = createSystemMessage(db, bus, {
      conversationId: conversation,
      kind: "info",
      bodyMd: "알림",
      createdAt: at(50_000),
    });
    expect(reply.seq).toBeLessThan(notice.seq);
    // 활동 시각은 사람·에이전트의 글(답글)에서 멈춘다 — 서버 알림이 세션을 목록 위로 올리지 않게
    expect(getConversation(db, conversation, workspaceId)).toMatchObject({
      lastSeq: notice.seq,
      lastMessageAt: reply.createdAt,
    });
  });

  it("다른 대화의 루트로 답글을 저장하면 VALIDATION 이고 아무것도 남지 않는다", () => {
    const { db, workspaceId, first, addConversation, say } = setup();
    const second = addConversation(at(1));
    const root = say(first);
    expect(() => say(second, root.id)).toThrow(expect.objectContaining({ status: 400 }));
    expect(getConversation(db, second, workspaceId)?.lastSeq).toBe(0);
    // 같은 대화의 루트면 받는다
    expect(say(first, root.id).conversationId).toBe(first);
  });

  it("없는 대화에 보내면 NOT_FOUND", () => {
    const { say } = setup();
    expect(() => say(uuid())).toThrow(expect.objectContaining({ status: 404 }));
  });
});

import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { conversations } from "../src/db/schema.sqlite";
import { createChannel } from "../src/modules/channels/service";
import { getConversation, latestOpenConversation } from "../src/modules/conversations/store";
import { createSystemMessage, createUserMessage } from "../src/modules/messages/service";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

const T0 = new Date("2026-10-25T00:00:00.000Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);

function setup() {
  const db = newTestDb();
  const bus = new ServerBus();
  const { workspaceId, userId } = seedWorkspace(db, { userHandle: "mia" });
  const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
  /** 같은 채널의 둘째 대화 — 세션 만들기 경로는 태스크 3 이 들인다. 여기서는 행만 넣는다 */
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
  return { db, bus, workspaceId, userId, channel, addConversation, close, say };
}

describe("conversations store", () => {
  it("createChannel 은 같은 트랜잭션에서 id 가 채널 id 인 「이전 대화」를 만든다", () => {
    const { db, workspaceId, userId, channel } = setup();
    expect(getConversation(db, channel.id, workspaceId)).toEqual({
      id: channel.id,
      channelId: channel.id,
      title: "이전 대화",
      titleSource: "user",
      createdBy: { type: "user", id: userId },
      createdAt: channel.createdAt,
      lastSeq: 0,
    });
    // 다른 워크스페이스로 물으면 없다
    expect(getConversation(db, channel.id, uuid())).toBeUndefined();
    expect(getConversation(db, uuid())).toBeUndefined();
  });

  it("latestOpenConversation 은 닫힌 대화를 건너뛰고 최근 활동(last_message_at, 없으면 created_at)순으로 고른다", () => {
    const { db, channel, addConversation, close, say } = setup();
    const legacy = channel.id;
    // 시각은 실제 시계와 상관없게 고정한다
    db.update(conversations)
      .set({ createdAt: at(0) })
      .where(eq(conversations.id, legacy))
      .run();
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

  it("메시지를 저장하면 그 대화의 last_seq·last_message_at 이 오른다 — 시스템 메시지·스레드 답글도", () => {
    const { db, bus, workspaceId, channel, addConversation, say } = setup();
    const second = addConversation(at(1));
    const first = say(channel.id);
    expect(getConversation(db, channel.id, workspaceId)).toMatchObject({
      lastSeq: first.seq,
      lastMessageAt: first.createdAt,
    });
    // seq 는 채널 하나를 같이 쓴다 — 다른 대화의 글은 이 대화를 건드리지 않는다
    const elsewhere = say(second);
    expect(elsewhere.seq).toBe(first.seq + 1);
    expect(getConversation(db, channel.id, workspaceId)?.lastSeq).toBe(first.seq);
    expect(getConversation(db, second, workspaceId)?.lastSeq).toBe(elsewhere.seq);
    const reply = say(channel.id, first.id);
    const notice = createSystemMessage(db, bus, {
      conversationId: channel.id,
      kind: "info",
      bodyMd: "알림",
      createdAt: at(50_000),
    });
    expect(reply.seq).toBeLessThan(notice.seq);
    expect(getConversation(db, channel.id, workspaceId)).toMatchObject({
      lastSeq: notice.seq,
      lastMessageAt: notice.createdAt,
    });
  });

  it("다른 대화의 루트로 답글을 저장하면 VALIDATION 이고 아무것도 남지 않는다", () => {
    const { db, workspaceId, channel, addConversation, say } = setup();
    const second = addConversation(at(1));
    const root = say(channel.id);
    expect(() => say(second, root.id)).toThrow(expect.objectContaining({ status: 400 }));
    expect(getConversation(db, second, workspaceId)?.lastSeq).toBe(0);
    // 같은 대화의 루트면 받는다
    expect(say(channel.id, root.id).conversationId).toBe(channel.id);
  });

  it("없는 대화에 보내면 NOT_FOUND", () => {
    const { say } = setup();
    expect(() => say(uuid())).toThrow(expect.objectContaining({ status: 404 }));
  });
});

import type { Conversation, Message, TeamRole } from "@dodok/shared";
import { and, eq, isNull } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v7 as uuid } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeConversationManage } from "../src/auth/policies";
import { roleOf } from "../src/auth/roles";
import type { Db } from "../src/db/client";
import { attachments, channels, conversations, memberships, messages, users } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { uploadAttachment } from "../src/modules/attachments/service";
import { addMember, createChannel, setSessionManager, updateChannel } from "../src/modules/channels/service";
import { interact } from "../src/modules/components/service";
import {
  autoTitle,
  conversationActor,
  listConversations,
  renameConversation,
  resolveSendConversation,
  setConversationClosed,
} from "../src/modules/conversations/service";
import { getConversation, latestOpenConversation } from "../src/modules/conversations/store";
import { createAgentMessage, createSystemMessage, sendUserMessage } from "../src/modules/messages/service";
import { createRunGate } from "../src/modules/ops/budget";
import { setReaction } from "../src/modules/reactions/service";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { makePng } from "./helpers/png";
import { seedWorkspace } from "./helpers/seed";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function addUser(db: Db, workspaceId: string, handle: string, role: TeamRole = "member"): string {
  const id = uuid();
  db.insert(users)
    .values({ id, workspaceId, handle, displayName: handle, authProvider: "local", createdAt: new Date() })
    .run();
  db.insert(memberships).values({ id: uuid(), workspaceId, userId: id, role }).run();
  return id;
}

function setup() {
  const db = newTestDb();
  const bus = new ServerBus();
  const { workspaceId, userId: owner } = seedWorkspace(db, { userHandle: "owner" });
  db.insert(memberships).values({ id: uuid(), workspaceId, userId: owner, role: "owner" }).run();
  const mia = addUser(db, workspaceId, "mia");
  const noah = addUser(db, workspaceId, "noah");
  const channel = createChannel(db, { workspaceId, createdBy: owner, name: "general" });
  const dev = createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev", name: "Dev" });
  addMember(db, channel.id, { memberType: "agent", memberId: dev.id }, { warn: () => {} });
  const created: Conversation[] = [];
  const updated: Conversation[] = [];
  const messagesCreated: Message[] = [];
  bus.on("conversation.created", (p) => created.push(p.conversation));
  bus.on("conversation.updated", (p) => updated.push(p.conversation));
  bus.on("message.created", (p) => messagesCreated.push(p.message));
  let n = 0;
  /** socket.ts sendMessage 와 같은 조립 — 대화 고르기는 저장과 같은 트랜잭션에서 */
  const send = (
    opts: {
      userId?: string;
      role?: TeamRole;
      bodyMd?: string;
      clientMsgId?: string;
      conversationId?: string;
      newConversation?: { title?: string };
      threadRootId?: string;
      attachments?: string[];
    } = {},
  ) => {
    const userId = opts.userId ?? mia;
    const bodyMd = opts.bodyMd ?? `글 ${++n}`;
    return sendUserMessage(db, bus, {
      conversationId: (tx) =>
        resolveSendConversation(
          tx,
          {
            channelId: channel.id,
            userId,
            role: opts.role ?? roleOf(tx, workspaceId, userId),
            bodyMd,
            conversationId: opts.conversationId,
            newConversation: opts.newConversation,
            threadRootId: opts.threadRootId,
          },
          new Date(),
        ),
      authorId: userId,
      bodyMd,
      clientMsgId: opts.clientMsgId ?? `c${++n}`,
      threadRootId: opts.threadRootId,
      attachments: opts.attachments,
    });
  };
  const conversationRows = () =>
    db.select().from(conversations).where(eq(conversations.channelId, channel.id)).all();
  const abortConversation = vi.fn(async (_id: string) => {});
  const close = (conversationId: string, closed: boolean, byUserId = mia) =>
    setConversationClosed({ db, bus, runs: { abortConversation } }, { conversationId, byUserId, closed });
  return {
    db,
    bus,
    workspaceId,
    owner,
    mia,
    noah,
    channel,
    dev,
    created,
    updated,
    messagesCreated,
    send,
    conversationRows,
    abortConversation,
    close,
  };
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as { body?: { code?: string } }).body?.code;
  }
  return undefined;
};
const codeAsync = async (fn: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await fn();
  } catch (err) {
    return (err as { body?: { code?: string } }).body?.code;
  }
  return undefined;
};

describe("autoTitle — 첫 메시지 본문의 읽는 글 앞 40 코드 포인트", () => {
  const title = (bodyMd: string) => autoTitle(bodyMd, () => undefined);
  it("마크다운 표시를 걷고 줄바꿈을 공백으로, 비면 「새 세션」", () => {
    expect(title("@dev 안녕\n**굵게**")).toBe("@dev 안녕 굵게");
    expect(title("")).toBe("새 세션");
    expect(title("  \n ")).toBe("새 세션");
    expect(title("# 제목\n- [링크](https://x.example) `코드`")).toBe("제목 링크 코드");
  });
  it("45자 → 40 코드 포인트, 이모지(서로게이트 쌍)를 반으로 가르지 않는다", () => {
    expect(title("가".repeat(45))).toBe("가".repeat(40));
    const emoji = title("😀".repeat(45));
    expect([...emoji]).toHaveLength(40);
    expect(emoji).toBe("😀".repeat(40));
    expect(title(`${"가".repeat(39)}😀끝`)).toBe(`${"가".repeat(39)}😀`);
  });
  it("[낮음 3] 원문 멘션 토큰은 그 워크스페이스의 핸들로 — 토큰을 직접 싣는 클라이언트(wire-cli 등)의 첫 글. 모르는 id 는 「@알 수 없음」", () => {
    const t = setup();
    const agentToken = t.send({ newConversation: {}, bodyMd: `<@a:${t.dev.id}> 안녕` });
    expect(agentToken.conversation?.title).toBe("@dev 안녕");
    const userToken = t.send({ newConversation: {}, bodyMd: `<@u:${t.noah}> 봐 줘` });
    expect(userToken.conversation?.title).toBe("@noah 봐 줘");
    const unknown = t.send({ newConversation: {}, bodyMd: `<@u:${uuid()}> 누구` });
    expect(unknown.conversation?.title).toBe("@알 수 없음 누구");
  });
});

describe("세션 서비스", () => {
  it("채널을 만들어도 세션은 없다 — 다리(대화 없음)로 보내면 자동 제목 새 세션, 다음 보내기는 그 세션", () => {
    const t = setup();
    expect(t.conversationRows()).toEqual([]);
    const first = t.send({ bodyMd: "@dev 배포 일정\n잡아 줘" });
    expect(first.created).toBe(true);
    expect(first.conversation).toMatchObject({
      channelId: t.channel.id,
      title: "@dev 배포 일정 잡아 줘",
      titleSource: "auto",
      createdBy: { type: "user", id: t.mia },
      lastSeq: first.message.seq,
    });
    expect(first.message.conversationId).toBe(first.conversation?.id);
    const second = t.send();
    expect(second.conversation).toBeUndefined();
    expect(second.message.conversationId).toBe(first.conversation?.id);
    expect(t.conversationRows()).toHaveLength(1);
  });

  it("newConversation — 대화 행과 메시지가 함께 생기고 제목은 준 값(user), 안 주면 자동 제목. conversation.created 는 message.created 앞에 한 번", () => {
    const t = setup();
    const order: string[] = [];
    t.bus.on("conversation.created", () => order.push("conversation"));
    t.bus.on("message.created", () => order.push("message"));
    const titled = t.send({ newConversation: { title: "배포 회고" }, bodyMd: "첫 글" });
    expect(titled.conversation).toMatchObject({ title: "배포 회고", titleSource: "user" });
    expect(order).toEqual(["conversation", "message"]);
    const untitled = t.send({ newConversation: {}, bodyMd: "**두 번째** 세션" });
    expect(untitled.conversation).toMatchObject({ title: "두 번째 세션", titleSource: "auto" });
    expect(untitled.message.conversationId).not.toBe(titled.message.conversationId);
    expect(t.created.map((c) => c.id)).toEqual([titled.conversation?.id, untitled.conversation?.id]);
    expect(t.conversationRows()).toHaveLength(2);
  });

  it("[Review Focus 1] 같은 clientMsgId 로 newConversation 을 두 번 — 세션 1·메시지 1, 두 번째는 같은 메시지를 이벤트 없이", () => {
    const t = setup();
    const first = t.send({ newConversation: {}, clientMsgId: "again", bodyMd: "한 번만" });
    const retry = t.send({ newConversation: {}, clientMsgId: "again", bodyMd: "한 번만" });
    expect(retry.created).toBe(false);
    expect(retry.message.id).toBe(first.message.id);
    expect(retry.message.conversationId).toBe(first.conversation?.id);
    expect(t.conversationRows()).toHaveLength(1);
    expect(t.db.select().from(messages).where(eq(messages.clientMsgId, "again")).all()).toHaveLength(1);
    expect(t.created).toHaveLength(1);
    expect(t.messagesCreated).toHaveLength(1);
  });

  it("정책 managers — member 는 FORBIDDEN(다리도), 세션 관리자·admin 은 만든다. 정책 members 면 member 도", () => {
    const t = setup();
    t.send({ newConversation: {} });
    updateChannel(t.db, t.channel.id, { sessionPolicy: { create: "managers" } });
    expect(code(() => t.send({ newConversation: {}, userId: t.noah }))).toBe("FORBIDDEN");
    // 열린 세션이 있으면 다리는 거기에 쓴다 — 세션을 만들지 않으므로 정책과 무관
    expect(t.send({ userId: t.noah }).created).toBe(true);
    t.db.update(conversations).set({ closedAt: new Date(), closedBy: t.mia }).run();
    expect(code(() => t.send({ userId: t.noah }))).toBe("FORBIDDEN");
    expect(t.conversationRows()).toHaveLength(1);

    setSessionManager(t.db, t.channel.id, t.noah, true);
    expect(t.send({ newConversation: {}, userId: t.noah }).conversation?.createdBy).toEqual({
      type: "user",
      id: t.noah,
    });
    const admin = addUser(t.db, t.workspaceId, "ada", "admin");
    expect(t.send({ newConversation: {}, userId: admin }).created).toBe(true);
    setSessionManager(t.db, t.channel.id, t.noah, false);
    expect(code(() => t.send({ newConversation: {}, userId: t.noah }))).toBe("FORBIDDEN");

    updateChannel(t.db, t.channel.id, { sessionPolicy: { create: "members" } });
    expect(t.send({ newConversation: {}, userId: t.noah }).created).toBe(true);
  });

  it("세션 관리자 지정은 채널에 없는 사람을 참여시키고, 해제는 역할만 내린다. 비활성 멤버·남의 워크스페이스는 NOT_FOUND", () => {
    const t = setup();
    expect(setSessionManager(t.db, t.channel.id, t.noah, true)).toMatchObject({
      memberType: "user",
      memberId: t.noah,
      role: "manager",
    });
    expect(setSessionManager(t.db, t.channel.id, t.noah, false).role).toBe("member");
    expect(code(() => setSessionManager(t.db, t.channel.id, t.mia, false))).toBe("NOT_FOUND");
    const gone = addUser(t.db, t.workspaceId, "gone");
    t.db.update(memberships).set({ deactivatedAt: new Date() }).where(eq(memberships.userId, gone)).run();
    expect(code(() => setSessionManager(t.db, t.channel.id, gone, true))).toBe("NOT_FOUND");
    const stranger = seedWorkspace(t.db, { userHandle: "stranger" });
    expect(code(() => setSessionManager(t.db, t.channel.id, stranger.userId, true))).toBe("NOT_FOUND");
  });

  it("스레드 답글은 다리에서도 루트의 세션에 — 다른 세션이 더 최근이어도", () => {
    const t = setup();
    const a = t.send({ newConversation: { title: "A" } });
    const root = t.send({ conversationId: a.message.conversationId });
    const b = t.send({ newConversation: { title: "B" } });
    const reply = t.send({ threadRootId: root.message.id });
    expect(reply.message).toMatchObject({
      conversationId: a.message.conversationId,
      threadRootId: root.message.id,
    });
    expect(b.message.conversationId).not.toBe(a.message.conversationId);
    // 새 세션에는 루트가 없다
    expect(code(() => t.send({ threadRootId: root.message.id, newConversation: {} }))).toBe("VALIDATION");
    // 다른 세션을 가리키며 그 루트에 답할 수 없다
    expect(
      code(() => t.send({ threadRootId: root.message.id, conversationId: b.message.conversationId })),
    ).toBe("VALIDATION");
  });

  it("다른 채널의 세션으로 보내면 VALIDATION, 다른 워크스페이스·없는 세션이면 NOT_FOUND", () => {
    const t = setup();
    const other = createChannel(t.db, { workspaceId: t.workspaceId, createdBy: t.owner, name: "other" });
    const elsewhere = sendUserMessage(t.db, t.bus, {
      conversationId: (tx) =>
        resolveSendConversation(
          tx,
          { channelId: other.id, userId: t.mia, role: "member", bodyMd: "x", newConversation: {} },
          new Date(),
        ),
      authorId: t.mia,
      bodyMd: "x",
      clientMsgId: "other-1",
    });
    expect(code(() => t.send({ conversationId: elsewhere.message.conversationId }))).toBe("VALIDATION");
    expect(code(() => t.send({ conversationId: uuid() }))).toBe("NOT_FOUND");
    const stranger = seedWorkspace(t.db, { userHandle: "stranger" });
    const foreign = createChannel(t.db, {
      workspaceId: stranger.workspaceId,
      createdBy: stranger.userId,
      name: "f",
    });
    const foreignMessage = sendUserMessage(t.db, t.bus, {
      conversationId: (tx) =>
        resolveSendConversation(
          tx,
          { channelId: foreign.id, userId: stranger.userId, role: "owner", bodyMd: "y", newConversation: {} },
          new Date(),
        ),
      authorId: stranger.userId,
      bodyMd: "y",
      clientMsgId: "foreign-1",
    });
    expect(code(() => t.send({ conversationId: foreignMessage.message.conversationId }))).toBe("NOT_FOUND");
  });

  it("[Review Focus 2·3] 닫으면 보내기·스레드 답글·리액션·카드·첨부 묶기가 CONVERSATION_CLOSED, 정본·시스템 메시지는 저장된다. 다시 열면 보낸다", async () => {
    const t = setup();
    const dir = mkdtempSync(join(tmpdir(), "dodok-conv-"));
    dirs.push(dir);
    const opened = t.send({ newConversation: { title: "닫을 세션" } });
    const conversationId = opened.message.conversationId;
    const root = opened.message;
    const card = createAgentMessage(t.db, t.bus, {
      conversationId,
      agentId: t.dev.id,
      externalId: "card-1",
      bodyMd: "골라 주세요",
      components: { blocks: [{ type: "actions", items: [{ type: "button", id: "ok", label: "좋아요" }] }] },
    });
    const image = await uploadAttachment(
      { db: t.db, dir },
      { channelId: t.channel.id, uploader: { type: "user", userId: t.mia }, bytes: makePng(1, 1) },
    );
    t.updated.length = 0;

    const closed = await t.close(conversationId, true);
    expect(closed.closedAt).toBeDefined();
    expect(closed.closedBy).toBe(t.mia);
    expect(t.abortConversation).toHaveBeenCalledWith(conversationId);
    expect(t.updated).toEqual([closed]);
    const notice = t.messagesCreated.at(-1);
    expect(notice).toMatchObject({ conversationId, kind: "system", bodyMd: "@mia 가 이 세션을 닫았습니다" });
    expect(closed.lastSeq).toBe(notice?.seq);

    expect(code(() => t.send({ conversationId }))).toBe("CONVERSATION_CLOSED");
    expect(code(() => t.send({ threadRootId: root.id }))).toBe("CONVERSATION_CLOSED");
    expect(
      code(() =>
        setReaction(
          t.db,
          t.bus,
          t.workspaceId,
          t.mia,
          { messageId: root.id, emoji: "👍", on: true },
          new Date(),
        ),
      ),
    ).toBe("CONVERSATION_CLOSED");
    const gate = createRunGate({
      db: t.db,
      bus: t.bus,
      ops: { record: () => null },
      workspaceId: t.workspaceId,
      enqueue: vi.fn(),
    });
    expect(
      await codeAsync(() =>
        interact(
          { db: t.db, bus: t.bus, workspaceId: t.workspaceId, gate },
          {
            messageId: card.id,
            componentId: card.components?.id ?? "",
            itemId: "ok",
            values: {},
            userId: t.mia,
          },
        ),
      ),
    ).toBe("CONVERSATION_CLOSED");
    expect(code(() => t.send({ conversationId, bodyMd: "", attachments: [image.id] }))).toBe(
      "CONVERSATION_CLOSED",
    );
    expect(t.db.select().from(attachments).where(eq(attachments.id, image.id)).get()?.messageId).toBeNull();
    // 닫는 순간 돌던 런의 늦은 정본·시스템 메시지는 그 세션에 남는다
    expect(
      createAgentMessage(t.db, t.bus, {
        conversationId,
        agentId: t.dev.id,
        externalId: "late-1",
        bodyMd: "늦은 답",
      }).conversationId,
    ).toBe(conversationId);
    expect(
      createSystemMessage(t.db, t.bus, { conversationId, kind: "info", bodyMd: "알림" }).conversationId,
    ).toBe(conversationId);

    // 이미 닫혔으면 그대로 — 메시지·이벤트 없음, 런도 다시 멈추지 않는다
    const before = t.messagesCreated.length;
    t.abortConversation.mockClear();
    expect((await t.close(conversationId, true)).closedAt).toBe(closed.closedAt);
    expect(t.messagesCreated).toHaveLength(before);
    expect(t.updated).toHaveLength(1);
    expect(t.abortConversation).not.toHaveBeenCalled();

    const reopened = await t.close(conversationId, false, t.owner);
    expect(reopened.closedAt).toBeUndefined();
    expect(reopened.closedBy).toBeUndefined();
    expect(t.abortConversation).not.toHaveBeenCalled();
    expect(t.updated).toHaveLength(2);
    expect(t.messagesCreated.at(-1)).toMatchObject({
      conversationId,
      bodyMd: "@owner 가 이 세션을 다시 열었습니다",
    });
    expect(t.send({ conversationId, bodyMd: "", attachments: [image.id] }).message.attachments).toHaveLength(
      1,
    );
    expect(t.send({ threadRootId: root.id }).message.conversationId).toBe(conversationId);
  });

  it("보관한 채널이면 닫힌 세션이어도 CHANNEL_ARCHIVED 가 먼저 — 닫기·다시 열기·제목도 막힌다", async () => {
    const t = setup();
    const conversationId = t.send({ newConversation: {} }).message.conversationId;
    await t.close(conversationId, true);
    t.db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, t.channel.id)).run();
    expect(code(() => t.send({ conversationId }))).toBe("CHANNEL_ARCHIVED");
    expect(await codeAsync(() => t.close(conversationId, false))).toBe("CHANNEL_ARCHIVED");
    expect(code(() => renameConversation(t.db, t.bus, conversationId, "새 이름"))).toBe("CHANNEL_ARCHIVED");
  });

  it("제목 바꾸기 — title_source 가 user 가 되고 conversation.updated 한 번, 같은 제목이면 그대로. 닫힌 세션도 바꾼다", async () => {
    const t = setup();
    const conversationId = t.send({ newConversation: {}, bodyMd: "자동 제목" }).message.conversationId;
    const renamed = renameConversation(t.db, t.bus, conversationId, "배포 회고");
    expect(renamed).toMatchObject({ title: "배포 회고", titleSource: "user" });
    expect(t.updated).toEqual([renamed]);
    renameConversation(t.db, t.bus, conversationId, "배포 회고");
    expect(t.updated).toHaveLength(1);
    await t.close(conversationId, true);
    expect(renameConversation(t.db, t.bus, conversationId, "닫힌 뒤").title).toBe("닫힌 뒤");
  });

  it("관리 권한 — 만든 member 는 자기 세션만, 세션 관리자·admin 은 남의 것도. 비활성 멤버의 세션 관리자 행은 판정에서 빠진다", () => {
    const t = setup();
    const mine = getConversation(
      t.db,
      t.send({ newConversation: {} }).message.conversationId,
    ) as Conversation;
    const decide = (userId: string) =>
      code(() =>
        authorizeConversationManage(
          roleOf(t.db, t.workspaceId, userId),
          conversationActor(t.db, mine, userId),
        ),
      );
    expect(decide(t.mia)).toBeUndefined();
    expect(decide(t.noah)).toBe("FORBIDDEN");
    setSessionManager(t.db, t.channel.id, t.noah, true);
    expect(decide(t.noah)).toBeUndefined();
    expect(decide(t.owner)).toBeUndefined();
    const admin = addUser(t.db, t.workspaceId, "ada", "admin");
    expect(decide(admin)).toBeUndefined();
    // 세션 관리자였던 사람을 비활성화하면 행이 남아도 통과하지 않는다(roleOf)
    t.db.update(memberships).set({ deactivatedAt: new Date() }).where(eq(memberships.userId, t.noah)).run();
    expect(conversationActor(t.db, mine, t.noah).isManager).toBe(true);
    expect(decide(t.noah)).toBe("FORBIDDEN");
  });

  it("목록 — 최근 활동순 20개 쪽, nextCursor 로 겹치지 않는 다음 쪽, status·q(대소문자 무시·LIKE 표시 그대로) 필터", () => {
    const t = setup();
    const base = new Date("2026-10-25T00:00:00.000Z").getTime();
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      const id = t.send({
        newConversation: { title: i === 3 ? "Deploy 회고" : i === 5 ? "100% 완료" : `세션 ${i}` },
      }).message.conversationId;
      // 활동 시각을 i 순서로 고정한다 — 7 은 메시지 없는 세션처럼 last_message_at 이 비어 created_at 으로 견준다
      t.db
        .update(conversations)
        .set(
          i === 7
            ? { lastMessageAt: null, createdAt: new Date(base + i * 1000) }
            : { lastMessageAt: new Date(base + i * 1000) },
        )
        .where(eq(conversations.id, id))
        .run();
      ids.push(id);
    }
    t.db
      .update(conversations)
      .set({ closedAt: new Date(), closedBy: t.mia })
      .where(and(eq(conversations.id, ids[22] as string), isNull(conversations.closedAt)))
      .run();
    const newestFirst = [...ids].reverse();

    const all1 = listConversations(t.db, t.channel.id, { status: "all" });
    expect(all1.conversations.map((c) => c.id)).toEqual(newestFirst.slice(0, 20));
    expect(all1.nextCursor).toBeDefined();
    const all2 = listConversations(t.db, t.channel.id, { status: "all", cursor: all1.nextCursor });
    expect(all2.conversations.map((c) => c.id)).toEqual(newestFirst.slice(20));
    expect(all2.nextCursor).toBeUndefined();

    const open = listConversations(t.db, t.channel.id, { status: "open" });
    expect(open.conversations.map((c) => c.id)).toEqual(newestFirst.slice(1, 21));
    expect(
      listConversations(t.db, t.channel.id, { status: "closed" }).conversations.map((c) => c.id),
    ).toEqual([ids[22]]);
    expect(
      listConversations(t.db, t.channel.id, { status: "all", q: "deploy" }).conversations.map((c) => c.id),
    ).toEqual([ids[3]]);
    expect(
      listConversations(t.db, t.channel.id, { status: "all", q: "%" }).conversations.map((c) => c.id),
    ).toEqual([ids[5]]);
    expect(code(() => listConversations(t.db, t.channel.id, { status: "all", cursor: "nope" }))).toBe(
      "VALIDATION",
    );
  });

  it("[낮음 1] 활동 시각이 같은 ms 인 세션 25개 — 두 쪽(20 + 5)의 합집합이 전부, 교집합 없음. 정확히 20개면 nextCursor 없음", () => {
    const sameMs = (count: number) => {
      const t = setup();
      const at = new Date("2026-10-25T00:00:00.000Z");
      const ids = Array.from({ length: count }, () => t.send({ newConversation: {} }).message.conversationId);
      t.db
        .update(conversations)
        .set({ lastMessageAt: at })
        .where(eq(conversations.channelId, t.channel.id))
        .run();
      return { t, ids };
    };
    const { t, ids } = sameMs(25);
    const first = listConversations(t.db, t.channel.id, { status: "all" });
    expect(first.conversations).toHaveLength(20);
    expect(first.nextCursor).toBeDefined();
    const second = listConversations(t.db, t.channel.id, { status: "all", cursor: first.nextCursor });
    expect(second.conversations).toHaveLength(5);
    expect(second.nextCursor).toBeUndefined();
    const a = first.conversations.map((c) => c.id);
    const b = second.conversations.map((c) => c.id);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
    expect([...a, ...b].sort()).toEqual([...ids].sort());

    const exact = sameMs(20);
    const only = listConversations(exact.t.db, exact.t.channel.id, { status: "all" });
    expect(only.conversations).toHaveLength(20);
    expect(only.nextCursor).toBeUndefined();
  });

  it("[낮음 5] 시스템 메시지는 활동 시각을 올리지 않는다 — 닫기·다시 열기·알림 뒤에도 last_message_at·다리의 최근 세션은 그대로, last_seq 는 오른다", async () => {
    const t = setup();
    const older = t.send({ newConversation: { title: "옛 세션" } }).message.conversationId;
    const newer = t.send({ newConversation: { title: "새 세션" } }).message.conversationId;
    // 활동 시각을 벌려 둔다 — 같은 ms 면 id 로 갈려 다리의 1순위가 시각과 무관해진다
    t.db
      .update(conversations)
      .set({ lastMessageAt: new Date("2026-10-25T00:00:00.000Z") })
      .where(eq(conversations.id, older))
      .run();
    t.db
      .update(conversations)
      .set({ lastMessageAt: new Date("2026-10-25T00:00:01.000Z") })
      .where(eq(conversations.id, newer))
      .run();
    const before = getConversation(t.db, older) as Conversation;
    expect(latestOpenConversation(t.db, t.channel.id)).toBe(newer);

    const closed = await t.close(older, true);
    expect(closed.lastMessageAt).toBe(before.lastMessageAt);
    expect(closed.lastSeq).toBeGreaterThan(before.lastSeq);
    const reopened = await t.close(older, false);
    expect(reopened.lastMessageAt).toBe(before.lastMessageAt);
    expect(latestOpenConversation(t.db, t.channel.id)).toBe(newer);

    const notice = createSystemMessage(t.db, t.bus, { conversationId: older, kind: "info", bodyMd: "알림" });
    const after = getConversation(t.db, older) as Conversation;
    expect(after.lastSeq).toBe(notice.seq);
    expect(after.lastMessageAt).toBe(before.lastMessageAt);
    expect(latestOpenConversation(t.db, t.channel.id)).toBe(newer);
    expect(listConversations(t.db, t.channel.id, { status: "all" }).conversations.map((c) => c.id)).toEqual([
      newer,
      older,
    ]);
  });
});

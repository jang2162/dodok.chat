import { type Attachment, INTERACTIONS_MAX, Message } from "@dodok/shared";
import { eq, inArray } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client";
import {
  attachments,
  channelMembers,
  channels,
  componentInteractions,
  memberships,
  users,
} from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { toAttachment } from "../src/modules/attachments/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import {
  createAgentMessage,
  createAutomationMessage,
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
  return { db, bus, created, userId, workspaceId, channelId: channel.id, devId: dev.id };
}

/** 브리지 첨부를 올린 러너 토큰 — 에이전트 정본은 uploadedBy 로 이 토큰을 대야 묶는다 */
const RUNNER = "runner-token-1";

/** 첨부 행을 바로 넣는다 — 블롭 없이 묶기만 볼 때(올리기는 attachments.service 테스트가 잰다) */
function insertAttachment(
  db: Db,
  opts: {
    channelId: string;
    uploaderType?: "user" | "bridge";
    uploaderId?: string;
    kind?: "image" | "file";
    name?: string;
  },
): Attachment {
  const row = db
    .insert(attachments)
    .values({
      id: uuid(),
      channelId: opts.channelId,
      uploaderType: opts.uploaderType ?? "user",
      uploaderId: opts.uploaderType === "bridge" ? RUNNER : (opts.uploaderId ?? null),
      kind: opts.kind ?? "image",
      name: opts.name ?? "a.png",
      mime: opts.kind === "file" ? "application/pdf" : "image/png",
      size: 10,
      width: opts.kind === "file" ? null : 4,
      height: opts.kind === "file" ? null : 3,
      sha256: "0".repeat(64),
      messageId: null,
      createdAt: new Date(),
    })
    .returning()
    .get();
  return toAttachment(row);
}

/** ids 순서대로 첨부 행의 message_id */
function boundTo(db: Db, ids: string[]): Array<string | null> {
  const rows = db.select().from(attachments).where(inArray(attachments.id, ids)).all();
  return ids.map((id) => rows.find((r) => r.id === id)?.messageId ?? null);
}

afterEach(() => {
  vi.useRealTimers();
});

const CARD = {
  blocks: [{ type: "actions" as const, items: [{ type: "button" as const, id: "ok", label: "OK" }] }],
};

/** component_interactions 에 한 줄을 바로 넣는다 — interact() 의 검사·런 전달 없이 하이드레이션만 볼 때 */
function insertInteraction(
  db: Db,
  message: Message,
  userId: string,
  itemId: string,
  createdAt: Date,
  values: Record<string, unknown> = {},
  id: string = uuid(),
): void {
  db.insert(componentInteractions)
    .values({
      id,
      messageId: message.id,
      componentId: message.components?.id ?? "",
      userId,
      itemId,
      values,
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

  it("없는 채널이면 NOT_FOUND, 없는 첨부 id 면 VALIDATION — 둘 다 저장·이벤트가 없다", () => {
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

  describe("첨부 묶기(스펙 4.4)", () => {
    it("사람: 첨부 둘을 보낸 순서대로 싣고 행의 message_id 를 채운다", () => {
      const { db, bus, created, userId, channelId } = setup();
      const b = insertAttachment(db, { channelId, uploaderId: userId, name: "b.png" });
      const a = insertAttachment(db, { channelId, uploaderId: userId, name: "a.png" });
      const m = createUserMessage(db, bus, {
        channelId,
        authorId: userId,
        bodyMd: "보세요",
        clientMsgId: "c1",
        attachments: [b.id, a.id],
      });
      expect(m.attachments).toEqual([b, a]);
      expect(created[0]?.attachments).toEqual([b, a]);
      expect(getMessage(db, m.id)?.attachments).toEqual([b, a]);
      expect(boundTo(db, [a.id, b.id])).toEqual([m.id, m.id]);
    });

    it("사람: 본문 없이 첨부만 있어도 저장한다", () => {
      const { db, bus, userId, channelId } = setup();
      const a = insertAttachment(db, { channelId, uploaderId: userId });
      const m = createUserMessage(db, bus, {
        channelId,
        authorId: userId,
        bodyMd: "",
        clientMsgId: "c1",
        attachments: [a.id],
      });
      expect(m).toMatchObject({ bodyMd: "", attachments: [a] });
    });

    it("사람: 남의 첨부·다른 채널 첨부·브리지 첨부·이미 묶인 첨부는 VALIDATION 이고 메시지도 안 생긴다(seq 그대로)", () => {
      const { db, bus, created, userId, channelId, workspaceId } = setup();
      const other = createChannel(db, { workspaceId, createdBy: userId, name: "other" });
      const mine = insertAttachment(db, { channelId, uploaderId: userId });
      const bound = insertAttachment(db, { channelId, uploaderId: userId });
      createUserMessage(db, bus, {
        channelId,
        authorId: userId,
        bodyMd: "먼저",
        clientMsgId: "c0",
        attachments: [bound.id],
      });
      const bad = [
        insertAttachment(db, { channelId, uploaderId: uuid() }), // 남의 것
        insertAttachment(db, { channelId: other.id, uploaderId: userId }), // 다른 채널
        insertAttachment(db, { channelId, uploaderType: "bridge" }), // 브리지
        bound, // 이미 묶임
      ];
      for (const [i, att] of bad.entries()) {
        expect(() =>
          createUserMessage(db, bus, {
            channelId,
            authorId: userId,
            bodyMd: "x",
            clientMsgId: `bad-${i}`,
            attachments: [mine.id, att.id],
          }),
        ).toThrow(expect.objectContaining({ status: 400 }));
      }
      expect(created).toHaveLength(1);
      // 롤백 — 함께 보낸 멀쩡한 첨부도 묶이지 않았다
      expect(boundTo(db, [mine.id])).toEqual([null]);
      expect(
        createUserMessage(db, bus, { channelId, authorId: userId, bodyMd: "y", clientMsgId: "ok" }).seq,
      ).toBe(2);
    });

    it("[Review Focus 4] ack 를 잃고 같은 clientMsgId·같은 첨부로 다시 보내면 처음 메시지를 그대로 돌려준다", () => {
      const { db, bus, created, userId, channelId } = setup();
      const a = insertAttachment(db, { channelId, uploaderId: userId });
      const input = { channelId, authorId: userId, bodyMd: "", clientMsgId: "same", attachments: [a.id] };
      const first = createUserMessage(db, bus, input);
      const again = createUserMessage(db, bus, input);
      expect(again).toEqual(first);
      expect(created).toHaveLength(1);
    });

    it("에이전트: 브리지 첨부 둘만 순서대로 묶고, 다른 채널 것은 빼고 onDroppedAttachments 로 알린다", () => {
      const { db, bus, userId, channelId, workspaceId, devId } = setup();
      const other = createChannel(db, { workspaceId, createdBy: userId, name: "other" });
      const f1 = insertAttachment(db, { channelId, uploaderType: "bridge", kind: "file", name: "1.pdf" });
      const f2 = insertAttachment(db, { channelId, uploaderType: "bridge", kind: "file", name: "2.pdf" });
      const stray = insertAttachment(db, { channelId: other.id, uploaderType: "bridge" });
      const onDropped = vi.fn();
      const m = createAgentMessage(
        db,
        bus,
        {
          channelId,
          agentId: devId,
          externalId: "o1",
          bodyMd: "파일",
          attachmentIds: [f2.id, stray.id, f1.id],
          uploadedBy: { runnerTokenId: RUNNER },
        },
        { onDroppedAttachments: onDropped },
      );
      expect(m.attachments).toEqual([f2, f1]);
      expect(onDropped).toHaveBeenCalledExactlyOnceWith([stray.id]);
      expect(boundTo(db, [f1.id, f2.id, stray.id])).toEqual([m.id, m.id, null]);
    });

    it("에이전트: 빠진 것이 없으면 onDroppedAttachments 를 부르지 않고, 본문 없이 첨부만 있어도 저장한다", () => {
      const { db, bus, channelId, devId } = setup();
      const f = insertAttachment(db, { channelId, uploaderType: "bridge" });
      const onDropped = vi.fn();
      const m = createAgentMessage(
        db,
        bus,
        {
          channelId,
          agentId: devId,
          externalId: "o1",
          bodyMd: "",
          attachmentIds: [f.id],
          uploadedBy: { runnerTokenId: RUNNER },
        },
        { onDroppedAttachments: onDropped },
      );
      expect(m).toMatchObject({ bodyMd: "", attachments: [f] });
      expect(onDropped).not.toHaveBeenCalled();
    });

    it("에이전트: 같은 externalId 재전송은 같은 메시지 — 이미 묶인 첨부를 빠진 것으로 알리지 않는다", () => {
      const { db, bus, created, channelId, devId } = setup();
      const f = insertAttachment(db, { channelId, uploaderType: "bridge" });
      const input = {
        channelId,
        agentId: devId,
        externalId: "o1",
        bodyMd: "파일",
        attachmentIds: [f.id],
        uploadedBy: { runnerTokenId: RUNNER },
      };
      const first = createAgentMessage(db, bus, input);
      expect(first.attachments).toEqual([f]);
      const onDropped = vi.fn();
      expect(createAgentMessage(db, bus, input, { onDroppedAttachments: onDropped })).toEqual(first);
      expect(created).toHaveLength(1);
      expect(onDropped).not.toHaveBeenCalled();
    });
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
    insertInteraction(db, other, userId, "ok", new Date(t0), { values: ["a"] });

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
    expect(otherC.interactions[0]?.values).toEqual({ values: ["a"] });
    expect(plain.interactions).toEqual([]);
  });

  it("withInteractions — createdAt 이 같으면 id 순이다(같은 밀리초의 두 클릭)", () => {
    const { db, bus, userId, channelId, devId } = setup();
    const card = createAgentMessage(db, bus, {
      channelId,
      agentId: devId,
      externalId: "out-tie",
      bodyMd: "골라",
      components: CARD,
    });
    const at = new Date("2026-09-21T00:00:00.000Z");
    // uuidv7 — 같은 밀리초 안에서도 뒤에 만든 쪽이 크다(interact() 가 기록 id 를 만드는 방식 그대로)
    const firstId = uuid();
    const secondId = uuid();
    expect(firstId < secondId).toBe(true);
    // id 역순으로 넣는다 — 행 순서로는 id 순이 나오지 않는다
    insertInteraction(db, card, userId, "second", at, {}, secondId);
    insertInteraction(db, card, userId, "first", at, {}, firstId);

    const [hydrated] = withInteractions(db, [card]);
    expect(hydrated?.interactions.map((i) => i.itemId)).toEqual(["first", "second"]);
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

describe("createAutomationMessage", () => {
  /** 채널 밖 워크스페이스 사람 — 사람 메시지처럼 멘션으로 풀린다 */
  function addPerson(db: Db, workspaceId: string, handle: string): string {
    const id = uuid();
    db.insert(users)
      .values({ id, workspaceId, handle, displayName: handle, authProvider: "local", createdAt: new Date() })
      .run();
    db.insert(memberships).values({ id: uuid(), workspaceId, userId: id, role: "member" }).run();
    return id;
  }

  it("평문 @핸들을 사람 메시지와 같은 참가자로 토큰화해 자동화 작성자·kind normal·최상위로 저장하고 message.created 를 낸다", () => {
    const { db, bus, created, userId, channelId, devId } = setup();
    const automationId = uuid();
    const message = createAutomationMessage(db, bus, {
      channelId,
      automationId,
      bodyMd: "@reviewer 와 @jang, 점검",
    });
    expect(Message.parse(message)).toEqual(message);
    expect(message).toMatchObject({
      seq: 1,
      kind: "normal",
      authorType: "automation",
      authorId: automationId,
      bodyMd: `<@a:${devId}> 와 <@u:${userId}>, 점검`,
      mentions: { agents: [devId], users: [userId] },
      attachments: [],
    });
    expect(message.threadRootId).toBeUndefined();
    expect(message.clientMsgId).toBeUndefined();
    expect(created.map((m) => m.id)).toEqual([message.id]);
    expect(getMessage(db, message.id)).toEqual(message);
  });

  it("채널 밖 사람을 멘션하면 그 사람이 채널에 들어온다(사람 멘션과 같다) — channel.member.changed 한 번", () => {
    const { db, bus, workspaceId, channelId } = setup();
    const mia = addPerson(db, workspaceId, "mia");
    const changes: string[] = [];
    bus.on("channel.member.changed", (p) => changes.push(p.channelId));
    const message = createAutomationMessage(db, bus, {
      channelId,
      automationId: uuid(),
      bodyMd: "@mia 확인",
    });
    expect(message.mentions.users).toEqual([mia]);
    const joined = db
      .select()
      .from(channelMembers)
      .all()
      .filter((m) => m.channelId === channelId && m.memberType === "user" && m.memberId === mia);
    expect(joined).toHaveLength(1);
    expect(changes).toEqual([channelId]);
    // 자동화 자신은 채널 멤버가 되지 않는다
    expect(
      db
        .select()
        .from(channelMembers)
        .all()
        .some((m) => m.memberId === message.authorId),
    ).toBe(false);
  });

  it("보관한 채널이면 CHANNEL_ARCHIVED — 저장·이벤트가 없다", () => {
    const { db, bus, created, channelId } = setup();
    db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, channelId)).run();
    expect(() => createAutomationMessage(db, bus, { channelId, automationId: uuid(), bodyMd: "x" })).toThrow(
      expect.objectContaining({ status: 409, body: expect.objectContaining({ code: "CHANNEL_ARCHIVED" }) }),
    );
    expect(created).toHaveLength(0);
    expect(listMessages(db, channelId, { limit: 10 }).messages).toEqual([]);
  });
});

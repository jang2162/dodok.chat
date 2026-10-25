import {
  ComponentsV1,
  type Conversation,
  INTERACTIONS_MAX,
  Message,
  type MessageInteraction,
  neutralizeMentionTokens,
  parseMentions,
  type SystemKind,
  type SystemMeta,
  type ThreadSummary,
  tokenize,
} from "@dodok/shared";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { z } from "zod";
import type { Db, DbOrTx } from "../../db/client";
import { channels, componentInteractions, conversations, messages } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { parseStored } from "../../http/validate";
import type { ServerBus } from "../../realtime/bus";
import {
  claimBridgeAttachments,
  claimUserAttachments,
  markBound,
  type UploadedBy,
} from "../attachments/service";
import {
  channelParticipants,
  joinChannelIfAbsent,
  listMembers,
  userMessageParticipants,
} from "../channels/service";
import { assertConversationWritable, getConversation, touchConversation } from "../conversations/store";
import { withReactions } from "../reactions/service";
import { allocateSeq } from "./seq";

/** listMessages 한 페이지 상한 */
export const MESSAGE_PAGE_MAX = 200;

type MessageRow = typeof messages.$inferSelect;
type MessageFields = Omit<typeof messages.$inferInsert, "id" | "channelId" | "conversationId" | "seq">;

/**
 * 사람 보내기의 대화 고르기 — 저장과 같은 트랜잭션에서 부른다. created 는 이번에 새로 만든 대화(새 세션의 첫 메시지 — 채널 세션 스펙 「세션 만들기·닫기」 절)
 */
export type PickConversation = (tx: DbOrTx) => { conversationId: string; created?: Conversation };

export type CreateUserMessageInput = {
  /** 채널은 대화에서 찾는다. 함수면 같은 트랜잭션에서 대화를 고르거나 만든다(재전송이면 부르지 않는다) */
  conversationId: string | PickConversation;
  authorId: string;
  /** 평문 @handle 이 섞인 본문 — 저장 전에 채널 참가자와 채널 밖 워크스페이스 사람으로 토큰화한다(userMessageParticipants) */
  bodyMd: string;
  clientMsgId: string;
  /** 올린 사람 = 보내는 사람·같은 채널·미묶음이어야 한다 — 하나라도 틀리면 메시지 전체가 VALIDATION(스펙 4.4) */
  attachments?: string[];
  replyTo?: string;
  /** 같은 대화의 루트만 — 답글·다른 대화·없는 id 면 VALIDATION(스레드 안의 스레드 없음) */
  threadRootId?: string;
};

export type CreateAgentMessageInput = {
  conversationId: string;
  agentId: string;
  runId?: string;
  /** 브리지 outboundId — 중복 제거 키 */
  externalId: string;
  /** 플러그인이 보낸 평문 @handle 본문 — 토큰화해 저장한다 */
  bodyMd: string;
  components?: z.input<typeof ComponentsV1>;
  /** 브리지가 올린 같은 채널·미묶음 첨부만 묶고 나머지는 뺀다(스펙 4.4) */
  attachmentIds?: string[];
  /** 정본을 낸 쪽(claimBridgeAttachments) — 그쪽이 올린 첨부만 묶는다. 없으면(스냅숏 답) 아무것도 묶지 않는다 */
  uploadedBy?: UploadedBy;
  replyTo?: string;
  threadRootId?: string;
};

export type CreateAutomationMessageInput = {
  /** 함수면 같은 트랜잭션에서 대화를 고르거나 만든다 — 자동화 자기 세션(automations/post.ts) */
  conversationId: string | PickConversation;
  automationId: string;
  /** 자동화에 저장된 평문 @handle 문구 — 사람 메시지와 같은 참가자 집합으로 토큰화한다(계획 판정 PA1) */
  bodyMd: string;
  /**
   * 문구 아래 빈 줄 하나 뒤에 붙이는 웹훅 원문 블록. 토큰화하지 않고 그 안의 멘션 토큰 꼴은 무력화한다(neutralizeMentionTokens) —
   * 바깥 서비스가 보낸 글(이슈 본문·커밋 메시지)의 @핸들이 런·푸시·채널 참여를 만들면 안 된다. 멘션은 문구에서만 나온다
   */
  extraMd?: string;
};

export type CreateSystemMessageInput = {
  conversationId: string;
  kind: SystemKind;
  bodyMd: string;
  /** kind 는 인자 kind 로 채운다 */
  systemMeta?: Omit<SystemMeta, "kind"> & { kind?: SystemKind };
  components?: z.input<typeof ComponentsV1>;
  /** 없으면 지금. 「오늘 이미 남겼나」를 created_at 으로 가리는 쪽(런 관문)이 자기 시계를 넘긴다 */
  createdAt?: Date;
  /** 그 일이 스레드에서 일어났으면 그 루트 — 시스템 메시지도 스레드에 남는다 */
  threadRootId?: string;
};

/** roots = 채널 타임라인(답글 제외), all = 재동기화(답글 포함), threadRootId = 그 루트와 답글 */
export type MessageScope = "roots" | "all" | { threadRootId: string };

export type ListMessagesOptions = {
  limit: number;
  beforeSeq?: number;
  afterSeq?: number;
  /** 있으면 before·after 는 보지 않는다 — 그 seq 를 가운데 둔 한 페이지 */
  aroundSeq?: number;
  /** 기본 "roots" */
  scope?: MessageScope;
  /** 있으면 그 대화의 메시지만(대화 경로 REST — 채널 세션 스펙 「wire·REST」 장). seq 는 채널 번호 그대로라 커서는 채널 경로와 같다 */
  conversationId?: string;
};

/** hasMore = 더 옛것이 있다(afterSeq 로 읽었으면 더 새것). hasMoreAfter 는 around 페이지에만 — 더 새것이 있다 */
export type MessagePage = { messages: Message[]; hasMore: boolean; hasMoreAfter?: boolean };

/** 스레드 요약에 싣는 에이전트 수 상한(ThreadSummary.agentIds) */
const THREAD_SUMMARY_AGENTS = 10;

/** threadSummary 는 싣지 않는다 — 집계 질의가 필요해 클라이언트 경로(hydrateForClient)가 붙인다 */
export function rowToMessage(row: MessageRow): Message {
  return parseStored(
    Message,
    {
      id: row.id,
      channelId: row.channelId,
      conversationId: row.conversationId,
      seq: row.seq,
      kind: row.kind,
      authorType: row.authorType,
      authorId: row.authorId ?? undefined,
      bodyMd: row.bodyMd,
      mentions: row.mentions,
      attachments: row.attachments,
      components: row.components ?? undefined,
      componentState: row.componentState ?? undefined,
      systemMeta: row.systemMeta ?? undefined,
      replyTo: row.replyTo ?? undefined,
      threadRootId: row.threadRootId ?? undefined,
      runId: row.runId ?? undefined,
      clientMsgId: row.clientMsgId ?? undefined,
      externalId: row.externalId ?? undefined,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt?.toISOString(),
    },
    "message",
  );
}

/**
 * 클라이언트가 볼 Message 에 상호작용 기록을 붙인다(설계 4.1·4.2).
 * components 가 있는 메시지만 고른다 — 보통 한 페이지에 0~2건이고, 하나도 없으면 질의하지 않는다.
 * 서버 내부에서만 쓸 Message 에는 붙이지 않는다(트랜잭션마다 질의가 늘어난다).
 */
export function withInteractions(db: DbOrTx, msgs: Message[]): Message[] {
  const ids = msgs.filter((m) => m.components !== undefined).map((m) => m.id);
  if (ids.length === 0) return msgs;
  const rows = db
    .select()
    .from(componentInteractions)
    .where(inArray(componentInteractions.messageId, ids))
    .orderBy(asc(componentInteractions.createdAt), asc(componentInteractions.id))
    .all();
  const byMessage = new Map<string, MessageInteraction[]>();
  for (const r of rows) {
    const list = byMessage.get(r.messageId) ?? [];
    list.push({
      id: r.id,
      componentId: r.componentId,
      userId: r.userId,
      itemId: r.itemId,
      values: r.values,
      createdAt: r.createdAt.toISOString(),
    });
    byMessage.set(r.messageId, list);
  }
  return msgs.map((m) => {
    const list = byMessage.get(m.id);
    if (!list) return m;
    // 넘치면 최신 쪽 20건을 남긴다 — 오래된 것이 잘린다(설계 3장)
    return { ...m, interactions: list.slice(-INTERACTIONS_MAX) };
  });
}

/**
 * 루트 메시지에 threadSummary 를 붙인다 — 채널마다 집계 질의 한 번(N+1 없음). 이미 요약을 실은 루트는 건너뛴다
 * (답글 저장이 방금 계산해 보낸 message.updated). 답글이 없는 루트는 그대로다.
 */
export function withThreadSummaries(db: DbOrTx, msgs: Message[]): Message[] {
  const byChannel = new Map<string, string[]>();
  for (const m of msgs) {
    if (m.threadRootId !== undefined || m.threadSummary !== undefined) continue;
    const ids = byChannel.get(m.channelId);
    if (ids) ids.push(m.id);
    else byChannel.set(m.channelId, [m.id]);
  }
  if (byChannel.size === 0) return msgs;
  const summaries = new Map<string, ThreadSummary>();
  for (const [channelId, rootIds] of byChannel) {
    for (const [rootId, summary] of summarizeThreads(db, channelId, rootIds)) summaries.set(rootId, summary);
  }
  return msgs.map((m) => {
    const summary = summaries.get(m.id);
    return summary ? { ...m, threadSummary: summary } : m;
  });
}

/** 클라이언트가 볼 Message — 상호작용 기록·리액션·스레드 요약. REST·구독 ack·wire 팬아웃이 쓴다 */
export function hydrateForClient(db: DbOrTx, msgs: Message[]): Message[] {
  return withThreadSummaries(db, withReactions(db, withInteractions(db, msgs)));
}

/**
 * 페이지 답글이 가리키는 루트 중 페이지에 없는 것 — 요약을 실어 seq 순. lastSeq 재동기화가 쓴다: 루트는 seq ≤ lastSeq 라
 * 페이지에 없고, 끊긴 사이 발행된 루트 message.updated 는 소켓이 못 받았다. 루트 읽기는 질의 한 번(N+1 없음)
 */
export function threadRootsOf(db: DbOrTx, channelId: string, page: Message[]): Message[] {
  const inPage = new Set(page.map((m) => m.id));
  const rootIds = [
    ...new Set(page.flatMap((m) => (m.threadRootId && !inPage.has(m.threadRootId) ? [m.threadRootId] : []))),
  ];
  if (rootIds.length === 0) return [];
  const rows = db
    .select()
    .from(messages)
    .where(
      and(eq(messages.channelId, channelId), inArray(messages.id, rootIds), isNull(messages.threadRootId)),
    )
    .orderBy(asc(messages.seq))
    .all();
  return hydrateForClient(db, rows.map(rowToMessage));
}

/** 루트의 스레드 요약. 답글이 없거나 루트가 없으면 undefined */
export function threadSummaryOf(db: DbOrTx, rootId: string): ThreadSummary | undefined {
  const root = db
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, rootId))
    .get();
  if (!root) return undefined;
  return summarizeThreads(db, root.channelId, [rootId]).get(rootId);
}

/**
 * (루트, 작성자)별로 묶은 한 번의 질의를 루트별로 합친다. count 는 시스템 메시지를 포함한 모든 답글,
 * agentIds 는 가장 최근에 답한 에이전트부터 최대 10. channel_id 조건은 (channel_id, thread_root_id, seq) 인덱스를 타려고 둔다.
 */
function summarizeThreads(db: DbOrTx, channelId: string, rootIds: string[]): Map<string, ThreadSummary> {
  const rows = db
    .select({
      rootId: messages.threadRootId,
      authorType: messages.authorType,
      authorId: messages.authorId,
      count: sql<number>`count(*)`,
      lastAt: sql<number>`max(${messages.createdAt})`,
      lastSeq: sql<number>`max(${messages.seq})`,
    })
    .from(messages)
    .where(and(eq(messages.channelId, channelId), inArray(messages.threadRootId, rootIds)))
    .groupBy(messages.threadRootId, messages.authorType, messages.authorId)
    .all();
  const byRoot = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.rootId === null) continue;
    const group = byRoot.get(r.rootId);
    if (group) group.push(r);
    else byRoot.set(r.rootId, [r]);
  }
  const out = new Map<string, ThreadSummary>();
  for (const [rootId, group] of byRoot) {
    const agentIds = group
      .filter((r) => r.authorType === "agent" && r.authorId !== null)
      .sort((a, b) => b.lastSeq - a.lastSeq)
      .slice(0, THREAD_SUMMARY_AGENTS)
      .map((r) => r.authorId as string);
    out.set(rootId, {
      count: group.reduce((sum, r) => sum + r.count, 0),
      lastAt: new Date(Math.max(...group.map((r) => r.lastAt))).toISOString(),
      agentIds,
    });
  }
  return out;
}

/** createUserMessage 의 메시지만 */
export function createUserMessage(db: Db, bus: ServerBus, input: CreateUserMessageInput): Message {
  return sendUserMessage(db, bus, input).message;
}

/**
 * (authorId, clientMsgId) 가 이미 있으면 그 메시지를 돌려준다(이벤트 없음 — 대화도 고르지 않는다: 새 세션 첫 메시지의 재전송이 세션을
 * 또 만들지 않게, 채널 세션 계획 판정 PS9). 새로 저장했을 때만 커밋 뒤 message.created. 고른 대화는 쓰기 검사를 지난다(보관 채널
 * CHANNEL_ARCHIVED → 닫힌 대화 CONVERSATION_CLOSED). 대화를 새로 만들었으면 message.created 앞에 conversation.created.
 * 쓴 사람과 멘션된 사람은 같은 트랜잭션에서 채널에 들어온다(자동 참여, 팀 스펙 「채널 참여」 절) — 누가 새로 들어왔으면
 * message.created 뒤에 channel.member.changed 한 번
 */
export function sendUserMessage(
  db: Db,
  bus: ServerBus,
  input: CreateUserMessageInput,
): { message: Message; created: boolean; conversation?: Conversation } {
  const result = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(messages)
      .where(and(eq(messages.authorId, input.authorId), eq(messages.clientMsgId, input.clientMsgId)))
      .get();
    // 재전송(ack 유실)은 잡기 전에 돌아간다 — 처음 메시지가 이미 묶은 첨부를 「쓸 수 없는 첨부」로 거절하지 않게
    if (existing) return { message: rowToMessage(existing), created: false, root: undefined, joined: false };
    const picked =
      typeof input.conversationId === "string"
        ? { conversationId: input.conversationId }
        : input.conversationId(tx);
    const conversation = assertConversationWritable(tx, picked.conversationId);
    const { channelId } = conversation;
    const claimed = claimUserAttachments(tx, {
      ids: input.attachments ?? [],
      channelId,
      userId: input.authorId,
    });
    const message = storeMessage(tx, conversation, input.threadRootId, () => {
      const { bodyMd, mentions } = tokenize(input.bodyMd, userMessageParticipants(tx, channelId));
      return {
        kind: "normal",
        authorType: "user",
        authorId: input.authorId,
        bodyMd,
        mentions,
        attachments: claimed,
        replyTo: input.replyTo ?? null,
        clientMsgId: input.clientMsgId,
        createdAt: new Date(),
      };
    });
    markBound(
      tx,
      claimed.map((a) => a.id),
      message.id,
    );
    const now = new Date();
    // 모두 부른다 — some 이면 앞에서 true 가 나올 때 뒤 사람을 건너뛴다
    const joined = [input.authorId, ...message.mentions.users]
      .map((userId) => joinChannelIfAbsent(tx, channelId, userId, now))
      .includes(true);
    // 새 대화는 첫 메시지를 담은 뒤의 행(last_seq·last_message_at)으로 알린다
    const newConversation = picked.created && getConversation(tx, picked.created.id);
    return { message, created: true, root: updatedRoot(tx, message), joined, newConversation };
  });
  if (result.newConversation) bus.emit("conversation.created", { conversation: result.newConversation });
  if (result.created) emitCreated(bus, result.message, result.root);
  if (result.joined) {
    bus.emit("channel.member.changed", {
      channelId: result.message.channelId,
      members: listMembers(db, result.message.channelId),
    });
  }
  return {
    message: result.message,
    created: result.created,
    ...(result.newConversation ? { conversation: result.newConversation } : {}),
  };
}

/**
 * externalId 가 이미 있으면 그 메시지를 돌려준다(이벤트 없음). components 에는 서버 id 와 componentState 를 붙인다.
 * opts.silent 면 message.created 에 표지를 달아 푸시가 건너뛴다(채널에는 그대로 보인다)
 */
export function createAgentMessage(
  db: Db,
  bus: ServerBus,
  input: CreateAgentMessageInput,
  opts: { onDroppedAttachments?: (ids: string[]) => void; silent?: boolean } = {},
): Message {
  const result = db.transaction((tx) => {
    const existing = tx.select().from(messages).where(eq(messages.externalId, input.externalId)).get();
    if (existing) return { message: rowToMessage(existing), created: false, dropped: [], root: undefined };
    const conversation = requireConversation(tx, input.conversationId);
    const { channelId } = conversation;
    const { accepted, dropped } = claimBridgeAttachments(tx, {
      ids: input.attachmentIds ?? [],
      channelId,
      by: input.uploadedBy,
    });
    const message = storeMessage(tx, conversation, input.threadRootId, () => {
      const now = new Date();
      const { bodyMd, mentions } = tokenize(input.bodyMd, channelParticipants(tx, channelId));
      return {
        kind: "normal",
        authorType: "agent",
        authorId: input.agentId,
        bodyMd,
        mentions,
        attachments: accepted,
        ...componentFields(input.components, now),
        replyTo: input.replyTo ?? null,
        runId: input.runId ?? null,
        externalId: input.externalId,
        createdAt: now,
      };
    });
    markBound(
      tx,
      accepted.map((a) => a.id),
      message.id,
    );
    return { message, created: true, dropped, root: updatedRoot(tx, message) };
  });
  // 트랜잭션 밖에서 — 호출자의 로그가 커밋을 붙잡지 않게
  if (result.dropped.length > 0) opts.onDroppedAttachments?.(result.dropped);
  if (result.created) emitCreated(bus, result.message, result.root, opts.silent === true);
  return result.message;
}

/**
 * 자동화가 채널 최상위에 게시하는 보통 메시지(자동화 스펙 「게시」 절) — 작성자 automation·authorId 는 자동화 id. 보관한 채널이면
 * CHANNEL_ARCHIVED, 닫힌 대화면 CONVERSATION_CLOSED(같은 트랜잭션에서 본다 — 보관·닫기와 엇갈려도 쓰지 않게). 대화를 고르는 함수가 새로
 * 만들었으면 같은 트랜잭션이라 실패하면 함께 걷히고, 커밋 뒤 message.created 앞에 conversation.created. 멘션된 사람은 사람 멘션처럼 채널에
 * 들어온다(팀 스펙 「채널 참여·멘션·알림」 절). 런은 부르는 쪽이 라우터에 넘겨 만든다
 */
export function createAutomationMessage(
  db: Db,
  bus: ServerBus,
  input: CreateAutomationMessageInput,
): Message {
  const result = db.transaction((tx) => {
    const picked =
      typeof input.conversationId === "string"
        ? { conversationId: input.conversationId }
        : input.conversationId(tx);
    const conversation = assertConversationWritable(tx, picked.conversationId);
    const { channelId } = conversation;
    const message = storeMessage(tx, conversation, undefined, () => {
      const text = tokenize(input.bodyMd, userMessageParticipants(tx, channelId)).bodyMd;
      const bodyMd =
        input.extraMd === undefined ? text : `${text}\n\n${neutralizeMentionTokens(input.extraMd)}`;
      return {
        kind: "normal",
        authorType: "automation",
        authorId: input.automationId,
        bodyMd,
        mentions: parseMentions(bodyMd),
        attachments: [],
        createdAt: new Date(),
      };
    });
    const now = new Date();
    const joined = message.mentions.users
      .map((userId) => joinChannelIfAbsent(tx, channelId, userId, now))
      .includes(true);
    // 새 대화는 첫 메시지를 담은 뒤의 행으로 알린다(sendUserMessage 와 같다)
    const newConversation = picked.created && getConversation(tx, picked.created.id);
    return { message, joined, newConversation };
  });
  if (result.newConversation) bus.emit("conversation.created", { conversation: result.newConversation });
  emitCreated(bus, result.message, undefined);
  if (result.joined) {
    bus.emit("channel.member.changed", {
      channelId: result.message.channelId,
      members: listMembers(db, result.message.channelId),
    });
  }
  return result.message;
}

/** 본문은 토큰화하지 않고 mentions 는 비운다 — 시스템 메시지는 라우팅 대상이 아니다. */
export function createSystemMessage(db: Db, bus: ServerBus, input: CreateSystemMessageInput): Message {
  const result = db.transaction((tx) => {
    const message = storeMessage(
      tx,
      requireConversation(tx, input.conversationId),
      input.threadRootId,
      () => {
        const now = input.createdAt ?? new Date();
        return {
          kind: "system",
          authorType: "system",
          authorId: null,
          bodyMd: input.bodyMd,
          mentions: { agents: [], users: [] },
          ...componentFields(input.components, now),
          systemMeta: { ...input.systemMeta, kind: input.kind },
          createdAt: now,
        };
      },
    );
    return { message, root: updatedRoot(tx, message) };
  });
  emitCreated(bus, result.message, result.root);
  return result.message;
}

/**
 * seq 오름차순 한 페이지(limit ≤ 200). afterSeq 가 있으면 그 초과에서 가장 오래된 것부터(hasMore = 더 새것이 있다),
 * 없으면 (beforeSeq 미만에서) 가장 최근 것들(hasMore = 더 옛것이 있다). aroundSeq 는 그 seq 이하에서 절반(올림),
 * 초과에서 나머지 — roots 스코프에서 그 seq 가 답글이면 그 루트가 가운데다(검색 결과로 가기).
 * REST 히스토리와 구독 ack 가 쓰는 클라이언트 경로라 상호작용 기록·스레드 요약을 붙여 돌려준다.
 */
export function listMessages(db: DbOrTx, channelId: string, opts: ListMessagesOptions): MessagePage {
  const limit = Number.isFinite(opts.limit)
    ? Math.min(Math.max(Math.trunc(opts.limit), 1), MESSAGE_PAGE_MAX)
    : MESSAGE_PAGE_MAX;
  const scope = opts.scope ?? "roots";
  const page = (cond: SQL | undefined, oldestFirst: boolean, n: number) =>
    db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          opts.conversationId === undefined ? undefined : eq(messages.conversationId, opts.conversationId),
          scopeFilter(scope),
          cond,
        ),
      )
      .orderBy(oldestFirst ? asc(messages.seq) : desc(messages.seq))
      .limit(n + 1)
      .all();

  if (opts.aroundSeq !== undefined) {
    const center = scope === "roots" ? rootSeqAt(db, channelId, opts.aroundSeq) : opts.aroundSeq;
    const olderN = Math.ceil(limit / 2);
    const newerN = limit - olderN;
    const older = page(lte(messages.seq, center), false, olderN);
    const newer = page(gt(messages.seq, center), true, newerN);
    const rows = [...older.slice(0, olderN).reverse(), ...newer.slice(0, newerN)];
    return {
      messages: hydrateForClient(db, rows.map(rowToMessage)),
      hasMore: older.length > olderN,
      hasMoreAfter: newer.length > newerN,
    };
  }

  const oldestFirst = opts.afterSeq !== undefined;
  const rows = page(
    and(
      opts.beforeSeq === undefined ? undefined : lt(messages.seq, opts.beforeSeq),
      opts.afterSeq === undefined ? undefined : gt(messages.seq, opts.afterSeq),
    ),
    oldestFirst,
    limit,
  );
  const hasMore = rows.length > limit;
  const slice = rows.slice(0, limit);
  if (!oldestFirst) slice.reverse();
  return { messages: hydrateForClient(db, slice.map(rowToMessage)), hasMore };
}

function scopeFilter(scope: MessageScope): SQL | undefined {
  if (scope === "roots") return isNull(messages.threadRootId);
  if (scope === "all") return undefined;
  return or(eq(messages.id, scope.threadRootId), eq(messages.threadRootId, scope.threadRootId));
}

/** 그 seq 가 답글이면 루트의 seq, 아니면(루트거나 없는 seq) 그대로 */
function rootSeqAt(db: DbOrTx, channelId: string, seq: number): number {
  const row = db
    .select({ threadRootId: messages.threadRootId })
    .from(messages)
    .where(and(eq(messages.channelId, channelId), eq(messages.seq, seq)))
    .get();
  if (!row?.threadRootId) return seq;
  const root = db.select({ seq: messages.seq }).from(messages).where(eq(messages.id, row.threadRootId)).get();
  return root?.seq ?? seq;
}

/**
 * 1회용 컴포넌트 아이템을 쓴 것으로 남긴다(설계 4.3) — 사람의 상호작용(components/service.ts interact)과 서버가 닫는 카드가 같은
 * 길을 쓴다. 상태가 없거나 이미 쓴 아이템이면 그대로 돌려준다
 */
export function consumeComponentItem(tx: DbOrTx, message: Message, itemId: string): Message {
  const state = message.componentState;
  if (!state || state.consumed.includes(itemId)) return message;
  const row = tx
    .update(messages)
    .set({ componentState: { ...state, consumed: [...state.consumed, itemId] } })
    .where(eq(messages.id, message.id))
    .returning()
    .get();
  return row ? rowToMessage(row) : message;
}

/** 그 런의 run_error 시스템 메시지(「다시 실행」 카드) — 런마다 하나지만 목록으로 돌려준다 */
export function runErrorMessages(db: DbOrTx, channelId: string, runId: string): Message[] {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        eq(messages.kind, "system"),
        sql`json_extract(${messages.systemMeta}, '$.kind') = 'run_error'`,
        sql`json_extract(${messages.systemMeta}, '$.runId') = ${runId}`,
      ),
    )
    .all()
    .map(rowToMessage);
}

export function getMessage(db: DbOrTx, id: string): Message | undefined {
  const row = db.select().from(messages).where(eq(messages.id, id)).get();
  return row ? rowToMessage(row) : undefined;
}

/** 이 채널의 루트(thread_root_id 가 null) 메시지 — 스레드 REST 가 루트를 확인할 때. 답글·다른 채널이면 undefined */
export function getThreadRoot(db: DbOrTx, channelId: string, rootId: string): Message | undefined {
  const row = db
    .select()
    .from(messages)
    .where(and(eq(messages.id, rootId), eq(messages.channelId, channelId), isNull(messages.threadRootId)))
    .get();
  return row ? rowToMessage(row) : undefined;
}

/** (authorId, clientMsgId) 멱등 키로 이미 저장된 사람 메시지 — wire 가 재전송을 다시 라우팅하지 않으려고 본다 */
export function findUserMessage(db: DbOrTx, authorId: string, clientMsgId: string): Message | undefined {
  const row = db
    .select()
    .from(messages)
    .where(and(eq(messages.authorId, authorId), eq(messages.clientMsgId, clientMsgId)))
    .get();
  return row ? rowToMessage(row) : undefined;
}

/** 그 대화와 채널. 대화나 채널이 없으면 NOT_FOUND */
function requireConversation(tx: DbOrTx, conversationId: string): { id: string; channelId: string } {
  const row = tx
    .select({ id: conversations.id, channelId: conversations.channelId })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(eq(conversations.id, conversationId))
    .get();
  if (!row) throw apiError("NOT_FOUND", "conversation not found");
  return row;
}

/**
 * 스레드 루트 확인 → allocateSeq → 본문 조립(토큰화) → INSERT → 대화의 last_seq·last_message_at(시스템 메시지는 last_seq 만). 호출자의 트랜잭션 안에서.
 * 계약 위반이면 throw 해 롤백된다. 답글을 루트로 가리키면 그 루트로 바꾸지 않고 거절한다 — 웹이 루트를 보낸다(스펙 4.1).
 * 답글의 대화는 루트의 대화와 같아야 한다(채널 세션 스펙 2.2) — seq 는 채널을 같이 쓰므로 루트를 채널로만 찾으면 다른 대화의 루트에
 * 답글이 붙는다
 */
function storeMessage(
  tx: DbOrTx,
  conversation: { id: string; channelId: string },
  threadRootId: string | undefined,
  build: () => MessageFields,
): Message {
  const { id: conversationId, channelId } = conversation;
  if (
    threadRootId !== undefined &&
    getThreadRoot(tx, channelId, threadRootId)?.conversationId !== conversationId
  ) {
    throw apiError("VALIDATION", "threadRootId 는 이 대화의 루트 메시지여야 한다");
  }
  const seq = allocateSeq(tx, channelId);
  const row = tx
    .insert(messages)
    .values({ id: uuidv7(), channelId, conversationId, seq, ...build(), threadRootId: threadRootId ?? null })
    .returning()
    .get();
  touchConversation(tx, conversationId, row);
  return rowToMessage(row);
}

/** 답글이면 새 요약을 실은 루트 — 커밋 뒤 message.updated 로 보낸다. 트랜잭션 안에서 불러 저장과 같은 시점의 수를 센다 */
function updatedRoot(tx: DbOrTx, message: Message): Message | undefined {
  if (message.threadRootId === undefined) return undefined;
  const row = tx.select().from(messages).where(eq(messages.id, message.threadRootId)).get();
  if (!row) return undefined;
  const summary = summarizeThreads(tx, row.channelId, [row.id]).get(row.id);
  return summary ? { ...rowToMessage(row), threadSummary: summary } : rowToMessage(row);
}

function emitCreated(bus: ServerBus, message: Message, root: Message | undefined, silent = false): void {
  bus.emit("message.created", silent ? { message, silent: true } : { message });
  if (root) bus.emit("message.updated", { message: root });
}

function componentFields(
  input: z.input<typeof ComponentsV1> | undefined,
  now: Date,
): Pick<MessageFields, "components" | "componentState"> {
  if (input === undefined) return { components: null, componentState: null };
  const parsed = ComponentsV1.safeParse(input);
  if (!parsed.success) {
    throw apiError("VALIDATION", "components 가 계약을 어긴다", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    });
  }
  return {
    // id 는 저장 시 서버가 부여한다(계약 스펙 3장) — 에이전트가 보낸 값은 쓰지 않는다
    components: { ...parsed.data, id: `cmp_${uuidv7()}` },
    componentState: { expiresAt: new Date(now.getTime() + parsed.data.ttlMs).toISOString(), consumed: [] },
  };
}

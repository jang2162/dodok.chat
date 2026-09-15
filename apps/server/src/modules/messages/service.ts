import { ComponentsV1, Message, type SystemKind, type SystemMeta, tokenize } from "@dodok/shared";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { z } from "zod";
import type { Db, DbOrTx } from "../../db/client";
import { channels, messages } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { parseStored } from "../../http/validate";
import type { ServerBus } from "../../realtime/bus";
import { channelParticipants } from "../channels/service";
import { allocateSeq } from "./seq";

/** listMessages 한 페이지 상한 */
export const MESSAGE_PAGE_MAX = 200;

type MessageRow = typeof messages.$inferSelect;
type MessageFields = Omit<typeof messages.$inferInsert, "id" | "channelId" | "seq">;

export type CreateUserMessageInput = {
  channelId: string;
  authorId: string;
  /** 평문 @handle 이 섞인 본문 — 저장 전에 채널 참가자로 토큰화한다 */
  bodyMd: string;
  clientMsgId: string;
  /** 업로드 API 가 없어 MVP 에서는 비어 있어야 한다 */
  attachments?: string[];
  replyTo?: string;
};

export type CreateAgentMessageInput = {
  channelId: string;
  agentId: string;
  runId?: string;
  /** 브리지 outboundId — 중복 제거 키 */
  externalId: string;
  /** 플러그인이 보낸 평문 @handle 본문 — 토큰화해 저장한다 */
  bodyMd: string;
  components?: z.input<typeof ComponentsV1>;
  replyTo?: string;
};

export type CreateSystemMessageInput = {
  channelId: string;
  kind: SystemKind;
  bodyMd: string;
  /** kind 는 인자 kind 로 채운다 */
  systemMeta?: Omit<SystemMeta, "kind"> & { kind?: SystemKind };
  components?: z.input<typeof ComponentsV1>;
};

export type ListMessagesOptions = { beforeSeq?: number; afterSeq?: number; limit: number };

export function rowToMessage(row: MessageRow): Message {
  return parseStored(
    Message,
    {
      id: row.id,
      channelId: row.channelId,
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
      runId: row.runId ?? undefined,
      clientMsgId: row.clientMsgId ?? undefined,
      externalId: row.externalId ?? undefined,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt?.toISOString(),
    },
    "message",
  );
}

/** (authorId, clientMsgId) 가 이미 있으면 그 메시지를 돌려준다(이벤트 없음). 새로 저장했을 때만 커밋 뒤 message.created. */
export function createUserMessage(db: Db, bus: ServerBus, input: CreateUserMessageInput): Message {
  if ((input.attachments?.length ?? 0) > 0) throw apiError("VALIDATION", "첨부는 아직 지원하지 않는다");
  const result = db.transaction((tx) => {
    const existing = tx
      .select()
      .from(messages)
      .where(and(eq(messages.authorId, input.authorId), eq(messages.clientMsgId, input.clientMsgId)))
      .get();
    if (existing) return { message: rowToMessage(existing), created: false };
    const message = storeMessage(tx, input.channelId, () => {
      const { bodyMd, mentions } = tokenize(input.bodyMd, channelParticipants(tx, input.channelId));
      return {
        kind: "normal",
        authorType: "user",
        authorId: input.authorId,
        bodyMd,
        mentions,
        replyTo: input.replyTo ?? null,
        clientMsgId: input.clientMsgId,
        createdAt: new Date(),
      };
    });
    return { message, created: true };
  });
  if (result.created) bus.emit("message.created", { message: result.message });
  return result.message;
}

/** externalId 가 이미 있으면 그 메시지를 돌려준다(이벤트 없음). components 에는 서버 id 와 componentState 를 붙인다. */
export function createAgentMessage(db: Db, bus: ServerBus, input: CreateAgentMessageInput): Message {
  const result = db.transaction((tx) => {
    const existing = tx.select().from(messages).where(eq(messages.externalId, input.externalId)).get();
    if (existing) return { message: rowToMessage(existing), created: false };
    const message = storeMessage(tx, input.channelId, () => {
      const now = new Date();
      const { bodyMd, mentions } = tokenize(input.bodyMd, channelParticipants(tx, input.channelId));
      return {
        kind: "normal",
        authorType: "agent",
        authorId: input.agentId,
        bodyMd,
        mentions,
        ...componentFields(input.components, now),
        replyTo: input.replyTo ?? null,
        runId: input.runId ?? null,
        externalId: input.externalId,
        createdAt: now,
      };
    });
    return { message, created: true };
  });
  if (result.created) bus.emit("message.created", { message: result.message });
  return result.message;
}

/** 본문은 토큰화하지 않고 mentions 는 비운다 — 시스템 메시지는 라우팅 대상이 아니다. */
export function createSystemMessage(db: Db, bus: ServerBus, input: CreateSystemMessageInput): Message {
  const message = db.transaction((tx) =>
    storeMessage(tx, input.channelId, () => {
      const now = new Date();
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
    }),
  );
  bus.emit("message.created", { message });
  return message;
}

/**
 * seq 오름차순 한 페이지(limit ≤ 200). afterSeq 가 있으면 그 초과에서 가장 오래된 것부터(hasMore = 더 새것이 있다),
 * 없으면 (beforeSeq 미만에서) 가장 최근 것들(hasMore = 더 옛것이 있다).
 */
export function listMessages(
  db: DbOrTx,
  channelId: string,
  opts: ListMessagesOptions,
): { messages: Message[]; hasMore: boolean } {
  const limit = Number.isFinite(opts.limit)
    ? Math.min(Math.max(Math.trunc(opts.limit), 1), MESSAGE_PAGE_MAX)
    : MESSAGE_PAGE_MAX;
  const oldestFirst = opts.afterSeq !== undefined;
  const rows = db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        opts.beforeSeq === undefined ? undefined : lt(messages.seq, opts.beforeSeq),
        opts.afterSeq === undefined ? undefined : gt(messages.seq, opts.afterSeq),
      ),
    )
    .orderBy(oldestFirst ? asc(messages.seq) : desc(messages.seq))
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  if (!oldestFirst) page.reverse();
  return { messages: page.map(rowToMessage), hasMore };
}

export function getMessage(db: DbOrTx, id: string): Message | undefined {
  const row = db.select().from(messages).where(eq(messages.id, id)).get();
  return row ? rowToMessage(row) : undefined;
}

/** 채널 확인 → allocateSeq → 본문 조립(토큰화) → INSERT. 호출자의 트랜잭션 안에서. 계약 위반이면 throw 해 롤백된다. */
function storeMessage(tx: DbOrTx, channelId: string, build: () => MessageFields): Message {
  const channel = tx.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId)).get();
  if (!channel) throw apiError("NOT_FOUND", "channel not found");
  const seq = allocateSeq(tx, channelId);
  const row = tx
    .insert(messages)
    .values({ id: uuidv7(), channelId, seq, ...build() })
    .returning()
    .get();
  return rowToMessage(row);
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

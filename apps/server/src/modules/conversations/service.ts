import type { Conversation, ConversationList, TeamRole } from "@dodok/shared";
import { and, desc, eq, isNotNull, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { authorizeConversationCreate } from "../../auth/policies";
import type { Db, DbOrTx } from "../../db/client";
import { conversations, users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import type { ServerBus } from "../../realtime/bus";
import { josa } from "../../util/josa";
import { assertChannelWritable, getChannel, isSessionManager } from "../channels/service";
import { createSystemMessage, getThreadRoot } from "../messages/service";
import { readableGlyphs, readableWindow } from "../search/readable";
import { createConversation, getConversation, latestOpenConversation, rowToConversation } from "./store";

/** 자동 제목 길이(코드 포인트) — 채널 세션 계획 Global Constraints */
const AUTO_TITLE_MAX = 40;
const EMPTY_TITLE = "새 세션";
/** 세션 목록 한 쪽 — 채널 세션 계획 Global Constraints */
export const CONVERSATION_PAGE = 20;

/**
 * 첫 메시지 본문으로 지은 세션 제목 — 마크다운 표시를 걷고 공백(줄바꿈 포함)을 하나로 접은 읽는 글의 앞 40 코드 포인트. 비면 「새 세션」.
 * 멘션은 부르는 쪽이 `@핸들` 로 풀어 넘긴다(사람 보내기는 평문 `@핸들` 본문 그대로다). 앞쪽 창만 변환한다 — readableGlyphs 는 긴 한 줄에서
 * 느려진다(search/readable.ts 머리 주석)
 */
export function autoTitle(readable: string): string {
  const glyphs = readableGlyphs(readable, () => undefined, readableWindow(readable, 0, 0));
  const title = glyphs
    .slice(0, AUTO_TITLE_MAX)
    .map((g) => g.ch)
    .join("")
    .trim();
  return title === "" ? EMPTY_TITLE : title;
}

export type ResolveSendInput = {
  channelId: string;
  userId: string;
  role: TeamRole | undefined;
  /** 사람이 보낸 평문 @핸들 본문 — 자동 제목의 재료 */
  bodyMd: string;
  conversationId?: string;
  newConversation?: { title?: string };
  threadRootId?: string;
};

/**
 * 사람 보내기의 대화 고르기(채널 세션 스펙 「세션 만들기·닫기」 절·「wire·REST」 장) — messages/service.ts sendUserMessage 가 저장과 같은 트랜잭션에서 부른다.
 * conversationId 면 그 대화(이 채널 것이어야 한다 — 다른 채널이면 VALIDATION), newConversation 이면 권한을 보고 새 대화, 둘 다 없으면
 * 다리(채널 세션 계획 판정 PS4): 스레드 답글은 루트의 대화, 아니면 채널의 최근 열린 대화, 없으면 자동 제목 새 대화. 쓰기 검사(보관·닫힘)는
 * sendUserMessage 가 고른 대화에 한다
 */
export function resolveSendConversation(
  tx: DbOrTx,
  input: ResolveSendInput,
  now: Date,
): { conversationId: string; created?: Conversation } {
  const channel = getChannel(tx, input.channelId);
  if (!channel) throw apiError("NOT_FOUND", "channel not found");
  if (input.conversationId !== undefined) {
    const conversation = getConversation(tx, input.conversationId, channel.workspaceId);
    if (!conversation) throw apiError("NOT_FOUND", "conversation not found");
    if (conversation.channelId !== channel.id) throw apiError("VALIDATION", "다른 채널의 세션이다");
    return { conversationId: conversation.id };
  }
  if (input.threadRootId !== undefined) {
    // 답글은 루트의 대화에 쓴다 — 새 대화에는 아직 루트가 없다
    const root = input.newConversation === undefined && getThreadRoot(tx, channel.id, input.threadRootId);
    if (!root) throw apiError("VALIDATION", "threadRootId 는 이 대화의 루트 메시지여야 한다");
    return { conversationId: root.conversationId };
  }
  if (input.newConversation === undefined) {
    const latest = latestOpenConversation(tx, channel.id);
    if (latest !== undefined) return { conversationId: latest };
  }
  authorizeConversationCreate(
    input.role,
    channel.sessionPolicy,
    isSessionManager(tx, channel.id, input.userId),
  );
  const title = input.newConversation?.title;
  const created = createConversation(tx, {
    channelId: channel.id,
    title: title ?? autoTitle(input.bodyMd),
    titleSource: title === undefined ? "auto" : "user",
    createdBy: { type: "user", id: input.userId },
    createdAt: now,
  });
  return { conversationId: created.id, created };
}

/** PATCH 판정의 재료 — 그 사람이 이 대화를 만들었나·이 채널의 세션 관리자인가 */
export function conversationActor(
  db: DbOrTx,
  conversation: Conversation,
  userId: string,
): { isCreator: boolean; isManager: boolean } {
  return {
    isCreator: conversation.createdBy.type === "user" && conversation.createdBy.id === userId,
    isManager: isSessionManager(db, conversation.channelId, userId),
  };
}

/**
 * 제목 바꾸기 — title_source 는 user 가 된다. 닫힌 대화도 바꾼다(정리는 쓰기가 아니다), 보관한 채널이면 CHANNEL_ARCHIVED. 같은 제목이면
 * 이벤트 없이 그대로
 */
export function renameConversation(
  db: Db,
  bus: ServerBus,
  conversationId: string,
  title: string,
): Conversation {
  const current = getConversation(db, conversationId);
  if (!current) throw apiError("NOT_FOUND", "conversation not found");
  assertChannelWritable(db, current.channelId);
  if (current.title === title && current.titleSource === "user") return current;
  const row = db
    .update(conversations)
    .set({ title, titleSource: "user" })
    .where(eq(conversations.id, conversationId))
    .returning()
    .get();
  if (!row) throw apiError("NOT_FOUND", "conversation not found");
  const conversation = rowToConversation(row);
  bus.emit("conversation.updated", { conversation });
  return conversation;
}

export type CloseDeps = {
  db: Db;
  bus: ServerBus;
  /** 닫으면 그 대화의 열린 런을 사람 「중지」와 같은 길로 멈춘다(걸린 승인은 cancelled) */
  runs?: { abortConversation(conversationId: string): Promise<void> };
};

/**
 * 닫기·다시 열기(채널 세션 스펙 「세션 만들기·닫기」 절) — 상태가 바뀔 때만: 닫으면 열린 런을 멈추고, 그 대화에 시스템 메시지
 * 「@<핸들> 이/가 이 세션을 닫았습니다」(다시 열면 「… 다시 열었습니다」)를 남기고 conversation.updated 를 한 번 낸다. 이미 그 상태면
 * 이벤트 없이 그대로. 보관한 채널이면 CHANNEL_ARCHIVED
 */
export async function setConversationClosed(
  deps: CloseDeps,
  input: { conversationId: string; byUserId: string; closed: boolean },
): Promise<Conversation> {
  const { db, bus } = deps;
  const current = getConversation(db, input.conversationId);
  if (!current) throw apiError("NOT_FOUND", "conversation not found");
  assertChannelWritable(db, current.channelId);
  const changed = db
    .update(conversations)
    .set(
      input.closed ? { closedAt: new Date(), closedBy: input.byUserId } : { closedAt: null, closedBy: null },
    )
    .where(
      and(
        eq(conversations.id, input.conversationId),
        input.closed ? isNull(conversations.closedAt) : isNotNull(conversations.closedAt),
      ),
    )
    .returning({ id: conversations.id })
    .get();
  if (!changed) return current;
  if (input.closed) await deps.runs?.abortConversation(input.conversationId);
  const who = db
    .select({ handle: users.handle })
    .from(users)
    .where(eq(users.id, input.byUserId))
    .get()?.handle;
  const handle = who ?? "알 수 없음";
  createSystemMessage(db, bus, {
    conversationId: input.conversationId,
    kind: "info",
    bodyMd: `@${handle} ${josa(handle, "이", "가")} 이 세션을 ${input.closed ? "닫았습니다" : "다시 열었습니다"}`,
  });
  const conversation = getConversation(db, input.conversationId);
  if (!conversation) throw apiError("NOT_FOUND", "conversation not found");
  bus.emit("conversation.updated", { conversation });
  return conversation;
}

const CURSOR = /^(\d{1,16})_([0-9a-f-]{36})$/;
const activity = sql<number>`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;

/**
 * 세션 목록 — 최근 활동(last_message_at, 없으면 created_at)순 20개 한 쪽. q 는 제목 부분 일치(SQLite LIKE — ASCII 만 대소문자를 가리지
 * 않는다, 한글은 대소문자가 없다). nextCursor 는 그 쪽 마지막 행의 (활동 시각, id) — 다음 쪽은 그보다 오래된 것만이라 겹치지 않는다
 */
export function listConversations(
  db: DbOrTx,
  channelId: string,
  q: { status: "open" | "closed" | "all"; q?: string; cursor?: string; limit?: number },
): ConversationList {
  const limit = q.limit ?? CONVERSATION_PAGE;
  let after: SQL | undefined;
  if (q.cursor !== undefined) {
    const m = CURSOR.exec(q.cursor);
    if (!m) throw apiError("VALIDATION", "cursor 가 틀렸다");
    const at = Number(m[1]);
    const id = m[2] as string;
    after = or(lt(activity, at), and(eq(activity, at), lt(conversations.id, id)));
  }
  const status =
    q.status === "open"
      ? isNull(conversations.closedAt)
      : q.status === "closed"
        ? isNotNull(conversations.closedAt)
        : undefined;
  const needle = q.q?.trim();
  const titleMatch =
    needle === undefined || needle === ""
      ? undefined
      : sql`${conversations.title} LIKE ${`%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} ESCAPE '\\'`;
  const rows = db
    .select({ row: conversations, activity })
    .from(conversations)
    .where(and(eq(conversations.channelId, channelId), status, titleMatch, after))
    .orderBy(desc(activity), desc(conversations.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    conversations: page.map((r) => rowToConversation(r.row)),
    ...(rows.length > limit && last ? { nextCursor: `${last.activity}_${last.row.id}` } : {}),
  };
}

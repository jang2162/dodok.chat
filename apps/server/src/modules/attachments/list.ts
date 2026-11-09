/**
 * 파일함 목록 — 사람이 읽을 수 있는 대화의 메시지에 묶인 첨부를 최신순으로(파일함 스펙 4.1). 새 표 없이 attachments ⋈ messages 를 바로
 * 조회한다. 채널 하나를 고른 요청의 404 는 라우트가 loadReadableChannel 로 먼저 낸다 — 여기는 거름만 한다
 */
import { artifactUrl, type FileList, FileListItem, type FileListQuery } from "@dodok/shared";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { readableChannelSql } from "../../auth/channel-access";
import type { DbOrTx } from "../../db/client";
import { channels } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { parseStored } from "../../http/validate";

type Row = {
  id: string;
  kind: string;
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  messageId: string;
  channelId: string;
  conversationId: string;
  conversationTitle: string;
  seq: number;
  threadRootId: string | null;
  authorType: string;
  authorId: string | null;
  createdAt: number;
  /** SQLite 는 불을 정수로 준다 */
  channelArchived: number;
  pos: number;
};

/** pos 는 그 첨부의 attachments_json 안 자리 — 한 메시지의 첨부가 쪽 경계에 걸려도 메시지에 보이는 순서대로 잇는다 */
const FileCursor = z.object({ createdAt: z.int(), messageId: z.string(), pos: z.int().min(0) });
type FileCursor = z.infer<typeof FileCursor>;

export function listFiles(
  db: DbOrTx,
  viewer: { userId: string; workspaceId: string },
  q: FileListQuery,
): FileList {
  // 결과를 뽑은 뒤 거르지 않는다 — 남의 DM 의 첨부가 쪽 자리·커서를 먹는다(사람 간 DM 스펙 4장). A(메시지 삭제)가 들어오면 지운 메시지
  // 거름이 이 WHERE 에 더해진다(파일함 스펙 「A 가 들어올 때」)
  const where: SQL[] = [
    sql`a.message_id IS NOT NULL`,
    sql`m.kind = 'normal'`,
    sql`a.channel_id IN (SELECT ${channels.id} FROM ${channels} WHERE ${channels.workspaceId} = ${viewer.workspaceId} AND ${readableChannelSql(viewer.userId)})`,
  ];
  if (q.channelId) where.push(sql`a.channel_id = ${q.channelId}`);
  if (q.kind) where.push(sql`a.kind = ${q.kind}`);
  if (q.authorType) where.push(sql`m.author_type = ${q.authorType}`);
  if (q.authorId) where.push(sql`m.author_id = ${q.authorId}`);
  if (q.q !== undefined) {
    // 이름은 NFC 로 저장한다 — NFD 로 온 검색어(macOS 조합형)도 같은 꼴로. NUL 은 LIKE 패턴을 거기서 잘라 더 넓게 찾는다
    const needle = q.q.normalize("NFC");
    if (needle.includes("\u0000")) throw apiError("VALIDATION", "q 에 NUL 문자를 쓸 수 없다");
    where.push(sql`a.name LIKE ${`%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} ESCAPE '\\'`);
  }
  const after = q.cursor === undefined ? sql`1` : afterCursor(decodeCursor(q.cursor));
  const rows = db.all<Row>(sql`SELECT * FROM (
      SELECT a.id AS id, a.kind AS kind, a.name AS name, a.mime AS mime, a.size AS size, a.width AS width, a.height AS height,
        m.id AS messageId, m.channel_id AS channelId, m.conversation_id AS conversationId,
        (SELECT v.title FROM conversations v WHERE v.id = m.conversation_id) AS conversationTitle,
        m.seq AS seq, m.thread_root_id AS threadRootId, m.author_type AS authorType, m.author_id AS authorId,
        m.created_at AS createdAt,
        (SELECT c.archived_at IS NOT NULL FROM channels c WHERE c.id = m.channel_id) AS channelArchived,
        (SELECT CAST(j.key AS INTEGER) FROM json_each(m.attachments_json) j WHERE json_extract(j.value, '$.id') = a.id) AS pos
      FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE ${sql.join(where, sql` AND `)}
    ) WHERE ${after}
    ORDER BY createdAt DESC, messageId DESC, pos ASC LIMIT ${q.limit + 1}`);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > q.limit && last
      ? encodeCursor({ createdAt: last.createdAt, messageId: last.messageId, pos: last.pos })
      : undefined;
  return { items: page.map(toItem), ...(nextCursor ? { nextCursor } : {}) };
}

function afterCursor(c: FileCursor): SQL {
  return sql`(createdAt < ${c.createdAt} OR (createdAt = ${c.createdAt} AND (messageId < ${c.messageId}
    OR (messageId = ${c.messageId} AND pos > ${c.pos}))))`;
}

// 커서는 불투명 문자열이다 — 웹은 받은 그대로 되돌려 준다(검색 커서와 같은 꼴)
function encodeCursor(c: FileCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string): FileCursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw apiError("VALIDATION", "cursor 가 올바르지 않다");
  }
  const parsed = FileCursor.safeParse(value);
  if (!parsed.success) throw apiError("VALIDATION", "cursor 가 올바르지 않다");
  return parsed.data;
}

function toItem(row: Row): FileListItem {
  return parseStored(
    FileListItem,
    {
      attachment: {
        id: row.id,
        kind: row.kind,
        url: artifactUrl(row.id),
        name: row.name,
        mime: row.mime,
        size: row.size,
        ...(row.width === null ? {} : { width: row.width }),
        ...(row.height === null ? {} : { height: row.height }),
      },
      messageId: row.messageId,
      channelId: row.channelId,
      conversationId: row.conversationId,
      conversationTitle: row.conversationTitle,
      seq: row.seq,
      ...(row.threadRootId === null ? {} : { threadRootId: row.threadRootId }),
      authorType: row.authorType,
      ...(row.authorId === null ? {} : { authorId: row.authorId }),
      createdAt: new Date(row.createdAt).toISOString(),
      channelArchived: row.channelArchived === 1,
    },
    "file list item",
  );
}

import {
  SEARCH_SNIPPET_CLOSE,
  SEARCH_SNIPPET_OPEN,
  SearchHit,
  type SearchQuery,
  type SearchResult,
} from "@dodok/shared";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseStored } from "../../http/validate";

/** 전문 검색(스레드·검색 스펙 5장). 색인은 drizzle/*_search_fts.sql 의 FTS5 가상 테이블·트리거가 채운다 */

export const SEARCH_PAGE_SIZE = 20;
/** 2글자 검색어 — trigram 색인을 못 타 LIKE 로 훑으므로 범위를 좁힌다(스펙 결정 8) */
export const SHORT_QUERY_LIMITS = { maxAgeDays: 90, maxHits: 50 } as const;
// 일치 앞뒤 코드 포인트. 앞뒤 64 + 검색어 최대 200 + 표시·말줄임 4 = 332 라 SearchHit.snippet 상한 400 안이다
// (zod 4 의 문자열 길이는 코드 포인트로 센다 — 아스트랄 문자가 가득해도 넘치지 않는다)
const SNIPPET_CONTEXT = 64;
const DAY_MS = 86_400_000;

type HitRow = {
  id: string;
  channelId: string;
  seq: number;
  authorType: string;
  authorId: string | null;
  createdAt: number;
  bodyMd: string;
  attachmentsJson: string;
  threadRootId: string | null;
  rank?: number;
};

const MatchCursor = z.object({ rank: z.number(), createdAt: z.int(), id: z.string() });
type MatchCursor = z.infer<typeof MatchCursor>;

const SELECT_HIT = sql`m.id AS id, m.channel_id AS channelId, m.seq AS seq, m.author_type AS authorType, m.author_id AS authorId,
  m.created_at AS createdAt, m.body_md AS bodyMd, m.attachments_json AS attachmentsJson,
  m.thread_root_id AS threadRootId`;

/**
 * 3글자 이상은 FTS MATCH(bm25 다음 최신순, 커서 페이지), 2글자는 LIKE(최근 90일·50개, 커서 없음 — `limited: true`).
 * 글자 수는 코드 포인트로 센다 — trigram 토큰이 코드 포인트 셋이고, SearchQuery 의 2~200 도 zod 4 가 코드 포인트로 잰다
 */
export function searchMessages(
  db: DbOrTx,
  workspaceId: string,
  userId: string,
  q: SearchQuery,
  now: Date,
): SearchResult {
  // FTS5 쿼리 파서는 NUL 에서 문자열을 끝내 「unterminated string」 500 이 되고, LIKE 는 패턴이 NUL 에서 잘려 더 넓게 찾는다
  if (q.q.includes("\u0000")) throw apiError("VALIDATION", "검색어에 NUL 문자를 쓸 수 없다");
  const where = [sql`m.kind = 'normal'`, readableChannels(workspaceId, userId), ...filters(q)];
  if ([...q.q].length === 2) {
    const since = now.getTime() - SHORT_QUERY_LIMITS.maxAgeDays * DAY_MS;
    const rows = db.all<HitRow>(sql`SELECT ${SELECT_HIT} FROM messages m
      WHERE ${sql.join(where, sql` AND `)} AND m.created_at >= ${since} AND m.body_md LIKE ${likePattern(q.q)} ESCAPE '\\'
      ORDER BY m.created_at DESC, m.id DESC LIMIT ${SHORT_QUERY_LIMITS.maxHits}`);
    return { hits: rows.map((r) => toHit(r, q.q)), limited: true };
  }
  if (q.cursor !== undefined) where.push(afterCursor(decodeCursor(q.cursor)));
  // MATERIALIZED — bm25 를 일치 행마다 한 번만 계산하고, 바깥 WHERE 가 보조 함수를 다시 부르지 않게
  const rows = db.all<HitRow>(sql`WITH hits AS MATERIALIZED (
      SELECT rowid AS rid, bm25(messages_fts) AS rank FROM messages_fts WHERE messages_fts MATCH ${ftsPhrase(q.q)}
    )
    SELECT ${SELECT_HIT}, h.rank AS rank FROM hits h JOIN messages m ON m.rowid = h.rid
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY h.rank ASC, m.created_at DESC, m.id DESC LIMIT ${SEARCH_PAGE_SIZE + 1}`);
  const page = rows.slice(0, SEARCH_PAGE_SIZE);
  const last = page.at(-1);
  const nextCursor =
    rows.length > SEARCH_PAGE_SIZE && last
      ? encodeCursor({ rank: last.rank ?? 0, createdAt: last.createdAt, id: last.id })
      : undefined;
  return { hits: page.map((r) => toHit(r, q.q)), limited: false, ...(nextCursor ? { nextCursor } : {}) };
}

/**
 * 사용자가 읽을 수 있는 채널. 지금은 워크스페이스의 모든 채널이다(스펙 5.2 「권한」) — 비공개 채널이 생기면 userId 로
 * channel_members 를 거르는 자리가 여기다
 */
function readableChannels(workspaceId: string, _userId: string): SQL {
  return sql`m.channel_id IN (SELECT c.id FROM channels c WHERE c.workspace_id = ${workspaceId})`;
}

function filters(q: SearchQuery): SQL[] {
  const out: SQL[] = [];
  if (q.channelId) out.push(sql`m.channel_id = ${q.channelId}`);
  if (q.authorType) out.push(sql`m.author_type = ${q.authorType}`);
  if (q.authorId) out.push(sql`m.author_id = ${q.authorId}`);
  // from·to 는 서버 현지 날짜 — to 는 그날 끝까지(다음 날 자정 미만)
  if (q.from) out.push(sql`m.created_at >= ${localMidnight(q.from, 0)}`);
  if (q.to) out.push(sql`m.created_at < ${localMidnight(q.to, 1)}`);
  return out;
}

function localMidnight(isoDate: string, addDays: number): number {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d + addDays).getTime();
}

/** 입력 전체를 따옴표 구절 하나로 — 연산자(OR·NEAR·*·^·열 필터)가 문법으로 읽히지 않는다. 구절 안 따옴표는 두 겹으로 */
function ftsPhrase(q: string): string {
  return `"${q.replaceAll('"', '""')}"`;
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function afterCursor(c: MatchCursor): SQL {
  return sql`(h.rank > ${c.rank} OR (h.rank = ${c.rank} AND (m.created_at < ${c.createdAt}
    OR (m.created_at = ${c.createdAt} AND m.id < ${c.id}))))`;
}

// 커서는 불투명 문자열이다 — 웹은 받은 그대로 되돌려 준다. bm25 는 말뭉치 통계라 페이지 사이에 메시지가 늘면 순위가 조금 흔들린다
function encodeCursor(c: MatchCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string): MatchCursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw apiError("VALIDATION", "cursor 가 올바르지 않다");
  }
  const parsed = MatchCursor.safeParse(value);
  if (!parsed.success) throw apiError("VALIDATION", "cursor 가 올바르지 않다");
  return parsed.data;
}

/** 행 → SearchHit 변환은 여기 한 곳이다(MATCH·LIKE 두 경로). 스레드 답글이면 그 루트 id 를 싣는다 */
function toHit(row: HitRow, q: string): SearchHit {
  return parseStored(
    SearchHit,
    {
      messageId: row.id,
      channelId: row.channelId,
      seq: row.seq,
      authorType: row.authorType,
      authorId: row.authorId ?? undefined,
      threadRootId: row.threadRootId ?? undefined,
      createdAt: new Date(row.createdAt).toISOString(),
      snippet: snippetOf(row, q),
    },
    "search hit",
  );
}

/** 본문에서 첫 일치를 자른다. 첨부 이름으로만 찾힌 행은 이름에서, 그래도 없으면(대소문자 접기 차이 등) 본문 머리를 표시 없이 */
function snippetOf(row: HitRow, q: string): string {
  return cutAround(row.bodyMd, q) ?? cutAround(attachmentNames(row.attachmentsJson), q) ?? head(row.bodyMd);
}

function attachmentNames(json: string): string {
  try {
    const list = JSON.parse(json) as Array<{ name?: unknown }>;
    return Array.isArray(list) ? list.map((a) => (typeof a?.name === "string" ? a.name : "")).join(" ") : "";
  } catch {
    return "";
  }
}

/**
 * FTS snippet() 을 쓰지 않는 까닭: 토큰 단위라 trigram 에서는 잘리는 글자 수가 흔들린다. 그래서 본문에서 직접 찾는다.
 * 본문에 이미 든 표시 문자는 먼저 걷는다 — 두면 웹이 가짜 강조를 그린다(shared search 의 SEARCH_SNIPPET_OPEN 주석)
 */
function cutAround(text: string, q: string): string | undefined {
  const chars = Array.from(stripMarks(text));
  const needle = Array.from(q).map(fold);
  const at = indexOf(chars.map(fold), needle);
  if (at < 0) return undefined;
  const end = at + needle.length;
  const start = Math.max(0, at - SNIPPET_CONTEXT);
  const stop = Math.min(chars.length, end + SNIPPET_CONTEXT);
  const part = (from: number, to: number) => oneLine(chars.slice(from, to).join(""));
  return `${start > 0 ? "…" : ""}${part(start, at)}${SEARCH_SNIPPET_OPEN}${part(at, end)}${SEARCH_SNIPPET_CLOSE}${part(end, stop)}${stop < chars.length ? "…" : ""}`;
}

function head(text: string): string {
  const chars = Array.from(stripMarks(text));
  const shown = chars.slice(0, SNIPPET_CONTEXT * 2);
  return `${oneLine(shown.join(""))}${shown.length < chars.length ? "…" : ""}`;
}

const stripMarks = (s: string): string =>
  s.replaceAll(SEARCH_SNIPPET_OPEN, "").replaceAll(SEARCH_SNIPPET_CLOSE, "");
const oneLine = (s: string): string => s.replace(/\s+/g, " ");

/** trigram case_sensitive 0 처럼 대소문자만 접는다. 접으면 길이가 바뀌는 글자(İ 등)는 그대로 둬 위치가 어긋나지 않게 */
function fold(ch: string): string {
  const lower = ch.toLowerCase();
  return lower.length === ch.length ? lower : ch;
}

function indexOf(hay: string[], needle: string[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

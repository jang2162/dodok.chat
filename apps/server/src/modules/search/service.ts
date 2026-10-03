import {
  PLAIN_MENTION_RE,
  SEARCH_SNIPPET_CLOSE,
  SEARCH_SNIPPET_OPEN,
  SearchHit,
  type SearchQuery,
  type SearchResult,
} from "@dodok/shared";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "../../db/client";
import { agents, channelMembers, channels, users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { parseStored } from "../../http/validate";
import { type Glyph, glyphRange, type HandleOf, plainGlyphs, readableGlyphs } from "./readable";

/** 전문 검색(스레드·검색 스펙 5장). 색인은 drizzle/*_search_fts.sql 의 FTS5 가상 테이블·트리거가 채운다 */

export const SEARCH_PAGE_SIZE = 20;
/** 2글자 검색어 — trigram 색인을 못 타 LIKE 로 훑으므로 범위를 좁힌다(스펙 결정 8) */
export const SHORT_QUERY_LIMITS = { maxAgeDays: 90, maxHits: 50 } as const;
// 일치 앞뒤 코드 포인트(화면 글자). 강조 범위는 멘션을 푼 글자라 검색어보다 길 수 있어서(별칭 「@wr」 → 「@writer」)
// 강조가 길면 앞뒤를 줄이고, 그래도 넘치면 강조를 자른다 — SNIPPET_BUDGET 은 SearchHit.snippet 상한 400 에서 표시·말줄임 4 를 뺀 값
// (zod 4 의 문자열 길이는 코드 포인트로 센다 — 아스트랄 문자가 가득해도 넘치지 않는다)
const SNIPPET_CONTEXT = 64;
const SNIPPET_BUDGET = 396;
/** 검색어 안 `@핸들` 이 여러 사람·에이전트로 풀릴 때 만드는 대체 검색어 수 상한 — 넘치면 뒤 핸들은 글자 그대로 찾는다 */
const MAX_ALTERNATIVES = 8;
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
  const mentions = mentionDirectory(db, workspaceId, q.channelId);
  const needles = expandHandles(q.q, mentions);
  const hit = (r: HitRow) => toHit(r, needles, mentions.handleOf);
  if ([...q.q].length === 2) {
    const since = now.getTime() - SHORT_QUERY_LIMITS.maxAgeDays * DAY_MS;
    // 2글자 검색어에는 `@핸들`(핸들 2자 이상)이 들어갈 수 없어 needles 는 늘 [q] 다 — 경로 문턱이 바뀌어도 두 경로가 같은 규칙으로 찾게 같은 needles 를 쓴다
    const like = sql.join(
      needles.map((n) => sql`m.body_md LIKE ${likePattern(n)} ESCAPE '\\'`),
      sql` OR `,
    );
    const rows = db.all<HitRow>(sql`SELECT ${SELECT_HIT} FROM messages m
      WHERE ${sql.join(where, sql` AND `)} AND m.created_at >= ${since} AND (${like})
      ORDER BY m.created_at DESC, m.id DESC LIMIT ${SHORT_QUERY_LIMITS.maxHits}`);
    return { hits: rows.map(hit), limited: true };
  }
  if (q.cursor !== undefined) where.push(afterCursor(decodeCursor(q.cursor)));
  // MATERIALIZED — bm25 를 일치 행마다 한 번만 계산하고, 바깥 WHERE 가 보조 함수를 다시 부르지 않게
  const rows = db.all<HitRow>(sql`WITH hits AS MATERIALIZED (
      SELECT rowid AS rid, bm25(messages_fts) AS rank FROM messages_fts WHERE messages_fts MATCH ${needles.map(ftsPhrase).join(" OR ")}
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
  return { hits: page.map(hit), limited: false, ...(nextCursor ? { nextCursor } : {}) };
}

type MentionDirectory = {
  handleOf: HandleOf;
  /** 소문자 핸들 → 그 핸들로 보이는 멘션 토큰들 */
  tokensOf(handle: string): string[];
};

/**
 * 멘션 토큰 ↔ 보이는 핸들. 스니펫이 토큰을 푸는 규칙과 검색어 `@핸들` 을 토큰으로 바꾸는 규칙은 서로 역이다 —
 * 스니펫에 보인 「@핸들」 로 다시 찾으면 그 메시지가 나온다. 핸들은 웹 useAuthors 의 mention 과 같게 고른다(사람은 나갔으면 옛 핸들).
 * 별칭은 검색 범위 채널(channelId 가 없으면 워크스페이스 모든 채널)의 것만 — 별칭은 채널마다 따로 붙는다
 */
function mentionDirectory(db: DbOrTx, workspaceId: string, channelId: string | undefined): MentionDirectory {
  const byId = new Map<string, string>();
  const byHandle = new Map<string, Set<string>>();
  const add = (handle: string, token: string) => {
    const key = handle.toLowerCase();
    const set = byHandle.get(key) ?? new Set<string>();
    set.add(token);
    byHandle.set(key, set);
  };
  const bots = db
    .select({ id: agents.id, handle: agents.handle })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId))
    .all();
  for (const a of bots) {
    byId.set(`a:${a.id}`, a.handle);
    add(a.handle, `<@a:${a.id}>`);
  }
  const people = db
    .select({ id: users.id, handle: users.handle, leftHandle: users.leftHandle })
    .from(users)
    .where(eq(users.workspaceId, workspaceId))
    .all();
  for (const p of people) {
    const shown = p.leftHandle ?? p.handle;
    byId.set(`u:${p.id}`, shown);
    add(shown, `<@u:${p.id}>`);
  }
  const aliased = db
    .select({ memberId: channelMembers.memberId, aliases: channelMembers.aliases })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channelMembers.memberType, "agent"),
        ...(channelId ? [eq(channelMembers.channelId, channelId)] : []),
      ),
    )
    .all();
  for (const m of aliased) for (const alias of m.aliases) add(alias, `<@a:${m.memberId}>`);
  return {
    handleOf: (kind, id) => byId.get(`${kind}:${id}`),
    tokensOf: (handle) => [...(byHandle.get(handle.toLowerCase()) ?? [])],
  };
}

/**
 * 검색어 안 `@핸들` 을 멘션 토큰으로 바꾼 대체 검색어들 — 색인(원문)에는 토큰이 들어 있어서다. 핸들 하나가 여럿으로 풀리면(사람과
 * 에이전트가 같은 핸들 등) 경우마다 하나씩 만들어 OR 로 찾는다. 모르는 핸들은 글자 그대로. 핸들을 찾는 꼴은 shared tokenize 와 같은
 * PLAIN_MENTION_RE 다 — 본문을 토큰으로 바꾼 규칙과 같아야 같은 자리가 찾힌다
 */
function expandHandles(q: string, mentions: MentionDirectory): string[] {
  let alts = [""];
  let last = 0;
  for (const m of q.matchAll(PLAIN_MENTION_RE)) {
    const at = (m.index as number) + (m[1] as string).length;
    const end = (m.index as number) + m[0].length;
    const tokens = mentions.tokensOf(m[2] as string);
    const choices =
      tokens.length > 0 && alts.length * tokens.length <= MAX_ALTERNATIVES ? tokens : [q.slice(at, end)];
    const between = q.slice(last, at);
    alts = alts.flatMap((a) => choices.map((c) => a + between + c));
    last = end;
  }
  return alts.map((a) => a + q.slice(last));
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
function toHit(row: HitRow, needles: string[], handleOf: HandleOf): SearchHit {
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
      snippet: snippetOf(row, needles, handleOf),
    },
    "search hit",
  );
}

/**
 * 본문에서 첫 일치를 자른다. 첨부 이름으로만 찾힌 행은 이름에서, 그래도 없으면(대소문자 접기 차이 등) 본문 머리를 표시 없이.
 * 본문은 읽는 글(readable.ts — 멘션은 @핸들, 마크다운 문법은 걷음)로 보인다. 일치는 원문에서 찾고 강조는 그 원문 범위를 낳은 화면 글자에 둔다
 */
function snippetOf(row: HitRow, needles: string[], handleOf: HandleOf): string {
  const body = stripMarks(row.bodyMd);
  const bodyGlyphs = readableGlyphs(body, handleOf);
  const names = stripMarks(attachmentNames(row.attachmentsJson));
  return (
    cutAround(body, bodyGlyphs, needles) ?? cutAround(names, plainGlyphs(names), needles) ?? head(bodyGlyphs)
  );
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
 * FTS snippet() 을 쓰지 않는 까닭: 토큰 단위라 trigram 에서는 잘리는 글자 수가 흔들린다. 그래서 원문에서 직접 찾는다.
 * 대체 검색어 가운데 원문에서 가장 앞에 나오는 일치를 쓴다. 일치가 화면 글자를 하나도 낳지 않으면(코드 펜스 표시만 찾은 경우 등) 일치 없음
 */
function cutAround(raw: string, glyphs: Glyph[], needles: string[]): string | undefined {
  let found: [number, number] | undefined;
  for (const needle of needles) {
    const m = indexOfFolded(raw, needle);
    if (m && (found === undefined || m[0] < found[0])) found = m;
  }
  const range = found && glyphRange(glyphs, found[0], found[1]);
  if (range === undefined) return undefined;
  const at = range[0];
  const end = Math.min(range[1] + 1, at + SNIPPET_BUDGET);
  const context = Math.min(SNIPPET_CONTEXT, Math.floor((SNIPPET_BUDGET - (end - at)) / 2));
  const start = Math.max(0, at - context);
  const stop = Math.min(glyphs.length, end + context);
  const part = (from: number, to: number) => text(glyphs.slice(from, to));
  return `${start > 0 ? "…" : ""}${part(start, at)}${SEARCH_SNIPPET_OPEN}${part(at, end)}${SEARCH_SNIPPET_CLOSE}${part(end, stop)}${stop < glyphs.length ? "…" : ""}`;
}

function head(glyphs: Glyph[]): string {
  const shown = glyphs.slice(0, SNIPPET_CONTEXT * 2);
  return `${text(shown)}${shown.length < glyphs.length ? "…" : ""}`;
}

const text = (glyphs: Glyph[]): string => glyphs.map((g) => g.ch).join("");
// 본문에 이미 든 표시 문자는 먼저 걷는다 — 두면 웹이 가짜 강조를 그린다(shared search 의 SEARCH_SNIPPET_OPEN 주석)
const stripMarks = (s: string): string =>
  s.replaceAll(SEARCH_SNIPPET_OPEN, "").replaceAll(SEARCH_SNIPPET_CLOSE, "");

/** trigram case_sensitive 0 처럼 대소문자만 접는다. 접으면 길이가 바뀌는 글자(İ 등)는 그대로 둬 위치가 어긋나지 않게 */
function fold(ch: string): string {
  const lower = ch.toLowerCase();
  return lower.length === ch.length ? lower : ch;
}

/** 대소문자를 접어 찾은 첫 일치의 원문 범위(UTF-16 오프셋 [from, to)). 비교는 코드 포인트 단위 */
function indexOfFolded(raw: string, needle: string): [number, number] | undefined {
  const chars = Array.from(raw);
  const hay = chars.map(fold);
  const want = Array.from(needle).map(fold);
  outer: for (let i = 0; i + want.length <= hay.length; i++) {
    for (let j = 0; j < want.length; j++) if (hay[i + j] !== want[j]) continue outer;
    const from = chars.slice(0, i).join("").length;
    return [from, from + chars.slice(i, i + want.length).join("").length];
  }
  return undefined;
}

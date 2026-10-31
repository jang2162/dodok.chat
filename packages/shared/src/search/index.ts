import { z } from "zod";
import { Id, IsoDateTime } from "../common";
import { ConversationTitle } from "../domain";

// GET /api/v1/search (스레드·검색 스펙 5.2)

export const SearchQuery = z.object({
  q: z.string().trim().min(2).max(200),
  channelId: Id.optional(),
  /** 한 세션 안에서만 — 채널과 함께 주면 둘 다 맞아야 한다 */
  conversationId: Id.optional(),
  authorType: z.enum(["user", "agent", "automation"]).optional(),
  authorId: Id.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  cursor: z.string().max(200).optional(),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const SearchHit = z.object({
  messageId: Id,
  channelId: Id,
  /** 그 메시지의 세션 — 결과로 가기가 `/c/<channelId>/s/<conversationId>` 로 간다 */
  conversationId: Id,
  /** 그 세션의 지금 제목 — 결과 줄에 「#채널 · 제목」으로 보인다 */
  conversationTitle: ConversationTitle,
  /** 결과로 가기가 `?around=<seq>` 로 그 자리를 받는다 — 답글이면 채널 타임라인은 서버가 그 루트를 가운데로 둔다 */
  seq: z.number().int().min(1),
  threadRootId: Id.optional(),
  /** 보관한 채널의 메시지 — 웹은 「보관됨」을 붙이고, 결과로 가기는 읽기 전용 채널 화면으로 간다 */
  channelArchived: z.boolean(),
  /** 검색은 kind normal 을 모두 찾는다 — 자동화 글도 결과에 든다(authorId 는 자동화 id) */
  authorType: z.enum(["user", "agent", "automation"]),
  authorId: Id.optional(),
  createdAt: IsoDateTime,
  /** 일치 부분을 SEARCH_SNIPPET_OPEN·CLOSE 로 감싼 평문. 서버는 HTML 을 만들지 않는다 — 강조는 웹이 그린다 */
  snippet: z.string().max(400),
});
export type SearchHit = z.infer<typeof SearchHit>;

/** `limited` 는 2글자 검색이라 최근 90일·50개까지만 찾았다는 뜻 */
export const SearchResult = z.object({
  hits: z.array(SearchHit),
  nextCursor: z.string().optional(),
  limited: z.boolean(),
});
export type SearchResult = z.infer<typeof SearchResult>;

// 키보드로 치지 않는 제어 문자(STX·ETX)를 고른 것은 사용자 글자와 섞이지 않게 해서다.
// 본문에 이 문자가 이미 들어 있으면 웹이 가짜 강조를 그리므로 스니펫을 만드는 쪽이 먼저 걷는다
export const SEARCH_SNIPPET_OPEN = "\u0002";
export const SEARCH_SNIPPET_CLOSE = "\u0003";

import { describe, expect, it } from "vitest";
import {
  BridgeCapability,
  BridgeHello,
  InboundContext,
  InboundDeliver,
  OutboundMessage,
} from "../src/bridge";
import { Message, ThreadSummary } from "../src/domain";
import * as root from "../src/index";
import {
  SEARCH_SNIPPET_CLOSE,
  SEARCH_SNIPPET_OPEN,
  SearchHit,
  SearchQuery,
  SearchResult,
} from "../src/search";
import { ChannelSubscribeResult, MessageSend } from "../src/wire";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;
const NOW = "2026-09-25T00:00:00Z";
const AUTHOR = { type: "user", handle: "jang", displayName: "장" } as const;

const context = (thread?: unknown) => ({
  recentMessages: [],
  participants: [],
  relayRules: "최대 4턴",
  ...(thread === undefined ? {} : { thread }),
});

describe("ThreadSummary·Message", () => {
  const summary = { count: 3, lastAt: NOW, agentIds: [ID(1)] };

  it("count 0 은 거절, 1 이상 정수만", () => {
    expect(ThreadSummary.safeParse(summary).success).toBe(true);
    expect(ThreadSummary.safeParse({ ...summary, count: 0 }).success).toBe(false);
    expect(ThreadSummary.safeParse({ ...summary, count: 1.5 }).success).toBe(false);
  });

  it("agentIds 최대 10개", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => ID(i + 1));
    expect(ThreadSummary.safeParse({ ...summary, agentIds: ids(10) }).success).toBe(true);
    expect(ThreadSummary.safeParse({ ...summary, agentIds: ids(11) }).success).toBe(false);
  });

  it("Message 의 threadRootId·threadSummary 는 선택", () => {
    const base = {
      id: ID(2),
      channelId: ID(3),
      seq: 1,
      kind: "normal",
      authorType: "user",
      authorId: ID(4),
      bodyMd: "안녕",
      mentions: { users: [], agents: [] },
      createdAt: NOW,
    };
    expect(Message.safeParse(base).success).toBe(true);
    const reply = Message.parse({ ...base, threadRootId: ID(5) });
    expect(reply.threadRootId).toBe(ID(5));
    const rootMsg = Message.parse({ ...base, threadSummary: summary });
    expect(rootMsg.threadSummary).toEqual(summary);
    expect(Message.safeParse({ ...base, threadRootId: "nope" }).success).toBe(false);
    expect(Message.safeParse({ ...base, threadSummary: { ...summary, count: 0 } }).success).toBe(false);
  });
});

describe("MessageSend.threadRootId", () => {
  it("선택, UUID 만", () => {
    const base = { channelId: ID(1), clientMsgId: "c1", bodyMd: "답글" };
    expect(MessageSend.parse({ ...base, threadRootId: ID(2) }).threadRootId).toBe(ID(2));
    expect(MessageSend.safeParse(base).success).toBe(true);
    expect(MessageSend.safeParse({ ...base, threadRootId: "root" }).success).toBe(false);
  });
});

describe("ChannelSubscribeResult.threadRoots", () => {
  it("선택, Message 배열 — 재동기화 페이지 답글의 옛 루트", () => {
    const base = { messages: [], hasMore: false, activeRuns: [], pendingApprovals: [] };
    expect(ChannelSubscribeResult.parse(base)).not.toHaveProperty("threadRoots");
    const rootMsg = {
      id: ID(2),
      channelId: ID(3),
      seq: 1,
      kind: "normal",
      authorType: "user",
      authorId: ID(4),
      bodyMd: "루트",
      mentions: { users: [], agents: [] },
      createdAt: NOW,
      threadSummary: { count: 2, lastAt: NOW, agentIds: [] },
    };
    expect(ChannelSubscribeResult.parse({ ...base, threadRoots: [rootMsg] }).threadRoots).toMatchObject([
      rootMsg,
    ]);
    expect(ChannelSubscribeResult.safeParse({ ...base, threadRoots: [{ id: "x" }] }).success).toBe(false);
  });
});

describe("브리지 스레드 계약", () => {
  it('BridgeCapability 에 "threads"', () => {
    expect(BridgeCapability.safeParse("threads").success).toBe(true);
    expect(
      BridgeHello.safeParse({
        pluginId: "dodok",
        version: "0.1.0",
        sdkVersion: "2026.9.4",
        capabilities: ["threads"],
      }).success,
    ).toBe(true);
  });

  it("InboundContext.thread 는 선택 — 루트 본문 4,000자까지, 최근 20개까지", () => {
    const item = (text: string) => ({ author: AUTHOR, text, ts: NOW });
    const thread = (rootText: string, n: number) => ({
      root: item(rootText),
      recentMessages: Array.from({ length: n }, (_, i) => item(`r${i}`)),
    });
    expect(InboundContext.safeParse(context()).success).toBe(true);
    expect(InboundContext.safeParse(context(thread("a".repeat(4000), 20))).success).toBe(true);
    expect(InboundContext.safeParse(context(thread("a".repeat(4001), 0))).success).toBe(false);
    expect(InboundContext.safeParse(context(thread("루트", 21))).success).toBe(false);
  });

  it("InboundDeliver.threadId·OutboundMessage.threadId 는 선택, UUID 만", () => {
    const deliver = {
      deliveryId: ID(1),
      kind: "message",
      channelId: ID(2),
      agentId: "dev",
      sessionKey: `agent:dev:dodok:channel:${ID(2)}:thread:${ID(5)}`,
      runId: ID(3),
      message: { id: ID(4), author: AUTHOR, text: "@dev 봐 줘", attachments: [], ts: NOW },
      context: context(),
    };
    expect(InboundDeliver.parse({ ...deliver, threadId: ID(5) }).threadId).toBe(ID(5));
    expect(InboundDeliver.safeParse(deliver).success).toBe(true);
    expect(InboundDeliver.safeParse({ ...deliver, threadId: "t" }).success).toBe(false);

    const outbound = {
      outboundId: "o1",
      channelId: ID(2),
      agentId: "dev",
      sessionKey: deliver.sessionKey,
      text: "답",
      ts: NOW,
    };
    expect(OutboundMessage.parse({ ...outbound, threadId: ID(5) }).threadId).toBe(ID(5));
    expect(OutboundMessage.safeParse(outbound).success).toBe(true);
    expect(OutboundMessage.safeParse({ ...outbound, threadId: "t" }).success).toBe(false);
  });
});

describe("검색 계약", () => {
  it("SearchQuery: 앞뒤 공백을 잘라 2~200자", () => {
    expect(SearchQuery.parse({ q: "  배포  " }).q).toBe("배포");
    expect(SearchQuery.safeParse({ q: "가" }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: " 가 " }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: "     " }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: "가".repeat(200) }).success).toBe(true);
    expect(SearchQuery.safeParse({ q: "가".repeat(201) }).success).toBe(false);
  });

  it("SearchQuery: 필터는 닫힌 모양", () => {
    const ok = SearchQuery.parse({
      q: "배포",
      channelId: ID(1),
      authorType: "agent",
      authorId: ID(2),
      from: "2026-09-01",
      to: "2026-09-25",
      cursor: "c",
    });
    expect(ok.authorType).toBe("agent");
    expect(SearchQuery.safeParse({ q: "배포", authorType: "system" }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: "배포", from: "2026-09-01T00:00:00Z" }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: "배포", cursor: "c".repeat(201) }).success).toBe(false);
  });

  it("SearchHit·SearchResult", () => {
    const hit = {
      messageId: ID(1),
      channelId: ID(2),
      seq: 7,
      channelArchived: false,
      authorType: "user",
      authorId: ID(3),
      createdAt: NOW,
      snippet: `앞 ${SEARCH_SNIPPET_OPEN}배포${SEARCH_SNIPPET_CLOSE} 뒤`,
    };
    expect(SearchHit.safeParse(hit).success).toBe(true);
    expect(SearchHit.safeParse({ ...hit, threadRootId: ID(4) }).success).toBe(true);
    // 자동화 글(kind normal)도 색인에 들어 결과로 나온다 — authorId 는 자동화 id
    expect(SearchHit.safeParse({ ...hit, authorType: "agent" }).success).toBe(true);
    expect(SearchHit.safeParse({ ...hit, authorType: "automation" }).success).toBe(true);
    expect(SearchHit.safeParse({ ...hit, authorType: "system" }).success).toBe(false);
    expect(SearchHit.safeParse({ ...hit, snippet: "a".repeat(401) }).success).toBe(false);
    // 결과로 가기가 around=<seq> 로 받는다(판정 R5)
    const { seq: _, ...noSeq } = hit;
    expect(SearchHit.safeParse(noSeq).success).toBe(false);
    expect(SearchHit.safeParse({ ...hit, seq: 0 }).success).toBe(false);
    // 보관한 채널 표시는 빠질 수 없다 — 웹이 「보관됨」을 붙인다
    const { channelArchived: __, ...noArchived } = hit;
    expect(SearchHit.safeParse(noArchived).success).toBe(false);
    expect(SearchResult.parse({ hits: [hit], limited: false })).toEqual({ hits: [hit], limited: false });
    expect(SearchResult.safeParse({ hits: [], nextCursor: "n" }).success).toBe(false);
  });

  it("스니펫 표시 문자는 STX·ETX", () => {
    expect(SEARCH_SNIPPET_OPEN).toBe("\u0002");
    expect(SEARCH_SNIPPET_CLOSE).toBe("\u0003");
  });
});

describe("루트 index", () => {
  it("새 계약과 헬퍼를 내보낸다", () => {
    for (const name of [
      "dodokSessionKey",
      "parseDodokSessionKey",
      "threadMatchesSessionKey",
      "ThreadSummary",
      "SearchQuery",
      "SearchHit",
      "SearchResult",
      "SEARCH_SNIPPET_OPEN",
      "SEARCH_SNIPPET_CLOSE",
    ]) {
      expect(root).toHaveProperty(name);
    }
  });
});

import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { users } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { createChannel } from "../src/modules/channels/service";
import { createUserMessage } from "../src/modules/messages/service";
import { SEARCH_PAGE_SIZE, searchMessages } from "../src/modules/search/service";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { createDmChannelForTest, seedConversation, seedWorkspace } from "./helpers/seed";

// 검색이 남의 DM 을 SQL 단계에서 거르는가(에이전트 DM 계획 Review Focus 2) — 결과를 뽑은 뒤 거르면 남의 DM 에 걸린 행이 페이지
// 자리를 먹어 빈 페이지·짧은 페이지가 나오고, 커서가 그 행을 가리켜 다음 페이지가 어긋난다

const NOW = new Date();
const WORD = "배포절차";

function setup() {
  const db = newTestDb();
  const bus = new ServerBus();
  const { workspaceId, userId: other } = seedWorkspace(db, { userHandle: "jang" });
  const mia = uuid();
  db.insert(users)
    .values({
      id: mia,
      workspaceId,
      handle: "mia",
      displayName: "mia",
      authProvider: "email",
      createdAt: NOW,
    })
    .run();
  const agent = createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev", name: "Dev" });
  const dm = createDmChannelForTest(db, { workspaceId, ownerId: mia, agentId: agent.id });
  const channel = createChannel(db, { workspaceId, createdBy: other, name: "general" });
  const dmConversation = seedConversation(db, dm.id, { createdBy: mia });
  const channelConversation = seedConversation(db, channel.id);
  let n = 0;
  const say = (conversationId: string, authorId: string, count: number) => {
    for (let i = 0; i < count; i++)
      createUserMessage(db, bus, {
        conversationId,
        authorId,
        bodyMd: `${WORD} ${i}`,
        clientMsgId: `c${n++}`,
      });
  };
  // DM 행이 앞 페이지 자리에 섞이게 둘을 번갈아 넣는다 — 한쪽을 몰아 넣으면 최신순 동점 정렬에서 DM 이 통째로 뒤로 밀려 걸러도 티가 안 난다
  for (let round = 0; round < 30; round++) {
    say(dmConversation, mia, 4);
    say(channelConversation, other, 1);
  }
  return { db, workspaceId, mia, other, dm, channel };
}

/** 커서를 끝까지 따라가며 모든 페이지를 모은다 */
function allPages(db: ReturnType<typeof setup>["db"], workspaceId: string, userId: string) {
  const pages: string[][] = [];
  const channels = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = searchMessages(db, workspaceId, userId, { q: WORD, ...(cursor ? { cursor } : {}) }, NOW);
    pages.push(page.hits.map((h) => h.messageId));
    for (const h of page.hits) channels.add(h.channelId);
    cursor = page.nextCursor;
  } while (cursor !== undefined && pages.length < 50);
  return { pages, ids: pages.flat(), channels };
}

describe("검색 — 남의 DM 은 SQL 에서 거른다", () => {
  it("남의 DM 에 120개·채널에 30개 → 남은 30개를 꽉 찬 페이지로 겹침·빠짐 없이, 주인은 150개", () => {
    const { db, workspaceId, mia, other, dm, channel } = setup();

    const theirs = allPages(db, workspaceId, other);
    expect(theirs.ids).toHaveLength(30);
    expect(new Set(theirs.ids).size).toBe(30);
    expect([...theirs.channels]).toEqual([channel.id]);
    // 마지막 페이지 말고는 모두 꽉 찬다 — 뽑은 뒤 거르면 남의 DM 행이 자리를 먹어 짧아진다
    expect(theirs.pages.slice(0, -1).every((p) => p.length === SEARCH_PAGE_SIZE)).toBe(true);
    expect(theirs.pages.map((p) => p.length)).toEqual([20, 10]);

    const own = allPages(db, workspaceId, mia);
    expect(own.ids).toHaveLength(150);
    expect(new Set(own.ids).size).toBe(150);
    expect([...own.channels].sort()).toEqual([dm.id, channel.id].sort());
  });

  it("2글자 검색(LIKE)도 같은 범위 — 남에게는 채널 것만", () => {
    const { db, workspaceId, other, channel } = setup();
    const res = searchMessages(db, workspaceId, other, { q: "배포" }, NOW);
    expect(res.hits).toHaveLength(30);
    expect(new Set(res.hits.map((h) => h.channelId))).toEqual(new Set([channel.id]));
  });
});

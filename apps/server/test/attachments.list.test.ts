import { type Attachment, FileListQuery, type FileListItem } from "@dodok/shared";
import { and, eq, sql } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { attachments, memberships, messages } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { listFiles } from "../src/modules/attachments/list";
import { createChannel } from "../src/modules/channels/service";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import {
  createDirectChannelForTest,
  createDmChannelForTest,
  seedConversation,
  seedWorkspace,
} from "./helpers/seed";

// 파일함 목록(파일함 스펙 4.1·10장). 메시지·첨부 행은 SQL 로 바로 넣는다 — 시각·첨부 순서·작성자(러너가 올린 첨부)를 마음대로 정해야
// 정렬·커서 경계를 칠 수 있다

type Author = { type: "user" | "agent" | "automation"; id: string | null };
type FileSpec = {
  name: string;
  kind?: "image" | "file";
  uploaderType?: "user" | "bridge";
  uploaderId?: string | null;
};

let app: App;
let session: { authorization: string };
let ownerId: string;
let mia: { id: string; token: string };
let jun: { id: string; token: string };
let kai: { id: string; token: string };
let agentId: string;
let runnerTokenId: string;

/** 시각은 넣는 순서대로 1초씩 늘린다 — 최신순 정렬의 기대값을 넣는 순서로 적는다 */
let clock = 1_800_000_000_000;
const seqOf = new Map<string, number>();

/** 메시지 하나와 그 첨부들을 넣는다. 첨부 id 는 넣는 순서의 반대로 늘게 만든다 — 한 메시지 안 정렬이 id 가 아니라 attachments_json 자리인지 드러나게 */
function post(
  channelId: string,
  conversationId: string,
  author: Author,
  files: FileSpec[],
  opts: { threadRootId?: string; kind?: string; at?: number } = {},
): { messageId: string; ids: string[]; createdAt: number } {
  const createdAt = opts.at ?? (clock += 1000);
  const messageId = uuid();
  const ids = files.map(() => uuid()).reverse();
  const seq = (seqOf.get(channelId) ?? 0) + 1;
  seqOf.set(channelId, seq);
  const atts: Attachment[] = files.map((f, i) => ({
    id: ids[i] as string,
    kind: f.kind ?? "file",
    url: `artifact://${ids[i]}`,
    name: f.name,
    mime: f.kind === "image" ? "image/png" : "application/octet-stream",
    size: 1,
  }));
  app.db
    .insert(messages)
    .values({
      id: messageId,
      channelId,
      conversationId,
      seq,
      kind: opts.kind ?? "normal",
      authorType: author.type,
      authorId: author.id,
      bodyMd: "",
      mentions: { agents: [], users: [] },
      attachments: atts,
      threadRootId: opts.threadRootId ?? null,
      createdAt: new Date(createdAt),
    })
    .run();
  files.forEach((f, i) =>
    app.db
      .insert(attachments)
      .values({
        id: ids[i] as string,
        channelId,
        uploaderType: f.uploaderType ?? (author.type === "user" ? "user" : "bridge"),
        uploaderId: f.uploaderId === undefined ? author.id : f.uploaderId,
        kind: f.kind ?? "file",
        name: f.name,
        mime: atts[i]?.mime as string,
        size: 1,
        sha256: "ab",
        messageId,
        createdAt: new Date(createdAt),
      })
      .run(),
  );
  return { messageId, ids, createdAt };
}

/** 커서를 끝까지 따라가며 모든 쪽을 모은다 */
function allPages(userId: string, query: Record<string, unknown> = {}) {
  const pages: FileListItem[][] = [];
  let cursor: string | undefined;
  do {
    const page = listFiles(
      app.db,
      { userId, workspaceId: app.workspaceId },
      FileListQuery.parse({ ...query, ...(cursor ? { cursor } : {}) }),
    );
    pages.push(page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined && pages.length < 200);
  return { pages, items: pages.flat(), names: pages.flat().map((i) => i.attachment.name) };
}

const get = (url: string, token?: string) =>
  app.fastify.inject({
    method: "GET",
    url,
    headers: token === undefined ? session : { authorization: `Bearer ${token}` },
  });

const user = (id: string): Author => ({ type: "user", id });

let general: string;
let generalS1: string;
let generalS2: string;
let archived: string;
let miaDm: string;
let miaJun: string;
let junKai: string;
let zzz: string;
let foreign: string;
let replyRootId: string;
let unboundId: string;

beforeAll(async () => {
  app = await bootTestApp();
  session = (await login(app)).headers;
  ownerId = app.db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, app.workspaceId), eq(memberships.role, "owner")))
    .get()?.userId as string;
  mia = await userWithRole(app, "mia", "member");
  jun = await userWithRole(app, "jun", "member");
  kai = await userWithRole(app, "kai", "member");
  agentId = createAgent(app.db, {
    workspaceId: app.workspaceId,
    providerAgentId: "dev",
    handle: "dev",
    name: "Dev",
  }).id;
  runnerTokenId = uuid();

  general = createChannel(app.db, { workspaceId: app.workspaceId, createdBy: ownerId, name: "general" }).id;
  generalS1 = seedConversation(app.db, general, { title: "첫 세션" });
  generalS2 = seedConversation(app.db, general, { title: "둘째 세션" });
  const arch = createChannel(app.db, { workspaceId: app.workspaceId, createdBy: ownerId, name: "old" }).id;
  const archS = seedConversation(app.db, arch);
  miaDm = createDmChannelForTest(app.db, { workspaceId: app.workspaceId, ownerId: mia.id, agentId }).id;
  const miaDmS = seedConversation(app.db, miaDm, { createdBy: mia.id });
  miaJun = createDirectChannelForTest(app.db, {
    workspaceId: app.workspaceId,
    createdBy: mia.id,
    userIds: [jun.id],
  }).id;
  const miaJunS = seedConversation(app.db, miaJun, { createdBy: mia.id });
  junKai = createDirectChannelForTest(app.db, {
    workspaceId: app.workspaceId,
    createdBy: jun.id,
    userIds: [kai.id],
  }).id;
  const junKaiS = seedConversation(app.db, junKai, { createdBy: jun.id });
  zzz = createChannel(app.db, { workspaceId: app.workspaceId, createdBy: ownerId, name: "zzz" }).id;
  const zzzS = seedConversation(app.db, zzz);
  app.db.run(sql`UPDATE channels SET kind = 'zzz' WHERE id = ${zzz}`);
  const other = seedWorkspace(app.db, { userHandle: "stranger" });
  foreign = createChannel(app.db, {
    workspaceId: other.workspaceId,
    createdBy: other.userId,
    name: "foreign",
  }).id;
  const foreignS = seedConversation(app.db, foreign);

  // 대화마다 번갈아 넣는다 — 읽을 수 없는 첨부가 읽을 수 있는 것 사이에 끼어 커서·쪽 자리를 먹는지 보게
  const root = post(general, generalS1, user(ownerId), [{ name: "general-root.png", kind: "image" }]);
  replyRootId = root.messageId;
  post(miaDm, miaDmS, user(mia.id), [{ name: "mia-dm.pdf" }]);
  post(general, generalS1, user(mia.id), [{ name: "general-reply.txt" }], { threadRootId: root.messageId });
  post(miaJun, miaJunS, user(jun.id), [{ name: "mia-jun.pdf" }]);
  post(junKai, junKaiS, user(kai.id), [{ name: "jun-kai.pdf" }]);
  post(general, generalS2, { type: "agent", id: agentId }, [
    { name: "runner-out.txt", uploaderType: "bridge", uploaderId: runnerTokenId },
    { name: "runner-shot.png", kind: "image", uploaderType: "bridge", uploaderId: runnerTokenId },
  ]);
  post(miaDm, miaDmS, { type: "agent", id: agentId }, [{ name: "mia-dm-agent.png", kind: "image" }]);
  post(arch, archS, user(ownerId), [{ name: "archived.zip" }]);
  post(zzz, zzzS, user(ownerId), [{ name: "zzz.pdf" }]);
  post(foreign, foreignS, user(other.userId), [{ name: "foreign.pdf" }]);
  post(general, generalS2, { type: "automation", id: uuid() }, [{ name: "auto-report.csv" }]);
  // 이름 거름 — %·_·\ 는 글자 그대로, NFC 로 저장한 한글
  post(general, generalS2, user(ownerId), [
    { name: "100%.txt" },
    { name: "100x.txt" },
    { name: "a_b.txt" },
    { name: "axb.txt" },
    { name: "c\\d.txt" },
    { name: "cd.txt" },
    { name: "report.PDF" },
    { name: "보고서.pdf".normalize("NFC") },
  ]);
  archived = arch;
  app.db.run(sql`UPDATE channels SET archived_at = ${Date.now()} WHERE id = ${arch}`);
  unboundId = uuid();
  app.db
    .insert(attachments)
    .values({
      id: unboundId,
      channelId: general,
      uploaderType: "user",
      uploaderId: ownerId,
      kind: "file",
      name: "unbound.pdf",
      mime: "application/pdf",
      size: 1,
      sha256: "ab",
      messageId: null,
      createdAt: new Date(),
    })
    .run();
});

afterAll(async () => {
  await app.close();
});

const GENERAL_NAMES = [
  "100%.txt",
  "100x.txt",
  "a_b.txt",
  "axb.txt",
  "c\\d.txt",
  "cd.txt",
  "report.PDF",
  "보고서.pdf",
  "auto-report.csv",
  "runner-out.txt",
  "runner-shot.png",
  "general-reply.txt",
  "general-root.png",
];

describe("GET /attachments — 읽을 수 있는 대화만", () => {
  it("mia 는 일반·보관 채널 + 자기 DM + 참여한 direct, 최신순·한 메시지 안은 첨부 순서", () => {
    const { names } = allPages(mia.id);
    expect(names).toEqual([
      ...GENERAL_NAMES.slice(0, 9),
      "archived.zip",
      "mia-dm-agent.png",
      "runner-out.txt",
      "runner-shot.png",
      "mia-jun.pdf",
      "general-reply.txt",
      "mia-dm.pdf",
      "general-root.png",
    ]);
  });

  it("owner·admin 도 남의 DM·참여하지 않은 direct 는 못 본다 — 묶이지 않은 것·모르는 kind·다른 워크스페이스는 아무도", () => {
    const owner = allPages(ownerId).names;
    expect(owner).toEqual([...GENERAL_NAMES.slice(0, 9), "archived.zip", ...GENERAL_NAMES.slice(9)]);
    const junNames = allPages(jun.id).names;
    expect(junNames).toContain("mia-jun.pdf");
    expect(junNames).toContain("jun-kai.pdf");
    expect(junNames).not.toContain("mia-dm.pdf");
    for (const who of [ownerId, mia.id, jun.id, kai.id]) {
      const all = allPages(who).names;
      expect(all).not.toContain("unbound.pdf");
      expect(all).not.toContain("zzz.pdf");
      expect(all).not.toContain("foreign.pdf");
    }
  });

  it("읽을 수 없는 첨부가 사이에 끼어도 두 개씩 쪽을 넘긴 합 = 한 번에 받은 것, 마지막 쪽 말고는 꽉 찬다", () => {
    for (const who of [ownerId, kai.id]) {
      const whole = allPages(who, { limit: 100 });
      expect(whole.pages).toHaveLength(1);
      const paged = allPages(who, { limit: 2 });
      expect(paged.items.map((i) => i.attachment.id)).toEqual(whole.items.map((i) => i.attachment.id));
      expect(paged.pages.slice(0, -1).every((p) => p.length === 2)).toBe(true);
    }
  });

  it("라우트 — 정적 경로가 :id 와 겹치지 않고, 첨부 하나 GET 도 그대로", async () => {
    const res = await get("/api/v1/attachments");
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { items: FileListItem[] }).items.map((i) => i.attachment.name)).toContain(
      "general-root.png",
    );
    const one = await get(`/api/v1/attachments/${uuid()}`);
    expect(one.statusCode).toBe(404);
    expect(one.json()).toMatchObject({ message: "attachment not found" });
  });
});

describe("channelId 거름", () => {
  it("읽을 수 있으면 그 대화 하나 — 보관한 채널도", async () => {
    const dm = await get(`/api/v1/attachments?channelId=${miaDm}`, mia.token);
    expect(dm.statusCode, dm.body).toBe(200);
    expect((dm.json() as { items: FileListItem[] }).items.map((i) => i.attachment.name)).toEqual([
      "mia-dm-agent.png",
      "mia-dm.pdf",
    ]);
    const arch = await get(`/api/v1/attachments?channelId=${archived}`, mia.token);
    expect(arch.statusCode).toBe(200);
    expect((arch.json() as { items: FileListItem[] }).items.map((i) => i.attachment.name)).toEqual([
      "archived.zip",
    ]);
  });

  it("남의 DM·참여하지 않은 direct·모르는 kind·없는 id·다른 워크스페이스 → 404 NOT_FOUND(빈 목록이 아니다)", async () => {
    const cases: Array<[string, string | undefined]> = [
      [miaDm, undefined],
      [miaJun, kai.token],
      [junKai, mia.token],
      [zzz, mia.token],
      [uuid(), mia.token],
      [foreign, mia.token],
    ];
    for (const [channelId, token] of cases) {
      const res = await get(`/api/v1/attachments?channelId=${channelId}`, token);
      expect(res.statusCode, `${channelId} ${res.body}`).toBe(404);
      expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
    }
  });
});

describe("종류·올린 사람 거름", () => {
  it("kind image·file", () => {
    expect(allPages(ownerId, { channelId: general, kind: "image" }).names).toEqual([
      "runner-shot.png",
      "general-root.png",
    ]);
    const files = allPages(ownerId, { channelId: general, kind: "file" }).names;
    expect(files).not.toContain("runner-shot.png");
    expect(files).toContain("runner-out.txt");
  });

  it("authorType·authorId 는 메시지 작성자 — 러너가 올린 첨부(uploader_id 가 토큰)가 그 에이전트로 걸린다", () => {
    expect(allPages(ownerId, { authorType: "agent", authorId: agentId }).names).toEqual([
      "runner-out.txt",
      "runner-shot.png",
    ]);
    expect(allPages(mia.id, { authorType: "agent" }).names).toEqual([
      "mia-dm-agent.png",
      "runner-out.txt",
      "runner-shot.png",
    ]);
    expect(allPages(ownerId, { authorType: "automation" }).names).toEqual(["auto-report.csv"]);
    expect(allPages(ownerId, { authorId: mia.id }).names).toEqual(["general-reply.txt"]);
  });
});

describe("이름 거름 q", () => {
  const names = (q: string) => allPages(ownerId, { channelId: general, q }).names;

  it("부분 일치, ASCII 대소문자를 가리지 않는다", () => {
    expect(names("runner")).toEqual(["runner-out.txt", "runner-shot.png"]);
    expect(names("REPORT")).toEqual(["report.PDF", "auto-report.csv"]);
    expect(names("g")).toContain("runner-shot.png");
  });

  it("%·_·\\ 는 글자 그대로 — 모든 줄이 걸리지 않는다", () => {
    expect(names("%")).toEqual(["100%.txt"]);
    expect(names("_")).toEqual(["a_b.txt"]);
    expect(names("\\")).toEqual(["c\\d.txt"]);
  });

  it("NFD 검색어(macOS 조합형)가 NFC 로 저장한 이름을 찾는다", () => {
    const nfd = "보고서".normalize("NFD");
    expect(nfd).not.toBe("보고서".normalize("NFC"));
    expect(names(nfd)).toEqual(["보고서.pdf"]);
  });

  it("NUL 이 든 q·0자·100자 초과 → 400 VALIDATION", async () => {
    for (const q of ["a%00b", "%20%20", "a".repeat(101)]) {
      const res = await get(`/api/v1/attachments?q=${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION" });
    }
  });
});

describe("항목 필드", () => {
  it("threadRootId·conversationTitle·seq·channelArchived·url", () => {
    const items = allPages(mia.id).items;
    const by = (name: string) => items.find((i) => i.attachment.name === name) as FileListItem;
    const reply = by("general-reply.txt");
    expect(reply).toMatchObject({
      channelId: general,
      conversationId: generalS1,
      conversationTitle: "첫 세션",
      threadRootId: replyRootId,
      authorType: "user",
      authorId: mia.id,
      channelArchived: false,
    });
    expect(reply.seq).toBeGreaterThanOrEqual(1);
    expect(by("general-root.png").threadRootId).toBeUndefined();
    expect(by("general-root.png").attachment).toMatchObject({
      kind: "image",
      url: `artifact://${by("general-root.png").attachment.id}`,
    });
    expect(by("archived.zip").channelArchived).toBe(true);
    expect(by("auto-report.csv").conversationTitle).toBe("둘째 세션");
  });
});

describe("정렬과 쪽 경계", () => {
  it("Review Focus 1 — 첨부 1개짜리 49개 뒤(더 새로) 첨부 10개짜리 하나: 첫 쪽 50번째가 그 메시지의 첫 첨부, 둘째 쪽이 나머지 9개", () => {
    const ch = createChannel(app.db, { workspaceId: app.workspaceId, createdBy: ownerId, name: "paging" }).id;
    const s = seedConversation(app.db, ch);
    const big = post(
      ch,
      s,
      user(ownerId),
      Array.from({ length: 10 }, (_, i) => ({ name: `big-${i}.txt` })),
    );
    for (let i = 0; i < 49; i++) post(ch, s, user(ownerId), [{ name: `one-${i}.txt` }]);

    const first = listFiles(
      app.db,
      { userId: ownerId, workspaceId: app.workspaceId },
      FileListQuery.parse({ channelId: ch }),
    );
    expect(first.items).toHaveLength(50);
    expect(first.items[49]?.attachment.name).toBe("big-0.txt");
    expect(first.items[49]?.messageId).toBe(big.messageId);
    expect(first.nextCursor).toBeDefined();
    const second = listFiles(
      app.db,
      { userId: ownerId, workspaceId: app.workspaceId },
      FileListQuery.parse({ channelId: ch, cursor: first.nextCursor }),
    );
    expect(second.items.map((i) => i.attachment.name)).toEqual(
      Array.from({ length: 9 }, (_, i) => `big-${i + 1}.txt`),
    );
    expect(second.nextCursor).toBeUndefined();
  });

  it("Review Focus 2 — 첫 쪽 뒤에 새 첨부 글이 와도 둘째 쪽은 첫 쪽과 겹치지 않고, 새 글은 처음부터 받을 때 보인다", () => {
    const ch = createChannel(app.db, { workspaceId: app.workspaceId, createdBy: ownerId, name: "live" }).id;
    const s = seedConversation(app.db, ch);
    for (let i = 0; i < 5; i++) post(ch, s, user(ownerId), [{ name: `old-${i}.txt` }]);
    const viewer = { userId: ownerId, workspaceId: app.workspaceId };
    const first = listFiles(app.db, viewer, FileListQuery.parse({ channelId: ch, limit: 3 }));
    post(ch, s, user(ownerId), [{ name: "new.txt" }]);
    const second = listFiles(
      app.db,
      viewer,
      FileListQuery.parse({ channelId: ch, limit: 3, cursor: first.nextCursor }),
    );
    expect(first.items.map((i) => i.attachment.name)).toEqual(["old-4.txt", "old-3.txt", "old-2.txt"]);
    expect(second.items.map((i) => i.attachment.name)).toEqual(["old-1.txt", "old-0.txt"]);
    expect(
      listFiles(app.db, viewer, FileListQuery.parse({ channelId: ch, limit: 1 })).items[0]?.attachment.name,
    ).toBe("new.txt");
  });

  it("같은 시각 메시지는 id 내림차순으로 이어진다", () => {
    const ch = createChannel(app.db, { workspaceId: app.workspaceId, createdBy: ownerId, name: "tie" }).id;
    const s = seedConversation(app.db, ch);
    const at = (clock += 1000);
    const a = post(ch, s, user(ownerId), [{ name: "t-a.txt" }, { name: "t-b.txt" }], { at });
    const b = post(ch, s, user(ownerId), [{ name: "t-c.txt" }], { at });
    const expected =
      b.messageId > a.messageId ? ["t-c.txt", "t-a.txt", "t-b.txt"] : ["t-a.txt", "t-b.txt", "t-c.txt"];
    expect(allPages(ownerId, { channelId: ch, limit: 1 }).names).toEqual(expected);
  });

  it("깨진 cursor → 400 VALIDATION", async () => {
    const junk = [
      "!!!",
      Buffer.from("not json").toString("base64url"),
      Buffer.from(JSON.stringify({ createdAt: "x", messageId: "y", pos: 0 })).toString("base64url"),
      Buffer.from(JSON.stringify({ createdAt: 1, messageId: "y" })).toString("base64url"),
    ];
    for (const cursor of junk) {
      const res = await get(`/api/v1/attachments?cursor=${encodeURIComponent(cursor)}`);
      expect(res.statusCode, cursor).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION" });
    }
  });
});

describe("시스템 메시지", () => {
  it("kind normal 이 아닌 메시지에 묶인 첨부는 싣지 않는다", () => {
    const ch = createChannel(app.db, { workspaceId: app.workspaceId, createdBy: ownerId, name: "sys" }).id;
    const s = seedConversation(app.db, ch);
    post(ch, s, { type: "agent", id: agentId }, [{ name: "sys.txt" }], { kind: "system" });
    expect(allPages(ownerId, { channelId: ch }).names).toEqual([]);
  });
});

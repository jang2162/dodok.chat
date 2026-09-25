import {
  type Attachment,
  SEARCH_SNIPPET_CLOSE,
  SEARCH_SNIPPET_OPEN,
  SearchQuery,
  SearchResult,
} from "@dodok/shared";
import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v7 as uuid } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import * as authSchema from "../src/db/auth-schema";
import * as schema from "../src/db/schema.sqlite";
import { messages } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { createAgentMessage, createSystemMessage, createUserMessage } from "../src/modules/messages/service";
import { searchMessages } from "../src/modules/search/service";
import { ServerBus } from "../src/realtime/bus";
import { migrationsFolder } from "../src/runtime";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

const NOW = new Date("2026-09-25T12:00:00+09:00");
const DAY = 86_400_000;

function setup() {
  const db = newTestDb();
  const bus = new ServerBus();
  const { workspaceId, userId } = seedWorkspace(db, { userHandle: "jang" });
  const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
  const other = createChannel(db, { workspaceId, createdBy: userId, name: "random" });
  const dev = createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev", name: "Dev" });
  addMember(db, channel.id, { memberType: "agent", memberId: dev.id }, { warn: () => {} });
  let n = 0;
  const say = (bodyMd: string, opts: { channelId?: string; at?: Date } = {}) => {
    const m = createUserMessage(db, bus, {
      channelId: opts.channelId ?? channel.id,
      authorId: userId,
      bodyMd,
      clientMsgId: `c${n++}`,
    });
    if (opts.at) at(db, m.id, opts.at);
    return m;
  };
  const agentSays = (bodyMd: string, opts: { at?: Date } = {}) => {
    const m = createAgentMessage(db, bus, {
      channelId: channel.id,
      agentId: dev.id,
      externalId: `e${n++}`,
      bodyMd,
    });
    if (opts.at) at(db, m.id, opts.at);
    return m;
  };
  const search = (q: string, rest: Record<string, string> = {}) =>
    SearchResult.parse(searchMessages(db, workspaceId, userId, SearchQuery.parse({ q, ...rest }), NOW));
  return {
    db,
    bus,
    workspaceId,
    userId,
    channelId: channel.id,
    otherId: other.id,
    devId: dev.id,
    say,
    agentSays,
    search,
  };
}

function at(db: Db, id: string, createdAt: Date) {
  db.update(messages).set({ createdAt }).where(eq(messages.id, id)).run();
}

const ids = (r: SearchResult) => r.hits.map((h) => h.messageId);
const ftsCount = (db: Db) => db.get<{ n: number }>(sql`SELECT count(*) AS n FROM messages_fts`)?.n;

describe("색인 트리거 (스펙 5.1)", () => {
  it("삽입하면 찾히고, 본문을 고치면 옛 말은 안 찾히고 새 말이 찾히고, 지우면 안 찾힌다", () => {
    const t = setup();
    const m = t.say("오늘 배포를 마쳤다");
    expect(ids(t.search("배포를"))).toEqual([m.id]);
    t.db.update(messages).set({ bodyMd: "내일 회고를 한다" }).where(eq(messages.id, m.id)).run();
    expect(ids(t.search("배포를"))).toEqual([]);
    expect(ids(t.search("회고를"))).toEqual([m.id]);
    t.db.delete(messages).where(eq(messages.id, m.id)).run();
    expect(ids(t.search("회고를"))).toEqual([]);
  });

  it("맨 끝 메시지를 지우고 새 메시지를 넣어도(rowid 재사용) 지운 말로 새 메시지가 찾히지 않는다", () => {
    const t = setup();
    const gone = t.say("지워질유령단어 메시지");
    const rowidOf = (id: string) =>
      t.db.get<{ r: number }>(sql`SELECT rowid AS r FROM messages WHERE id = ${id}`)?.r;
    const oldRowid = rowidOf(gone.id);
    t.db.delete(messages).where(eq(messages.id, gone.id)).run();
    const next = t.say("전혀 다른 본문");
    // text PK 라 rowid 는 별명이 아니다 — 맨 끝 행을 지우면 다음 INSERT 가 같은 rowid 를 다시 쓴다
    expect(rowidOf(next.id)).toBe(oldRowid);
    expect(ids(t.search("지워질유령단어"))).toEqual([]);
    expect(ids(t.search("다른 본문"))).toEqual([next.id]);
  });

  it("kind 를 normal → system → normal 로 바꾸면 안 찾혔다가 다시 찾힌다", () => {
    const t = setup();
    const m = t.say("종류전환 메시지");
    const setKind = (kind: string) =>
      t.db.run(sql`UPDATE messages SET kind = ${kind}, author_type = ${kind === "system" ? "system" : "user"}
        WHERE id = ${m.id}`);
    setKind("system");
    expect(ids(t.search("종류전환"))).toEqual([]);
    expect(ftsCount(t.db)).toBe(0);
    setKind("normal");
    expect(ids(t.search("종류전환"))).toEqual([m.id]);
    expect(ftsCount(t.db)).toBe(1);
  });

  it("색인 행 수는 normal 메시지 수와 같다 — 시스템 메시지와 그 본문 수정은 색인에 들지 않는다", () => {
    const t = setup();
    t.say("사람 메시지 하나");
    t.agentSays("에이전트 메시지 하나");
    const sys = createSystemMessage(t.db, t.bus, {
      channelId: t.channelId,
      kind: "info",
      bodyMd: "시스템 공지",
    });
    createSystemMessage(t.db, t.bus, { channelId: t.channelId, kind: "info", bodyMd: "또 공지" });
    t.db.update(messages).set({ bodyMd: "고친 시스템 공지" }).where(eq(messages.id, sys.id)).run();
    const normal = t.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM messages WHERE kind = 'normal'`)?.n;
    expect(normal).toBe(2);
    expect(ftsCount(t.db)).toBe(normal);
  });

  it("본문·첨부가 그대로인 UPDATE(components 상태 등)는 색인을 흔들지 않는다", () => {
    const t = setup();
    const m = t.say("상태만 바뀌는 메시지");
    t.db
      .update(messages)
      .set({ componentState: { disabled: true } as never })
      .where(eq(messages.id, m.id))
      .run();
    expect(ids(t.search("바뀌는"))).toEqual([m.id]);
  });

  it("시스템 메시지는 찾지 않는다", () => {
    const t = setup();
    createSystemMessage(t.db, t.bus, {
      channelId: t.channelId,
      kind: "info",
      bodyMd: "시스템 공지 배포를 알림",
    });
    expect(ids(t.search("배포를"))).toEqual([]);
  });

  it("첨부 이름으로 찾힌다", () => {
    const t = setup();
    const m = t.say("파일 올림");
    const a: Attachment = {
      id: uuid(),
      kind: "file",
      url: `artifact://${uuid()}`,
      name: "분기보고서_최종.pdf",
      mime: "application/pdf",
      size: 10,
    };
    t.db
      .update(messages)
      .set({ attachments: [a] })
      .where(eq(messages.id, m.id))
      .run();
    expect(ids(t.search("분기보고서"))).toEqual([m.id]);
  });
});

describe("3글자 이상 — MATCH", () => {
  it("조사가 붙은 한국어: 「배포를 마쳤다」 에서 배포를·마쳤다가 찾힌다", () => {
    const t = setup();
    const m = t.say("배포를 마쳤다");
    t.say("관계없는 말");
    expect(ids(t.search("배포를"))).toEqual([m.id]);
    expect(ids(t.search("마쳤다"))).toEqual([m.id]);
    const r = t.search("배포를");
    expect(r.limited).toBe(false);
  });

  it("대소문자를 가리지 않는다", () => {
    const t = setup();
    const m = t.say("Deploy Finished");
    expect(ids(t.search("deploy"))).toEqual([m.id]);
  });

  it.each([
    '"x"y',
    "100%_",
    "a*b*",
    "foo OR bar",
    "NEAR(ab",
    "body:abc",
    "a\\b_c",
    "'; DROP",
    "ab)(",
    "^abc",
    "-abc",
    "\ud800ab",
  ])("연산자·특수 문자 %s 는 글자 그대로 찾고 던지지 않는다", (q) => {
    const t = setup();
    const hit = t.say(`앞 ${q} 뒤`);
    t.say("관계없는 말 foo bar abc 100");
    expect(ids(t.search(q))).toEqual([hit.id]);
  });

  it.each(["a\u0000bc", "\u0000\u0000"])("NUL 이 든 검색어 %j 는 500 이 아니라 400 VALIDATION", (q) => {
    const t = setup();
    t.say("abc");
    expect(() => t.search(q)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("에이전트·사람·채널·기간 필터", () => {
    const t = setup();
    const u = t.say("공통검색어 사람", { at: new Date(NOW.getTime() - 3 * DAY) });
    const a = t.agentSays("공통검색어 에이전트", { at: new Date(NOW.getTime() - DAY) });
    const o = t.say("공통검색어 다른 채널", { channelId: t.otherId, at: NOW });
    expect(new Set(ids(t.search("공통검색어")))).toEqual(new Set([u.id, a.id, o.id]));
    expect(ids(t.search("공통검색어", { authorType: "agent" }))).toEqual([a.id]);
    expect(ids(t.search("공통검색어", { authorId: t.devId }))).toEqual([a.id]);
    expect(new Set(ids(t.search("공통검색어", { authorType: "user" })))).toEqual(new Set([u.id, o.id]));
    expect(ids(t.search("공통검색어", { channelId: t.otherId }))).toEqual([o.id]);
    const localDate = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayOf = (msAgo: number) => localDate(new Date(NOW.getTime() - msAgo));
    // from·to 는 서버 현지 날짜 — to 는 그날 끝까지 든다
    expect(ids(t.search("공통검색어", { from: dayOf(DAY), to: dayOf(DAY) }))).toEqual([a.id]);
    expect(new Set(ids(t.search("공통검색어", { from: dayOf(DAY) })))).toEqual(new Set([a.id, o.id]));
    expect(ids(t.search("공통검색어", { to: dayOf(2 * DAY) }))).toEqual([u.id]);
  });

  it("다른 워크스페이스의 메시지는 나오지 않는다", () => {
    const t = setup();
    const mine = t.say("워크스페이스경계");
    const w2 = seedWorkspace(t.db, { userHandle: "other" });
    const ch2 = createChannel(t.db, { workspaceId: w2.workspaceId, createdBy: w2.userId, name: "x" });
    createUserMessage(t.db, t.bus, {
      channelId: ch2.id,
      authorId: w2.userId,
      bodyMd: "워크스페이스경계",
      clientMsgId: "z",
    });
    expect(ids(t.search("워크스페이스경계"))).toEqual([mine.id]);
  });

  it("한 페이지 20개, 커서로 다음 페이지 — 겹침·빠짐 없음", () => {
    const t = setup();
    const all = new Set<string>();
    for (let i = 0; i < 27; i++)
      all.add(
        t.say(`페이지검색 ${"반복 ".repeat(i % 4)}${i}`, { at: new Date(NOW.getTime() - i * 1000) }).id,
      );
    const p1 = t.search("페이지검색");
    expect(p1.hits).toHaveLength(20);
    expect(p1.nextCursor).toBeTypeOf("string");
    const p2 = t.search("페이지검색", { cursor: p1.nextCursor as string });
    expect(p2.hits).toHaveLength(7);
    expect(p2.nextCursor).toBeUndefined();
    const got = [...ids(p1), ...ids(p2)];
    expect(new Set(got).size).toBe(27);
    expect(new Set(got)).toEqual(all);
  });

  it("망가진 커서는 400 VALIDATION", () => {
    const t = setup();
    t.say("커서검사");
    for (const cursor of [
      "!!!",
      Buffer.from("{}").toString("base64url"),
      Buffer.from("[1]").toString("base64url"),
    ])
      expect(() => t.search("커서검사", { cursor })).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("2글자 — LIKE", () => {
  it("LIKE 경로 — limited: true, 90일 밖은 안 찾힌다, 시스템 메시지 제외", () => {
    const t = setup();
    const inside = t.say("배포 완료", { at: new Date(NOW.getTime() - 89 * DAY) });
    t.say("배포 옛날", { at: new Date(NOW.getTime() - 91 * DAY) });
    createSystemMessage(t.db, t.bus, { channelId: t.channelId, kind: "info", bodyMd: "배포 공지" });
    const r = t.search("배포");
    expect(r.limited).toBe(true);
    expect(ids(r)).toEqual([inside.id]);
    expect(r.nextCursor).toBeUndefined();
  });

  it("최신순 최대 50개", () => {
    const t = setup();
    const made: string[] = [];
    for (let i = 0; i < 55; i++) made.push(t.say(`배포 ${i}`, { at: new Date(NOW.getTime() - i * 1000) }).id);
    const r = t.search("배포");
    expect(ids(r)).toEqual(made.slice(0, 50));
  });

  it.each(["%%", "__", "\\\\", "%_", '""', "a%"])("%s 는 글자 그대로(LIKE 와일드카드 아님)", (q) => {
    const t = setup();
    const hit = t.say(`x${q}y`);
    t.say("아무 글자나 있는 메시지 abc");
    expect(ids(t.search(q))).toEqual([hit.id]);
  });

  it("이모지 둘은 2글자 경로", () => {
    const t = setup();
    const m = t.say("축하 😀🎉 합니다");
    const r = t.search("😀🎉");
    expect(r.limited).toBe(true);
    expect(ids(r)).toEqual([m.id]);
  });
});

describe("스니펫", () => {
  const O = SEARCH_SNIPPET_OPEN;
  const C = SEARCH_SNIPPET_CLOSE;

  it("일치 부분을 표시 문자로 감싸고 앞뒤 64자만 남긴다", () => {
    const t = setup();
    const before = "가".repeat(100);
    const after = "나".repeat(100);
    t.say(`${before}목표어${after}`);
    const [hit] = t.search("목표어").hits;
    expect(hit?.snippet).toBe(`…${"가".repeat(64)}${O}목표어${C}${"나".repeat(64)}…`);
  });

  it("짧은 본문은 자르지 않는다, 대소문자가 달라도 본문 글자 그대로 감싼다", () => {
    const t = setup();
    t.say("the Deploy is done");
    expect(t.search("deploy").hits[0]?.snippet).toBe(`the ${O}Deploy${C} is done`);
  });

  it("본문에 이미 든 표시 문자는 걷는다", () => {
    const t = setup();
    t.say(`가짜${O}강조${C} 진짜검색어`);
    expect(t.search("진짜검색어").hits[0]?.snippet).toBe(`가짜강조 ${O}진짜검색어${C}`);
  });

  it("줄바꿈·연속 공백은 공백 하나로", () => {
    const t = setup();
    t.say("첫 줄\n\n둘째   줄 검색어다");
    expect(t.search("검색어").hits[0]?.snippet).toBe(`첫 줄 둘째 줄 ${O}검색어${C}다`);
  });

  it("본문에 없고 첨부 이름으로 찾힌 결과는 첨부 이름에서 자른다", () => {
    const t = setup();
    const m = t.say("");
    const a: Attachment = {
      id: uuid(),
      kind: "file",
      url: `artifact://${uuid()}`,
      name: "회의록.pdf",
      mime: "application/pdf",
      size: 1,
    };
    t.db
      .update(messages)
      .set({ attachments: [a] })
      .where(eq(messages.id, m.id))
      .run();
    expect(t.search("회의록").hits[0]?.snippet).toBe(`${O}회의록${C}.pdf`);
  });

  it("아스트랄 문자 200자 검색어도 앞뒤 64자를 다 싣고 스키마(코드 포인트 400) 안이다", () => {
    const t = setup();
    t.say(`${"😀".repeat(100)}${"🎉".repeat(200)}${"😀".repeat(100)}`);
    const snippet = t.search("🎉".repeat(200)).hits[0]?.snippet; // setup 의 search 가 SearchResult 로 파싱한다
    expect(snippet).toBe(`…${"😀".repeat(64)}${O}${"🎉".repeat(200)}${C}${"😀".repeat(64)}…`);
  });
});

describe("결과 모양", () => {
  it("messageId·channelId·seq·authorType·authorId·createdAt", () => {
    const t = setup();
    t.say("앞 메시지");
    const m = t.agentSays("모양검사 본문");
    const [hit] = t.search("모양검사").hits;
    expect(hit).toEqual({
      messageId: m.id,
      channelId: t.channelId,
      seq: m.seq,
      authorType: "agent",
      authorId: t.devId,
      createdAt: m.createdAt,
      snippet: `${SEARCH_SNIPPET_OPEN}모양검사${SEARCH_SNIPPET_CLOSE} 본문`,
    });
  });

  it("스레드 답글 결과에는 루트 id(threadRootId), 루트·일반 메시지에는 없다", () => {
    const t = setup();
    const root = t.say("스레드루트 본문");
    const reply = createUserMessage(t.db, t.bus, {
      channelId: t.channelId,
      authorId: t.userId,
      bodyMd: "스레드답글 본문",
      clientMsgId: "reply",
      threadRootId: root.id,
    });
    expect(t.search("스레드답글").hits).toEqual([
      expect.objectContaining({ messageId: reply.id, seq: reply.seq, threadRootId: root.id }),
    ]);
    const [rootHit] = t.search("스레드루트").hits;
    expect(rootHit?.messageId).toBe(root.id);
    expect(rootHit).not.toHaveProperty("threadRootId");
    // 2글자(LIKE) 경로도 같은 변환을 지난다
    expect(t.search("답글").hits).toEqual([
      expect.objectContaining({ messageId: reply.id, seq: reply.seq, threadRootId: root.id }),
    ]);
  });
});

describe("마이그레이션 — 기존 DB 에 색인을 채운다", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("직전 마이그레이션까지 적용된 DB 의 normal 메시지를 백필한다(시스템 제외) — rowid 구멍·뒤 마이그레이션에도 트리거·행이 맞다", () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-search-mig-"));
    const src = migrationsFolder();
    const journal = JSON.parse(readFileSync(join(src, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const idx = journal.entries.findIndex((e) => e.tag.endsWith("_search_fts"));
    expect(idx).toBeGreaterThan(0);
    const older = join(dir, "older");
    mkdirSync(join(older, "meta"), { recursive: true });
    writeFileSync(
      join(older, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, idx) }),
    );
    for (const e of journal.entries.slice(0, idx))
      copyFileSync(join(src, `${e.tag}.sql`), join(older, `${e.tag}.sql`));

    const sqlite = new Database(join(dir, "app.db"));
    try {
      const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
      migrate(db, { migrationsFolder: older });
      const { workspaceId, userId } = seedWorkspace(db as unknown as Db);
      const ch = createChannel(db as unknown as Db, { workspaceId, createdBy: userId, name: "g" });
      let seq = 0;
      const insert = (id: string, kind: string, body: string, attachmentsJson = "[]") =>
        db.run(sql`INSERT INTO messages (id, channel_id, seq, kind, author_type, author_id, body_md, mentions_json,
          attachments_json, created_at) VALUES (${id}, ${ch.id}, ${++seq}, ${kind},
          ${kind === "system" ? "system" : "user"}, ${kind === "system" ? null : userId}, ${body},
          '{"agents":[],"users":[]}', ${attachmentsJson}, ${NOW.getTime()})`);
      const normal = uuid();
      const holed = uuid();
      const afterHole = uuid();
      const withFile = uuid();
      insert(normal, "normal", "예전에 쓴 백필대상 메시지 첫행고유");
      insert(holed, "normal", "가운데 지울 행 구멍고유");
      insert(afterHole, "normal", "구멍 뒤 행 뒤행고유");
      insert(uuid(), "system", "예전 시스템 백필대상");
      insert(withFile, "normal", "", JSON.stringify([{ name: "옛첨부파일.png" }, { name: "둘째.txt" }]));
      // 가운데 normal 행을 지워 rowid 에 구멍을 낸다 — messages 를 다시 만드는 마이그레이션이 rowid 를 새로 매기면
      // 구멍 뒤 행들이 엉뚱한 메시지를 가리킨다
      db.run(sql`DELETE FROM messages WHERE id = ${holed}`);

      migrate(db, { migrationsFolder: src });
      // 모든 마이그레이션 뒤에도 트리거 셋이 messages 에 걸려 있다 — 뒤 마이그레이션이 messages 를 다시 만들며
      // 트리거·백필을 다시 넣지 않으면 여기서 깨진다
      const triggers = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'messages' ORDER BY name",
        )
        .all()
        .map((r) => (r as { name: string }).name);
      expect(triggers).toEqual(
        expect.arrayContaining(["messages_fts_ad", "messages_fts_ai", "messages_fts_au"]),
      );
      const found = (q: string) =>
        searchMessages(db as unknown as Db, workspaceId, userId, SearchQuery.parse({ q }), NOW).hits.map(
          (h) => h.messageId,
        );
      expect(found("백필대상")).toEqual([normal]);
      expect(found("첫행고유")).toEqual([normal]);
      expect(found("구멍고유")).toEqual([]);
      expect(found("뒤행고유")).toEqual([afterHole]);
      expect(found("옛첨부파일")).toEqual([withFile]);
      expect(found("둘째.txt")).toEqual([withFile]);
      const fresh = uuid();
      insert(fresh, "normal", "마이그레이션 뒤 새행고유");
      expect(found("새행고유")).toEqual([fresh]);
    } finally {
      sqlite.close();
    }
  });
});

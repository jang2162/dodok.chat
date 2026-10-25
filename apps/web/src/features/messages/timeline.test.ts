import { Message } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import {
  addPending,
  appendNewer,
  applyToTimeline,
  emptyTimeline,
  fromLatest,
  hasChannelGap,
  inThread,
  jumpAround,
  noteSeq,
  type PendingMessage,
  prependOlder,
  refreshRoots,
  removePending,
  setPendingState,
  threadAround,
  threadFromPage,
  upsert,
  upsertMany,
} from "./timeline";

const CH = "01a00000-0000-7000-8000-000000000001";
const USER = "01a00000-0000-7000-8000-0000000000aa";
/** 픽스처는 shared `Message` 스키마를 통과시켜 계약과 맞춘다 */
const msg = (seq: number, over: Partial<Message> = {}): Message =>
  Message.parse({
    id: `01a00000-0000-7000-8000-${String(1000 + seq).padStart(12, "0")}`,
    channelId: CH,
    conversationId: over.channelId ?? CH,
    seq,
    kind: "normal",
    authorType: "user",
    authorId: USER,
    bodyMd: `m${seq}`,
    mentions: { users: [], agents: [] },
    attachments: [],
    createdAt: new Date(1_800_000_000_000 + seq * 1000).toISOString(),
    ...over,
  });
const pending = (clientMsgId: string): PendingMessage => ({
  clientMsgId,
  channelId: CH,
  bodyMd: "p",
  createdAt: new Date().toISOString(),
  state: "sending",
});

describe("timeline", () => {
  it("fromLatest: seq 순으로 정렬하고 lastSeq·hasOlder 를 채운다", () => {
    const t = fromLatest(undefined, [msg(3), msg(1), msg(2)], true);
    expect(t.items.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(t).toMatchObject({ hasOlder: true, lastSeq: 3, pending: [] });
  });
  it("prependOlder: 과거 페이지를 앞에 붙이고 중복은 하나로", () => {
    const t = prependOlder(fromLatest(undefined, [msg(3), msg(4)], true), [msg(1), msg(2), msg(3)], false);
    expect(t.items.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(t.hasOlder).toBe(false);
    expect(t.lastSeq).toBe(4);
  });
  it("upsert: 같은 id 는 교체, 새 것은 seq 자리에, lastSeq 는 커진다", () => {
    let t = fromLatest(undefined, [msg(1), msg(2)], false);
    t = upsert(t, msg(2, { bodyMd: "edited" }));
    t = upsert(t, msg(3));
    expect(t.items.map((m) => [m.seq, m.bodyMd])).toEqual([
      [1, "m1"],
      [2, "edited"],
      [3, "m3"],
    ]);
    expect(t.lastSeq).toBe(3);
  });
  it("확정 메시지의 clientMsgId 가 같은 보내는 중 항목을 지운다", () => {
    let t = addPending(fromLatest(undefined, [msg(1)], false), pending("c1"));
    t = addPending(t, pending("c2"));
    t = upsertMany(t, [msg(2, { clientMsgId: "c1" })]);
    expect(t.pending.map((p) => p.clientMsgId)).toEqual(["c2"]);
  });
  it("setPendingState·removePending", () => {
    let t = addPending(emptyTimeline(), pending("c1"));
    t = setPendingState(t, "c1", "failed");
    expect(t.pending[0]?.state).toBe("failed");
    expect(removePending(t, "c1").pending).toEqual([]);
  });
  it("addPending 은 같은 clientMsgId 를 새로 넣지 않고 바꾼다(다시 보내기)", () => {
    const t = addPending(
      setPendingState(addPending(emptyTimeline(), pending("c1")), "c1", "failed"),
      pending("c1"),
    );
    expect(t.pending).toHaveLength(1);
    expect(t.pending[0]?.state).toBe("sending");
  });
  it("hasChannelGap: 채널 커서 + 1 보다 큰 seq 면 빈틈 — 빈 채널(커서 0)의 첫 글은 seq 1(채널 세션 계획 판정 PS6)", () => {
    expect(hasChannelGap(2, msg(3))).toBe(false);
    expect(hasChannelGap(2, msg(5))).toBe(true);
    expect(hasChannelGap(2, msg(1, { bodyMd: "x" }))).toBe(false);
    expect(hasChannelGap(0, msg(1))).toBe(false);
    expect(hasChannelGap(0, msg(9))).toBe(true);
  });
  it("fromLatest 는 보내는 중 항목을 유지하되 확정된 것은 지운다", () => {
    const prev = addPending(addPending(emptyTimeline(), pending("c1")), pending("c2"));
    expect(
      fromLatest(prev, [msg(1, { clientMsgId: "c2" })], false).pending.map((p) => p.clientMsgId),
    ).toEqual(["c1"]);
  });
});

describe("루트만 드는 채널 타임라인(스레드·검색 스펙 4.1)", () => {
  const ROOT = msg(1).id;
  const reply = (seq: number, over: Partial<Message> = {}) => msg(seq, { threadRootId: ROOT, ...over });

  it("noteSeq: 답글의 seq 는 목록에 넣지 않고 lastSeq 만 올린다 — 옛 seq 는 그대로", () => {
    const t = fromLatest(undefined, [msg(1), msg(2)], false);
    const noted = noteSeq(t, 4);
    expect(noted.items.map((m) => m.seq)).toEqual([1, 2]);
    expect(noted.lastSeq).toBe(4);
    expect(noteSeq(noted, 3)).toBe(noted);
  });

  it("applyToTimeline: 루트는 병합하고 답글은 seq 만 — 재동기화 응답(scope all)", () => {
    const t = fromLatest(undefined, [msg(1), msg(2)], false);
    const next = applyToTimeline(t, [reply(3), msg(4), reply(5)]);
    expect(next.items.map((m) => m.seq)).toEqual([1, 2, 4]);
    expect(next.lastSeq).toBe(5);
  });

  it("refreshRoots: 이미 가진 루트만 요약을 갈아 끼우고, 없는 루트(적재 범위 밖)는 넣지 않는다", () => {
    const t = fromLatest(undefined, [msg(2), msg(3)], true);
    const summary = { count: 2, lastAt: msg(9).createdAt, agentIds: [] };
    const next = refreshRoots(t, [msg(2, { threadSummary: summary }), msg(1, { threadSummary: summary })]);
    expect(next.items.map((m) => m.seq)).toEqual([2, 3]);
    expect(next.items[0]?.threadSummary).toEqual(summary);
    expect(next.lastSeq).toBe(t.lastSeq);
  });

  it("threadFromPage: 루트를 늘 맨 앞에 두고(페이지가 닿지 않아도) 답글을 seq 순으로", () => {
    const t = threadFromPage(undefined, msg(1), [reply(7), reply(5)], true);
    expect(t.items.map((m) => m.seq)).toEqual([1, 5, 7]);
    expect(t.hasOlder).toBe(true);
    // 페이지가 루트까지 닿으면 둘이 아니라 하나
    expect(threadFromPage(undefined, msg(1), [msg(1), reply(2)], false).items.map((m) => m.seq)).toEqual([
      1, 2,
    ]);
  });

  it("inThread: 그 스레드의 루트·답글만 고른다", () => {
    const other = msg(9).id;
    const picked = inThread(ROOT, [msg(1), reply(2), msg(3), reply(4, { threadRootId: other })]);
    expect(picked.map((m) => m.seq)).toEqual([1, 2]);
  });
});

describe("결과로 가기 — around 페이지로 갈아 끼우기(떨어진 창)", () => {
  // 채널은 루트만 든다 — seq 가 띄엄띄엄이다(사이는 답글). 지금 가진 것은 최신 쪽 루트 40·44, 채널의 끝은 46
  const live = () => ({ ...emptyTimeline(), items: [msg(40), msg(44)], hasOlder: true, lastSeq: 46 });
  const page = (seqs: number[], hasMore: boolean, hasMoreAfter: boolean) => ({
    messages: seqs.map((s) => msg(s)),
    hasMore,
    hasMoreAfter,
  });

  it("더 새것이 있으면 그 페이지만 두고 hasNewer — lastSeq 는 내려가지 않는다(거짓 빈틈 없음)", () => {
    const t = jumpAround(live(), page([5, 9, 12], true, true));
    expect(t.items.map((m) => m.seq)).toEqual([5, 9, 12]);
    expect(t.hasOlder).toBe(true);
    expect(t.hasNewer).toBe(true);
    expect(t.lastSeq).toBe(46);
  });

  it("페이지가 끝까지 닿으면 hasNewer 없이, 그 사이 새로 온 것(페이지보다 새것)은 남긴다", () => {
    const prev = { ...live(), items: [msg(40), msg(44), msg(50)], lastSeq: 50 };
    const t = jumpAround(prev, page([30, 36, 40, 44], false, false));
    expect(t.items.map((m) => m.seq)).toEqual([30, 36, 40, 44, 50]);
    expect(t.hasNewer).toBe(false);
    expect(t.hasOlder).toBe(false);
    expect(t.lastSeq).toBe(50);
  });

  it("보내는 중 항목은 그대로", () => {
    const prev = addPending(live(), pending("c1"));
    expect(jumpAround(prev, page([5], false, true)).pending).toEqual(prev.pending);
  });

  it("떨어진 창에는 창보다 새 메시지를 넣지 않는다 — lastSeq 만 올리고 확정된 보내는 중 항목은 뺀다", () => {
    const t = addPending(jumpAround(live(), page([5, 9], true, true)), pending("c1"));
    const next = upsertMany(t, [msg(47, { clientMsgId: "c1" }), { ...msg(9), bodyMd: "고침" }]);
    expect(next.items.map((m) => m.seq)).toEqual([5, 9]);
    expect(next.items[1]?.bodyMd).toBe("고침");
    expect(next.lastSeq).toBe(47);
    expect(next.pending).toEqual([]);
    // 재동기화 응답도 같은 길(applyToTimeline → upsertMany)
    expect(applyToTimeline(t, [msg(48)]).items.map((m) => m.seq)).toEqual([5, 9]);
  });

  it("아래로 이어 받기(appendNewer) 는 창을 넓히고, 끝에 닿으면 hasNewer 를 끈다", () => {
    const t = jumpAround(live(), page([5, 9], true, true));
    const more = appendNewer(t, [msg(12), msg(15)], true);
    expect(more.items.map((m) => m.seq)).toEqual([5, 9, 12, 15]);
    expect(more.hasNewer).toBe(true);
    const done = appendNewer(more, [msg(40), msg(44)], false);
    expect(done.hasNewer).toBe(false);
    expect(done.lastSeq).toBe(46);
    // 이제 새 메시지는 끝에 붙는다
    expect(upsert(done, msg(47)).items.at(-1)?.seq).toBe(47);
  });

  it("최신 페이지로 새로 시작하면(fromLatest) 떨어진 창이 아니다", () => {
    const t = jumpAround(live(), page([5], true, true));
    expect(fromLatest(t, [msg(44)], true).hasNewer).toBeUndefined();
  });

  it("스레드 — 루트는 늘 맨 앞, 페이지가 루트를 담아도 한 번만", () => {
    const root = msg(1);
    const r = (seq: number) => msg(seq, { threadRootId: root.id });
    const prev = threadFromPage(undefined, root, [r(80), r(90)], true);
    const t = threadAround(prev, root, { messages: [r(20), r(30)], hasMore: true, hasMoreAfter: true });
    expect(t.items.map((m) => m.seq)).toEqual([1, 20, 30]);
    expect(t.hasNewer).toBe(true);
    const all = threadAround(prev, root, {
      messages: [root, r(20), r(30)],
      hasMore: false,
      hasMoreAfter: true,
    });
    expect(all.items.map((m) => m.seq)).toEqual([1, 20, 30]);
    expect(all.hasOlder).toBe(false);
  });
});

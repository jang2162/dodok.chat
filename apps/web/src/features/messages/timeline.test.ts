import { Message } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import {
  addPending,
  applyToChannel,
  emptyTimeline,
  fromLatest,
  hasGap,
  inThread,
  noteSeq,
  type PendingMessage,
  prependOlder,
  refreshRoots,
  removePending,
  setPendingState,
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
  it("hasGap: lastSeq+1 보다 큰 새 seq 면 빈틈, 처음(0)·이미 있는 것·옛 seq 수정은 아니다", () => {
    const t = fromLatest(undefined, [msg(1), msg(2)], false);
    expect(hasGap(t, msg(3))).toBe(false);
    expect(hasGap(t, msg(5))).toBe(true);
    expect(hasGap(t, msg(1, { bodyMd: "x" }))).toBe(false);
    expect(hasGap(emptyTimeline(), msg(9))).toBe(false);
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

  it("답글 seq 를 기록한 뒤에는 그 다음 루트가 빈틈이 아니다(답글이 채널 seq 를 같이 쓴다)", () => {
    const t = fromLatest(undefined, [msg(1), msg(2)], false);
    // 기록하지 않으면 루트 5 는 3·4(답글) 때문에 빈틈으로 보인다
    expect(hasGap(t, msg(5))).toBe(true);
    const noted = noteSeq(noteSeq(t, 3), 4);
    expect(hasGap(noted, msg(5))).toBe(false);
  });

  it("applyToChannel: 루트는 병합하고 답글은 seq 만 — 재동기화 응답(scope all)", () => {
    const t = fromLatest(undefined, [msg(1), msg(2)], false);
    const next = applyToChannel(t, [reply(3), msg(4), reply(5)]);
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

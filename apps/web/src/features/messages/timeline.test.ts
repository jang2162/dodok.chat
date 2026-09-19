import { Message } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import {
  addPending,
  emptyTimeline,
  fromLatest,
  hasGap,
  type PendingMessage,
  prependOlder,
  removePending,
  setPendingState,
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

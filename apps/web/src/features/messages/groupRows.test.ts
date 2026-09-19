import { describe, expect, it } from "vitest";
import { AGENT, msg, RUN, RUN2, USER } from "../../../test/fixtures";
import { groupRows, type Row } from "./groupRows";
import { emptyTimeline, type PendingMessage, type Timeline } from "./timeline";

const TZ = "Asia/Seoul";
const at = (iso: string) => ({ createdAt: new Date(iso).toISOString() });
const timeline = (over: Partial<Timeline>): Timeline => ({ ...emptyTimeline(), ...over });
const heads = (rows: Row[]) => rows.flatMap((r) => (r.kind === "message" ? [r.head] : []));
const kinds = (rows: Row[]) => rows.map((r) => r.kind);
const pending = (clientMsgId: string): PendingMessage => ({
  clientMsgId,
  channelId: "c",
  bodyMd: "보내는 중",
  createdAt: "2027-01-15T08:10:00.000Z",
  state: "sending",
});

describe("groupRows", () => {
  it("같은 사람이 2분 간격으로 두 번 → 머리는 첫 것만", () => {
    const items = [msg(1, at("2027-01-15T08:00:00Z")), msg(2, at("2027-01-15T08:02:00Z"))];
    expect(heads(groupRows(timeline({ items }), [], TZ))).toEqual([true, false]);
  });

  it("6분 간격이면 둘 다 머리", () => {
    const items = [msg(1, at("2027-01-15T08:00:00Z")), msg(2, at("2027-01-15T08:06:00Z"))];
    expect(heads(groupRows(timeline({ items }), [], TZ))).toEqual([true, true]);
  });

  it("작성자가 바뀌면 머리", () => {
    const items = [
      msg(1, at("2027-01-15T08:00:00Z")),
      msg(2, { ...at("2027-01-15T08:01:00Z"), authorType: "agent", authorId: AGENT }),
      msg(3, { ...at("2027-01-15T08:01:30Z"), authorType: "agent", authorId: AGENT }),
      msg(4, at("2027-01-15T08:02:00Z")),
    ];
    expect(heads(groupRows(timeline({ items }), [], TZ))).toEqual([true, true, false, true]);
  });

  it("시스템 메시지는 늘 머리이고 다음 사람 메시지도 머리", () => {
    const system = {
      kind: "system" as const,
      authorType: "system" as const,
      authorId: undefined,
      systemMeta: { kind: "info" as const },
    };
    const items = [
      msg(1, at("2027-01-15T08:00:00Z")),
      msg(2, { ...at("2027-01-15T08:00:10Z"), ...system }),
      msg(3, { ...at("2027-01-15T08:00:20Z"), ...system }),
      msg(4, at("2027-01-15T08:00:30Z")),
    ];
    expect(heads(groupRows(timeline({ items }), [], TZ))).toEqual([true, true, true, true]);
  });

  it("날짜가 바뀌면 구분선 — 날짜는 주어진 시간대로 가른다", () => {
    // UTC 로는 같은 날, 서울로는 1월 15일 23:59 → 16일 00:01. 같은 사람 2분 간격이어도 새 날의 첫 메시지는 머리
    const items = [msg(1, at("2027-01-15T14:59:00Z")), msg(2, at("2027-01-15T15:01:00Z"))];
    const rows = groupRows(timeline({ items }), [], TZ);
    expect(rows.map((r) => r.key)).toEqual([
      "date:2027-01-15",
      `msg:${items[0]?.id}`,
      "date:2027-01-16",
      `msg:${items[1]?.id}`,
    ]);
    expect(rows[2]).toEqual({ kind: "divider", key: "date:2027-01-16", date: "2027-01-16" });
    expect(heads(rows)).toEqual([true, true]);
    expect(kinds(groupRows(timeline({ items }), [], "UTC"))).toEqual(["divider", "message", "message"]);
  });

  it("더 옛 메시지가 남아 있으면(hasOlder) 맨 위 구분선을 두지 않는다 — 그 날의 첫 메시지인지 모른다", () => {
    const items = [msg(5, at("2027-01-15T08:00:00Z")), msg(6, at("2027-01-16T08:00:00Z"))];
    expect(groupRows(timeline({ items, hasOlder: true }), [], TZ).map((r) => r.key)).toEqual([
      `msg:${items[0]?.id}`,
      "date:2027-01-16",
      `msg:${items[1]?.id}`,
    ]);
  });

  it("순서: 확정 → 버블(runId 순서 그대로) → 보내는 중", () => {
    const items = [msg(1, { authorId: USER })];
    const rows = groupRows(timeline({ items, pending: [pending("p1"), pending("p2")] }), [RUN2, RUN], TZ);
    expect(rows.map((r) => r.key)).toEqual([
      "date:2027-01-15",
      `msg:${items[0]?.id}`,
      `run:${RUN2}`,
      `run:${RUN}`,
      "pending:p1",
      "pending:p2",
    ]);
    expect(rows[2]).toEqual({ kind: "bubble", key: `run:${RUN2}`, runId: RUN2 });
    expect(rows[4]).toMatchObject({ kind: "pending", pending: { clientMsgId: "p1" } });
  });

  it("빈 타임라인은 빈 목록", () => {
    expect(groupRows(emptyTimeline(), [], TZ)).toEqual([]);
  });
});

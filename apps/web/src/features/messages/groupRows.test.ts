import { describe, expect, it } from "vitest";
import { AGENT, APPROVAL, APPROVAL2, approval, msg, RUN, RUN2, USER } from "../../../test/fixtures";
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
    expect(heads(groupRows(timeline({ items }), [], [], TZ))).toEqual([true, false]);
  });

  it("6분 간격이면 둘 다 머리", () => {
    const items = [msg(1, at("2027-01-15T08:00:00Z")), msg(2, at("2027-01-15T08:06:00Z"))];
    expect(heads(groupRows(timeline({ items }), [], [], TZ))).toEqual([true, true]);
  });

  it("작성자가 바뀌면 머리", () => {
    const items = [
      msg(1, at("2027-01-15T08:00:00Z")),
      msg(2, { ...at("2027-01-15T08:01:00Z"), authorType: "agent", authorId: AGENT }),
      msg(3, { ...at("2027-01-15T08:01:30Z"), authorType: "agent", authorId: AGENT }),
      msg(4, at("2027-01-15T08:02:00Z")),
    ];
    expect(heads(groupRows(timeline({ items }), [], [], TZ))).toEqual([true, true, false, true]);
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
    expect(heads(groupRows(timeline({ items }), [], [], TZ))).toEqual([true, true, true, true]);
  });

  it("날짜가 바뀌면 구분선 — 날짜는 주어진 시간대로 가른다", () => {
    // UTC 로는 같은 날, 서울로는 1월 15일 23:59 → 16일 00:01. 같은 사람 2분 간격이어도 새 날의 첫 메시지는 머리
    const items = [msg(1, at("2027-01-15T14:59:00Z")), msg(2, at("2027-01-15T15:01:00Z"))];
    const rows = groupRows(timeline({ items }), [], [], TZ);
    expect(rows.map((r) => r.key)).toEqual([
      "date:2027-01-15",
      `msg:${items[0]?.id}`,
      "date:2027-01-16",
      `msg:${items[1]?.id}`,
    ]);
    expect(rows[2]).toEqual({ kind: "divider", key: "date:2027-01-16", date: "2027-01-16" });
    expect(heads(rows)).toEqual([true, true]);
    expect(kinds(groupRows(timeline({ items }), [], [], "UTC"))).toEqual(["divider", "message", "message"]);
  });

  it("더 옛 메시지가 남아 있으면(hasOlder) 맨 위 구분선을 두지 않는다 — 그 날의 첫 메시지인지 모른다", () => {
    const items = [msg(5, at("2027-01-15T08:00:00Z")), msg(6, at("2027-01-16T08:00:00Z"))];
    expect(groupRows(timeline({ items, hasOlder: true }), [], [], TZ).map((r) => r.key)).toEqual([
      `msg:${items[0]?.id}`,
      "date:2027-01-16",
      `msg:${items[1]?.id}`,
    ]);
  });

  it("순서: 확정 → 버블(runId 순서 그대로) → 보내는 중", () => {
    const items = [msg(1, { authorId: USER })];
    const rows = groupRows(timeline({ items, pending: [pending("p1"), pending("p2")] }), [RUN2, RUN], [], TZ);
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
    expect(groupRows(emptyTimeline(), [], [], TZ)).toEqual([]);
  });
});

describe("groupRows 승인 행", () => {
  it("확정된 승인은 결정 자리(decidedAt, 없으면 createdAt)에, 미해결 승인은 맨 아래 버블 앞에", () => {
    const items = [msg(1, at("2027-01-15T08:00:00Z")), msg(2, at("2027-01-15T08:10:00Z"))];
    const settled = approval({
      id: APPROVAL,
      status: "allowed",
      createdAt: "2027-01-15T08:05:00.000Z",
    });
    const open = approval({ id: APPROVAL2, createdAt: "2027-01-15T08:20:00.000Z" });
    const rows = groupRows(timeline({ items }), [RUN], [open, settled], TZ);

    expect(rows.map((r) => r.key)).toEqual([
      "date:2027-01-15",
      `msg:${items[0]?.id}`,
      `approval:${APPROVAL}`,
      `msg:${items[1]?.id}`,
      `approval:${APPROVAL2}`,
      `run:${RUN}`,
    ]);
    expect(rows[2]).toEqual({ kind: "approval", key: `approval:${APPROVAL}`, approvalId: APPROVAL });
  });

  it("확정 승인이 마지막 메시지보다 뒤면 메시지 뒤, 미해결 앞에 남는다", () => {
    const items = [msg(1, at("2027-01-15T08:00:00Z"))];
    const settled = approval({ id: APPROVAL, status: "expired", createdAt: "2027-01-15T08:30:00.000Z" });
    const open = approval({ id: APPROVAL2, createdAt: "2027-01-15T08:20:00.000Z" });

    expect(groupRows(timeline({ items }), [], [open, settled], TZ).map((r) => r.key)).toEqual([
      "date:2027-01-15",
      `msg:${items[0]?.id}`,
      `approval:${APPROVAL}`,
      `approval:${APPROVAL2}`,
    ]);
  });

  it("승인 행은 앞뒤 묶음을 끊는다 — 뒤 메시지는 다시 머리", () => {
    const items = [
      msg(1, { authorType: "agent", authorId: AGENT, ...at("2027-01-15T08:00:00Z") }),
      msg(2, { authorType: "agent", authorId: AGENT, ...at("2027-01-15T08:02:00Z") }),
    ];
    // 승인 없이는 둘째가 묶음(head false)
    expect(heads(groupRows(timeline({ items }), [], [], TZ))).toEqual([true, false]);

    const between = approval({ status: "allowed", createdAt: "2027-01-15T08:01:00.000Z" });
    expect(heads(groupRows(timeline({ items }), [], [between], TZ))).toEqual([true, true]);
  });

  it("승인 행이 맨 앞에 와도 날짜 구분선 규칙은 그대로 — hasOlder 면 맨 위 구분선을 두지 않는다", () => {
    const items = [msg(5, at("2027-01-15T08:00:00Z")), msg(6, at("2027-01-16T08:00:00Z"))];
    const early = approval({ status: "allowed", createdAt: "2027-01-15T07:00:00.000Z" });

    expect(groupRows(timeline({ items, hasOlder: true }), [], [early], TZ).map((r) => r.key)).toEqual([
      `approval:${APPROVAL}`,
      `msg:${items[0]?.id}`,
      "date:2027-01-16",
      `msg:${items[1]?.id}`,
    ]);
  });

  it("확정 승인이 날짜 경계 사이에 있어도 그 날의 구분선은 남는다", () => {
    // 승인 행이 묶음을 끊느라 prev 를 버리므로, 구분선 조건이 prev 를 보면 1/16 구분선이 통째로 사라진다
    const items = [msg(5, at("2027-01-15T08:00:00Z")), msg(6, at("2027-01-16T08:00:00Z"))];
    const between = approval({ status: "allowed", createdAt: "2027-01-15T09:00:00.000Z" });

    expect(groupRows(timeline({ items, hasOlder: true }), [], [between], TZ).map((r) => r.key)).toEqual([
      `msg:${items[0]?.id}`,
      `approval:${APPROVAL}`,
      "date:2027-01-16",
      `msg:${items[1]?.id}`,
    ]);
  });

  it("확정 순간 자리가 그대로다 — 확정 승인은 decidedAt 자리라 대기 중 뒤에 낀 메시지보다 뒤에 남는다(D4)", () => {
    // 08:00 요구 → 대기 중 08:01 메시지 → 08:02 허용. createdAt 자리로 돌아가면 한 프레임에 메시지 위로 튀었다
    const items = [msg(1, at("2027-01-15T07:59:00Z")), msg(2, at("2027-01-15T08:01:00Z"))];
    const waiting = approval({ id: APPROVAL, createdAt: "2027-01-15T08:00:00.000Z" });
    const decided = { ...waiting, status: "allowed" as const, decidedAt: "2027-01-15T08:02:00.000Z" };

    const before = groupRows(timeline({ items }), [RUN], [waiting], TZ).map((r) => r.key);
    const after = groupRows(timeline({ items }), [RUN], [decided], TZ).map((r) => r.key);
    expect(after).toEqual(before);
    expect(after).toEqual([
      "date:2027-01-15",
      `msg:${items[0]?.id}`,
      `msg:${items[1]?.id}`,
      `approval:${APPROVAL}`,
      `run:${RUN}`,
    ]);

    // 결정 뒤에 온 메시지는 카드 뒤 — 다시 그려도(새 메시지가 붙어도) 카드는 결정한 자리에 있다
    const later = [...items, msg(3, at("2027-01-15T08:03:00Z"))];
    expect(groupRows(timeline({ items: later }), [], [decided], TZ).map((r) => r.key)).toEqual([
      "date:2027-01-15",
      `msg:${items[0]?.id}`,
      `msg:${items[1]?.id}`,
      `approval:${APPROVAL}`,
      `msg:${later[2]?.id}`,
    ]);
  });

  it("확정 승인끼리도 결정 순서 — decidedAt 이 없으면 createdAt 으로 센다", () => {
    const items = [msg(1, at("2027-01-15T08:00:00Z"))];
    const first = approval({
      id: APPROVAL,
      status: "denied",
      createdAt: "2027-01-15T08:01:00.000Z",
      decidedAt: "2027-01-15T08:09:00.000Z",
    });
    const second = approval({ id: APPROVAL2, status: "expired", createdAt: "2027-01-15T08:05:00.000Z" });

    expect(groupRows(timeline({ items }), [], [first, second], TZ).map((r) => r.key)).toEqual([
      "date:2027-01-15",
      `msg:${items[0]?.id}`,
      `approval:${APPROVAL2}`,
      `approval:${APPROVAL}`,
    ]);
  });

  it("승인이 없으면 행도 없다", () => {
    const items = [msg(1, at("2027-01-15T08:00:00Z"))];
    expect(kinds(groupRows(timeline({ items }), [], [], TZ))).toEqual(["divider", "message"]);
  });
});

describe("groupRows 「새 메시지」 구분선", () => {
  const OTHER = "00000000-0000-4000-8000-0000000000aa";
  const theirs = (seq: number, iso = "2027-01-15T08:00:00Z", over = {}) =>
    msg(seq, { ...at(iso), authorId: OTHER, ...over });
  const withUnread = (items: ReturnType<typeof msg>[], entryReadSeq: number | undefined, tzOpt = TZ) =>
    groupRows(timeline({ items }), [], [], tzOpt, { entryReadSeq, me: USER });
  const unreadAt = (rows: Row[]) => rows.findIndex((r) => r.kind === "unread");

  it("entryReadSeq 가 없으면 행이 없다", () => {
    expect(kinds(withUnread([theirs(1), theirs(2)], undefined))).not.toContain("unread");
  });

  it("seq > entryReadSeq 인 첫 남의 최상위 글 앞에 한 번 — 그 글은 머리", () => {
    const rows = withUnread(
      [theirs(1), theirs(2, "2027-01-15T08:00:10Z"), theirs(3, "2027-01-15T08:00:20Z")],
      1,
    );
    expect(kinds(rows)).toEqual(["divider", "message", "unread", "message", "message"]);
    expect(rows.filter((r) => r.kind === "unread")).toHaveLength(1);
    expect(heads(rows)).toEqual([true, true, false]);
  });

  it("내 글·시스템 메시지는 건너뛰고 그다음 남의 글 앞에 둔다", () => {
    const items = [
      theirs(1),
      msg(2, { ...at("2027-01-15T08:00:10Z"), authorId: USER }),
      msg(3, {
        ...at("2027-01-15T08:00:20Z"),
        kind: "system",
        authorType: "system",
        authorId: undefined,
        systemMeta: { kind: "info" },
      }),
      theirs(4, "2027-01-15T08:00:30Z"),
    ];
    const rows = withUnread(items, 1);
    const i = unreadAt(rows);
    const next = rows[i + 1];
    expect(next?.kind === "message" && next.message.seq).toBe(4);
  });

  it("스레드 답글은 구분선 자리가 아니다", () => {
    const items = [
      theirs(1),
      theirs(2, "2027-01-15T08:00:10Z", { threadRootId: "00000000-0000-4000-8000-0000000000bb" }),
      theirs(3, "2027-01-15T08:00:20Z"),
    ];
    const rows = withUnread(items, 1);
    const next = rows[unreadAt(rows) + 1];
    expect(next?.kind === "message" && next.message.seq).toBe(3);
  });

  it("모두 읽은 범위면 없다", () => {
    expect(unreadAt(withUnread([theirs(1), theirs(2)], 2))).toBe(-1);
  });

  it("에이전트 글은 사람이어도 me 와 id 가 같다고 건너뛰지 않는다 — 내가 쓴 사람 글만 건너뛴다", () => {
    const rows = withUnread(
      [theirs(1), msg(2, { ...at("2027-01-15T08:00:10Z"), authorType: "agent", authorId: USER })],
      1,
    );
    expect(unreadAt(rows)).toBeGreaterThan(-1);
  });

  it("날짜 구분선과 같은 자리면 날짜 구분선 뒤", () => {
    const rows = withUnread([theirs(1), theirs(2, "2027-01-16T08:00:00Z")], 1);
    expect(kinds(rows)).toEqual(["divider", "message", "divider", "unread", "message"]);
  });
});

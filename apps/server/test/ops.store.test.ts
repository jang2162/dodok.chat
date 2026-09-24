import { OpsEvent } from "@dodok/shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { opsEvents } from "../src/db/schema.sqlite";
import {
  ackEvents,
  listEvents,
  OPS_GROUP_WINDOW_MS,
  OPS_RETENTION_MS,
  recordEvent,
  resolveEvent,
  sweepEvents,
  unackedCounts,
} from "../src/modules/ops/store";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

const T0 = new Date("2026-09-25T00:00:00.000Z");
const MIN = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms);

let db: Db;
let ws: string;

beforeEach(() => {
  db = newTestDb();
  ws = seedWorkspace(db).workspaceId;
});

const rows = () => db.select().from(opsEvents).all();
const ratelimit = (key = "rest:/api/v1/messages") =>
  ({ kind: "ratelimit", key, severity: "info", detail: { ipPrefix: "203.0.113.0/24" } }) as const;

describe("recordEvent 묶기", () => {
  it("묶는 창은 1시간, 보존은 30일", () => {
    expect(OPS_GROUP_WINDOW_MS).toBe(3_600_000);
    expect(OPS_RETENTION_MS).toBe(30 * 24 * 3_600_000);
  });

  it("같은 kind·key 를 59분 간격으로 두 번 → 한 줄 count 2, lastAt 은 두 번째", () => {
    const first = recordEvent(db, ws, ratelimit(), T0);
    const second = recordEvent(db, ws, ratelimit(), at(59 * MIN));
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ count: 2, firstAt: T0.toISOString(), lastAt: at(59 * MIN).toISOString() });
    expect(OpsEvent.parse(second)).toEqual(second);
    expect(rows()).toHaveLength(1);
  });

  it("묶는 창은 마지막 기록부터 잰다 — 59분씩 세 번이면 첫 기록에서 118분이어도 한 줄", () => {
    recordEvent(db, ws, ratelimit(), T0);
    recordEvent(db, ws, ratelimit(), at(59 * MIN));
    const third = recordEvent(db, ws, ratelimit(), at(118 * MIN));
    expect(third.count).toBe(3);
    expect(rows()).toHaveLength(1);
  });

  it("정확히 60분 뒤는 아직 창 안 — 같은 줄", () => {
    const first = recordEvent(db, ws, ratelimit(), T0);
    expect(recordEvent(db, ws, ratelimit(), at(OPS_GROUP_WINDOW_MS)).id).toBe(first.id);
    expect(recordEvent(db, ws, ratelimit(), at(2 * OPS_GROUP_WINDOW_MS + 1)).id).not.toBe(first.id);
  });

  it("61분 뒤면 새 줄", () => {
    const first = recordEvent(db, ws, ratelimit(), T0);
    const second = recordEvent(db, ws, ratelimit(), at(61 * MIN));
    expect(second.id).not.toBe(first.id);
    expect(second.count).toBe(1);
    expect(rows()).toHaveLength(2);
  });

  it("ack 뒤 곧바로 다시 나면 새 줄", () => {
    const first = recordEvent(db, ws, ratelimit(), T0);
    ackEvents(db, ws, at(1), at(1));
    const second = recordEvent(db, ws, ratelimit(), at(2));
    expect(second.id).not.toBe(first.id);
    expect(second.ackedAt).toBeUndefined();
    expect(rows()).toHaveLength(2);
  });

  it("다른 key·다른 kind 는 다른 줄", () => {
    recordEvent(db, ws, ratelimit("a"), T0);
    recordEvent(db, ws, ratelimit("b"), T0);
    recordEvent(db, ws, { kind: "run_failed", key: "a", severity: "warn" }, T0);
    expect(rows()).toHaveLength(3);
  });

  it("다른 워크스페이스는 다른 줄", () => {
    const other = seedWorkspace(db, { userHandle: "other" }).workspaceId;
    recordEvent(db, ws, ratelimit(), T0);
    recordEvent(db, other, ratelimit(), T0);
    expect(rows()).toHaveLength(2);
  });

  it("묶을 때 detail 은 새 값으로 덮고, severity 는 더 높은 쪽을 남긴다", () => {
    recordEvent(db, ws, { kind: "disk_low", key: "data", severity: "error", detail: { freeBytes: 100 } }, T0);
    const next = recordEvent(
      db,
      ws,
      { kind: "disk_low", key: "data", severity: "warn", detail: { freeBytes: 200 } },
      at(10 * MIN),
    );
    expect(next).toMatchObject({ count: 2, severity: "error", detail: { freeBytes: 200 } });
  });

  it("폭주 — 1000번 기록해도 한 줄 count 1000", () => {
    for (let i = 0; i < 1000; i++) recordEvent(db, ws, ratelimit(), at(i));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.count).toBe(1000);
  });
});

describe("끊김 사건", () => {
  const down = { kind: "gateway_down", key: "gateway", severity: "warn" } as const;

  it("열린 줄이 있으면 2시간 뒤 record 도 같은 줄", () => {
    const first = recordEvent(db, ws, down, T0);
    const again = recordEvent(db, ws, down, at(120 * MIN));
    expect(again.id).toBe(first.id);
    expect(again.count).toBe(2);
    expect(rows()).toHaveLength(1);
  });

  it("resolve 는 resolvedAt·detail.downMs(= resolvedAt - firstAt) 를 적고, 그 뒤 record 는 새 줄", () => {
    const first = recordEvent(db, ws, { ...down, detail: { since: "x" } }, T0);
    recordEvent(db, ws, down, at(5 * MIN));
    const closed = resolveEvent(db, ws, "gateway_down", "gateway", at(7 * MIN));
    expect(closed).toMatchObject({
      id: first.id,
      resolvedAt: at(7 * MIN).toISOString(),
      lastAt: at(7 * MIN).toISOString(), // 닫은 시각이 마지막 활동 — 목록 맨 위로 온다
      detail: { since: "x", downMs: 7 * MIN },
    });
    const next = recordEvent(db, ws, down, at(8 * MIN));
    expect(next.id).not.toBe(first.id);
    expect(next.resolvedAt).toBeUndefined();
    expect(rows()).toHaveLength(2);
  });

  it("detail.thresholdMs 가 있으면 downMs 에 더한다 — 줄은 끊긴 지 임계만큼 지나서 열렸다", () => {
    recordEvent(db, ws, { ...down, detail: { thresholdMs: MIN } }, T0);
    const closed = resolveEvent(db, ws, "gateway_down", "gateway", at(7 * MIN));
    expect(closed?.detail).toMatchObject({ thresholdMs: MIN, downMs: 8 * MIN });
  });

  it("열린 줄이 없으면 resolve 는 null — 닫힌 줄을 다시 닫지 않는다", () => {
    expect(resolveEvent(db, ws, "plugin_down", "plugin", T0)).toBeNull();
    recordEvent(db, ws, { kind: "plugin_down", key: "plugin", severity: "warn" }, T0);
    expect(resolveEvent(db, ws, "plugin_down", "plugin", at(MIN))).not.toBeNull();
    expect(resolveEvent(db, ws, "plugin_down", "plugin", at(2 * MIN))).toBeNull();
    expect(rows()[0]?.resolvedAt).toEqual(at(MIN));
  });

  it("확인한 뒤에도 닫히기 전까지는 같은 줄이고, resolve 가 닫는다", () => {
    const first = recordEvent(db, ws, down, T0);
    ackEvents(db, ws, at(1), at(1));
    expect(recordEvent(db, ws, down, at(2)).id).toBe(first.id);
    expect(resolveEvent(db, ws, "gateway_down", "gateway", at(3))?.id).toBe(first.id);
  });
});

describe("ackEvents·unackedCounts", () => {
  it("unacked 는 확인 안 한 warn·error 줄 수만 센다(info 는 세지 않는다)", () => {
    recordEvent(db, ws, ratelimit(), T0);
    recordEvent(db, ws, { kind: "run_failed", key: "agent:a", severity: "warn" }, T0);
    recordEvent(db, ws, { kind: "run_failed", key: "agent:a", severity: "warn" }, at(1));
    recordEvent(db, ws, { kind: "run_failed", key: "agent:b", severity: "warn" }, T0);
    recordEvent(db, ws, { kind: "crash_rejection", key: "process", severity: "error" }, T0);
    expect(unackedCounts(db, ws)).toEqual({ warn: 2, error: 1 });
  });

  it("upTo 까지 lastAt 인 줄만 확인하고, 확인한 줄을 돌려준다", () => {
    recordEvent(db, ws, { kind: "run_failed", key: "agent:a", severity: "warn" }, T0);
    recordEvent(db, ws, { kind: "run_failed", key: "agent:b", severity: "warn" }, at(10));
    const acked = ackEvents(db, ws, at(5), at(20));
    expect(acked.map((e) => e.key)).toEqual(["agent:a"]);
    expect(acked[0]?.ackedAt).toBe(at(20).toISOString());
    expect(unackedCounts(db, ws)).toEqual({ warn: 1, error: 0 });
    expect(ackEvents(db, ws, at(5), at(30))).toHaveLength(0); // 이미 확인한 줄은 다시 세지 않는다
  });

  it("lastAt 이 upTo 와 같은 줄도 확인한다 — ack 를 누른 그 밀리초에 난 사건", () => {
    const row = recordEvent(db, ws, { kind: "run_failed", key: "agent:a", severity: "warn" }, at(7));
    expect(ackEvents(db, ws, new Date(row.lastAt), at(7)).map((e) => e.id)).toEqual([row.id]);
    expect(unackedCounts(db, ws)).toEqual({ warn: 0, error: 0 });
  });
});

describe("sweepEvents", () => {
  it("lastAt 이 30일+1ms 전인 줄만 지운다", () => {
    const now = at(OPS_RETENTION_MS + 1);
    recordEvent(db, ws, ratelimit("old"), T0); // 30일 + 1ms 전
    recordEvent(db, ws, ratelimit("edge"), at(1)); // 정확히 30일 전
    recordEvent(db, ws, ratelimit("fresh"), now);
    expect(sweepEvents(db, ws, now)).toBe(1);
    expect(
      rows()
        .map((r) => r.key)
        .sort(),
    ).toEqual(["edge", "fresh"]);
  });

  it("다른 워크스페이스의 오래된 줄은 지우지 않는다", () => {
    const other = seedWorkspace(db, { userHandle: "other" }).workspaceId;
    recordEvent(db, ws, ratelimit("mine"), T0);
    recordEvent(db, other, ratelimit("theirs"), T0);
    expect(sweepEvents(db, ws, at(OPS_RETENTION_MS + 1))).toBe(1);
    expect(rows().map((r) => r.key)).toEqual(["theirs"]);
  });
});

describe("listEvents", () => {
  it("lastAt 내림차순, 기본 50개, 커서로 다음 페이지 — 겹침·빠짐 없음", () => {
    for (let i = 0; i < 120; i++) recordEvent(db, ws, ratelimit(`k${i}`), at(i % 7)); // lastAt 이 겹친다
    const seen: string[] = [];
    let cursor: string | undefined;
    const pages: number[] = [];
    do {
      const page = listEvents(db, ws, cursor === undefined ? {} : { cursor });
      pages.push(page.events.length);
      for (let i = 1; i < page.events.length; i++) {
        const prev = page.events[i - 1] as OpsEvent;
        const cur = page.events[i] as OpsEvent;
        expect(prev.lastAt >= cur.lastAt).toBe(true);
      }
      seen.push(...page.events.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(pages).toEqual([50, 50, 20]);
    expect(new Set(seen).size).toBe(120);
  });

  it("limit 과 severity 필터", () => {
    recordEvent(db, ws, ratelimit("a"), T0);
    recordEvent(db, ws, { kind: "run_failed", key: "agent:a", severity: "warn" }, at(1));
    recordEvent(db, ws, { kind: "run_failed", key: "agent:b", severity: "warn" }, at(2));
    const warn = listEvents(db, ws, { severity: "warn", limit: 1 });
    expect(warn.events.map((e) => e.key)).toEqual(["agent:b"]);
    expect(warn.nextCursor).toBeDefined();
    const rest = listEvents(db, ws, { severity: "warn", limit: 1, cursor: warn.nextCursor as string });
    expect(rest.events.map((e) => e.key)).toEqual(["agent:a"]);
    expect(rest.nextCursor).toBeUndefined();
    expect(listEvents(db, ws, { severity: "info" }).events.map((e) => e.key)).toEqual(["a"]);
  });

  it("다른 워크스페이스 줄은 보이지 않는다", () => {
    const other = seedWorkspace(db, { userHandle: "other" }).workspaceId;
    recordEvent(db, other, ratelimit(), T0);
    expect(listEvents(db, ws, {}).events).toHaveLength(0);
  });

  it("망가진 커서는 VALIDATION 으로 던진다", () => {
    expect(() => listEvents(db, ws, { cursor: "garbage" })).toThrow(expect.objectContaining({ status: 400 }));
  });
});

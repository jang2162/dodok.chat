/**
 * 자동화 저장소·웹훅 토큰(자동화 스펙 「데이터 모델」·「토큰 수명」 절) — 이름은 워크스페이스 안에서 유일(CONFLICT), 다른 워크스페이스
 * 행은 보이지 않는다. 스케줄러의 「한 번만」은 claimRun 의 조건부 UPDATE(계획 판정 PA3). 토큰 원문은 발급 결과에만 있고 DB 에는 sha256 만.
 */
import type { AutomationSchedule } from "@dodok/shared";
import { createHash } from "node:crypto";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { automations } from "../src/db/schema.sqlite";
import { HttpError } from "../src/http/errors";
import {
  type NewAutomationRow,
  claimRun,
  deleteAutomation,
  dueSchedules,
  getAutomation,
  insertAutomation,
  listAutomations,
  updateAutomation,
} from "../src/modules/automations/store";
import { findWebhookByToken, issueWebhookToken } from "../src/modules/automations/tokens";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent } from "./helpers/seed";

const T0 = new Date("2026-10-07T00:00:00.000Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const daily: AutomationSchedule = { repeat: "daily", time: "09:00" };

type Seed = ReturnType<typeof seedChannelWithAgent>;

function setup() {
  const db = newTestDb();
  return { db, a: seedChannelWithAgent(db), b: seedChannelWithAgent(db) };
}

function scheduleRow(s: Seed, over: Partial<NewAutomationRow> = {}): NewAutomationRow {
  return {
    id: uuid(),
    workspaceId: s.workspaceId,
    name: "아침 점검",
    channelId: s.channelId,
    kind: "schedule",
    bodyMd: "@dev 점검해 줘",
    enabled: true,
    scheduleJson: daily,
    nextRunAt: at(0),
    createdBy: s.userId,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function webhookRow(s: Seed, token: { hash: string; prefix: string }, over: Partial<NewAutomationRow> = {}) {
  return scheduleRow(s, {
    name: "배포 알림",
    kind: "webhook",
    scheduleJson: null,
    nextRunAt: null,
    tokenHash: token.hash,
    tokenPrefix: token.prefix,
    ...over,
  });
}

function codeOf(fn: () => unknown): { status: number; code: string; details?: unknown } {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpError)
      return { status: err.status, code: err.body.code, details: err.body.details };
    throw err;
  }
  throw new Error("던지지 않았다");
}

const allRows = (db: Db) => db.select().from(automations).all();

describe("insertAutomation", () => {
  it("행을 넣고 돌려준다 — 예약 꼴은 JSON 으로 왕복한다", () => {
    const { db, a } = setup();
    const row = insertAutomation(db, scheduleRow(a));
    expect(row).toMatchObject({ name: "아침 점검", kind: "schedule", scheduleJson: daily, enabled: true });
    expect(getAutomation(db, a.workspaceId, row.id)).toEqual(row);
  });

  it("같은 워크스페이스의 같은 이름은 CONFLICT(칸 name) — 행이 늘지 않는다", () => {
    const { db, a } = setup();
    insertAutomation(db, scheduleRow(a));
    expect(codeOf(() => insertAutomation(db, scheduleRow(a)))).toEqual({
      status: 409,
      code: "CONFLICT",
      details: { field: "name" },
    });
    expect(allRows(db)).toHaveLength(1);
  });

  it("다른 워크스페이스는 같은 이름을 쓸 수 있다", () => {
    const { db, a, b } = setup();
    insertAutomation(db, scheduleRow(a));
    expect(() => insertAutomation(db, scheduleRow(b))).not.toThrow();
  });
});

describe("updateAutomation", () => {
  it("준 칸만 바꾼다", () => {
    const { db, a } = setup();
    const row = insertAutomation(db, scheduleRow(a));
    const updated = updateAutomation(db, a.workspaceId, row.id, { enabled: false, nextRunAt: null });
    expect(updated).toMatchObject({ enabled: false, nextRunAt: null, name: "아침 점검", bodyMd: row.bodyMd });
  });

  it("바꿀 칸이 없으면(빈 patch·undefined 만) 행을 그대로 돌려준다", () => {
    const { db, a } = setup();
    const row = insertAutomation(db, scheduleRow(a));
    expect(updateAutomation(db, a.workspaceId, row.id, {})).toEqual(row);
    expect(updateAutomation(db, a.workspaceId, row.id, { name: undefined })).toEqual(row);
    expect(codeOf(() => updateAutomation(db, a.workspaceId, uuid(), {})).code).toBe("NOT_FOUND");
  });

  it("다른 행의 이름으로 바꾸면 CONFLICT, 자기 이름 그대로는 통과", () => {
    const { db, a } = setup();
    insertAutomation(db, scheduleRow(a, { name: "하나" }));
    const two = insertAutomation(db, scheduleRow(a, { name: "둘" }));
    expect(codeOf(() => updateAutomation(db, a.workspaceId, two.id, { name: "하나" })).code).toBe("CONFLICT");
    expect(getAutomation(db, a.workspaceId, two.id)?.name).toBe("둘");
    expect(updateAutomation(db, a.workspaceId, two.id, { name: "둘", bodyMd: "바뀜" }).bodyMd).toBe("바뀜");
  });

  it("다른 워크스페이스의 행은 NOT_FOUND — 바뀌지 않는다", () => {
    const { db, a, b } = setup();
    const row = insertAutomation(db, scheduleRow(a));
    expect(codeOf(() => updateAutomation(db, b.workspaceId, row.id, { enabled: false })).code).toBe(
      "NOT_FOUND",
    );
    expect(getAutomation(db, a.workspaceId, row.id)?.enabled).toBe(true);
  });
});

describe("listAutomations·getAutomation·deleteAutomation", () => {
  it("다른 워크스페이스 행은 목록·조회에 안 보인다 — 목록은 만든 차례", () => {
    const { db, a, b } = setup();
    const first = insertAutomation(db, scheduleRow(a, { name: "먼저", createdAt: at(0) }));
    const second = insertAutomation(db, scheduleRow(a, { name: "나중", createdAt: at(1) }));
    const other = insertAutomation(db, scheduleRow(b));
    expect(listAutomations(db, a.workspaceId).map((r) => r.id)).toEqual([first.id, second.id]);
    expect(getAutomation(db, a.workspaceId, other.id)).toBeUndefined();
  });

  it("지우면 목록에서 빠지고, 다른 워크스페이스의 id 는 NOT_FOUND 로 남겨 둔다", () => {
    const { db, a, b } = setup();
    const row = insertAutomation(db, scheduleRow(a));
    expect(codeOf(() => deleteAutomation(db, b.workspaceId, row.id)).code).toBe("NOT_FOUND");
    expect(getAutomation(db, a.workspaceId, row.id)).toBeDefined();
    deleteAutomation(db, a.workspaceId, row.id);
    expect(listAutomations(db, a.workspaceId)).toEqual([]);
  });
});

describe("dueSchedules", () => {
  it("켜진 예약 가운데 next_run_at <= now 만, 이른 차례로 — 워크스페이스를 가리지 않는다", () => {
    const { db, a, b } = setup();
    const token = issueWebhookToken();
    const late = insertAutomation(db, scheduleRow(a, { name: "늦게", nextRunAt: at(0) }));
    const early = insertAutomation(db, scheduleRow(b, { name: "일찍", nextRunAt: at(-5) }));
    insertAutomation(db, scheduleRow(a, { name: "아직", nextRunAt: at(1) }));
    insertAutomation(db, scheduleRow(a, { name: "꺼짐", enabled: false, nextRunAt: at(-1) }));
    insertAutomation(db, scheduleRow(a, { name: "시각 없음", nextRunAt: null }));
    insertAutomation(db, webhookRow(a, token, { nextRunAt: at(-1) }));
    expect(dueSchedules(db, at(0)).map((r) => r.id)).toEqual([early.id, late.id]);
  });
});

describe("claimRun", () => {
  it("같은 seen 으로 두 번 — 처음만 true, next_run_at·last_run_at 이 오른다", () => {
    const { db, a } = setup();
    const row = insertAutomation(db, scheduleRow(a, { nextRunAt: at(0) }));
    const next = at(24 * 60);
    expect(claimRun(db, row.id, at(0), next, at(5))).toBe(true);
    expect(claimRun(db, row.id, at(0), next, at(5))).toBe(false);
    expect(getAutomation(db, a.workspaceId, row.id)).toMatchObject({ nextRunAt: next, lastRunAt: at(5) });
  });

  it("seen 이 지금 값과 다르면 false — 행을 건드리지 않는다", () => {
    const { db, a } = setup();
    const row = insertAutomation(db, scheduleRow(a, { nextRunAt: at(0) }));
    expect(claimRun(db, row.id, at(-1), at(60), at(5))).toBe(false);
    expect(getAutomation(db, a.workspaceId, row.id)).toMatchObject({ nextRunAt: at(0), lastRunAt: null });
  });

  it("끈 뒤(next_run_at null)에는 옛 seen 으로 가져갈 수 없다", () => {
    const { db, a } = setup();
    const row = insertAutomation(db, scheduleRow(a, { nextRunAt: at(0) }));
    updateAutomation(db, a.workspaceId, row.id, { enabled: false, nextRunAt: null });
    expect(claimRun(db, row.id, at(0), at(60), at(5))).toBe(false);
  });
});

describe("issueWebhookToken", () => {
  it("원문은 whk_ + base64url 43자, hash 는 원문의 sha256 hex 64자, prefix 는 whk_ 뒤 6자", () => {
    const token = issueWebhookToken();
    expect(token.raw).toMatch(/^whk_[A-Za-z0-9_-]{43}$/);
    expect(token.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(token.hash).toBe(createHash("sha256").update(token.raw).digest("hex"));
    expect(token.prefix).toBe(token.raw.slice(4, 10));
  });

  it("부를 때마다 다른 원문", () => {
    expect(issueWebhookToken().raw).not.toBe(issueWebhookToken().raw);
  });
});

describe("findWebhookByToken", () => {
  it("맞는 원문이면 그 행, 틀린 원문·빈 값이면 undefined", () => {
    const { db, a } = setup();
    const token = issueWebhookToken();
    const row = insertAutomation(db, webhookRow(a, token));
    expect(findWebhookByToken(db, token.raw)?.id).toBe(row.id);
    expect(findWebhookByToken(db, issueWebhookToken().raw)).toBeUndefined();
    expect(findWebhookByToken(db, "")).toBeUndefined();
  });

  it("DB 에는 원문이 없다 — 저장된 해시를 내밀어도 찾지 못한다", () => {
    const { db, a } = setup();
    const token = issueWebhookToken();
    insertAutomation(db, webhookRow(a, token));
    expect(JSON.stringify(allRows(db))).not.toContain(token.raw);
    expect(JSON.stringify(allRows(db))).not.toContain(token.raw.slice(4));
    expect(findWebhookByToken(db, token.hash)).toBeUndefined();
  });
});

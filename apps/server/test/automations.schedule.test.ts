/**
 * 예약 자동화의 다음 실행 시각(자동화 스펙 「다음 실행 시각」 절) — after 보다 엄격히 뒤인 가장 이른 순간을 워크스페이스 시간대의
 * 벽시계로 센다. 없는 벽시계 시각(봄)은 그 뒤 첫 유효 순간(매시간은 건너뜀), 두 번 있는 시각(가을)은 첫 번째.
 */
import type { AutomationSchedule } from "@dodok/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/http/errors";
import { assertTimeZone, nextRunAt } from "../src/modules/automations/schedule";

const SEOUL = "Asia/Seoul";
const NEW_YORK = "America/New_York";
/** 오프셋을 붙인 벽시계 — 기대값을 그 시간대 글자로 읽을 수 있게 */
const at = (iso: string) => new Date(iso);
const next = (schedule: AutomationSchedule, after: string, tz = SEOUL) =>
  nextRunAt(schedule, tz, at(after)).toISOString();

const daily = (time: string): AutomationSchedule => ({ repeat: "daily", time });

// 프로세스 시간대를 음수 오프셋으로 고정한다 — 벽시계 날짜를 프로세스 시간대로 읽는 실수(getUTCDay 대신 getDay 등)는 UTC 이상 오프셋의
// 머신(KST 등)에서는 결과가 같아 숨는다. 자정 UTC 가 전날이 되는 시간대여야 어느 머신에서나 드러난다
const PROCESS_TZ = "America/Los_Angeles";
let savedTz: string | undefined;
beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = PROCESS_TZ;
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

it("전제 — 이 파일은 프로세스 시간대가 음수 오프셋인 채로 돈다(2026-10-07 00:00Z 가 그 시간대로는 화요일)", () => {
  expect(new Date("2026-10-07T00:00:00Z").getDay()).toBe(2);
  expect(new Date("2026-10-07T00:00:00Z").getUTCDay()).toBe(3);
});

describe("nextRunAt — Asia/Seoul", () => {
  it("daily — 08:59 뒤면 같은 날 09:00", () => {
    expect(next(daily("09:00"), "2026-10-07T08:59:00+09:00")).toBe(
      at("2026-10-07T09:00:00+09:00").toISOString(),
    );
    expect(next(daily("09:00"), "2026-10-07T08:59:59.999+09:00")).toBe(
      at("2026-10-07T09:00:00+09:00").toISOString(),
    );
  });

  it("daily — after 가 정각이거나 같은 분 안이면 다음 날", () => {
    expect(next(daily("09:00"), "2026-10-07T09:00:00+09:00")).toBe(
      at("2026-10-08T09:00:00+09:00").toISOString(),
    );
    expect(next(daily("09:00"), "2026-10-07T09:00:30+09:00")).toBe(
      at("2026-10-08T09:00:00+09:00").toISOString(),
    );
  });

  it("daily — 날짜는 UTC 가 아니라 그 시간대의 날짜로 센다", () => {
    // 10-08 07:30 KST 는 UTC 로 10-07 22:30 — 08:00 KST 는 UTC 날짜로 10-07 이지만 10-08 의 회차다
    expect(next(daily("08:00"), "2026-10-07T22:30:00Z")).toBe("2026-10-07T23:00:00.000Z");
  });

  it("daily 00:00 — 자정을 넘긴다", () => {
    expect(next(daily("00:00"), "2026-10-07T23:59:00+09:00")).toBe(
      at("2026-10-08T00:00:00+09:00").toISOString(),
    );
    expect(next(daily("00:00"), "2026-10-08T00:00:00+09:00")).toBe(
      at("2026-10-09T00:00:00+09:00").toISOString(),
    );
  });

  it("weekdays — 금 10:00 뒤면 월 09:00", () => {
    const weekdays: AutomationSchedule = { repeat: "weekdays", time: "09:00" };
    expect(next(weekdays, "2026-10-09T10:00:00+09:00")).toBe(at("2026-10-12T09:00:00+09:00").toISOString());
    expect(next(weekdays, "2026-10-10T12:00:00+09:00")).toBe(at("2026-10-12T09:00:00+09:00").toISOString());
    expect(next(weekdays, "2026-10-12T08:00:00+09:00")).toBe(at("2026-10-12T09:00:00+09:00").toISOString());
    // 목 09:00 뒤면 금 09:00 — 평일 안에서는 하루씩
    expect(next(weekdays, "2026-10-08T09:00:00+09:00")).toBe(at("2026-10-09T09:00:00+09:00").toISOString());
  });

  it("weekdays — 요일도 그 시간대로 센다(월 08:00 KST 는 UTC 로 일요일)", () => {
    expect(next({ repeat: "weekdays", time: "08:00" }, "2026-10-10T12:00:00+09:00")).toBe(
      "2026-10-11T23:00:00.000Z",
    );
  });

  it("weekly 일요일(0) — 수요일 뒤면 그 주 일요일, 일요일 정각 뒤면 다음 주 일요일", () => {
    const sunday: AutomationSchedule = { repeat: "weekly", weekday: 0, time: "09:00" };
    expect(next(sunday, "2026-10-07T12:00:00+09:00")).toBe(at("2026-10-11T09:00:00+09:00").toISOString());
    expect(next(sunday, "2026-10-11T09:00:00+09:00")).toBe(at("2026-10-18T09:00:00+09:00").toISOString());
    expect(next(sunday, "2026-10-11T08:59:00+09:00")).toBe(at("2026-10-11T09:00:00+09:00").toISOString());
  });

  it("weekly 토요일(6) — 토 23:00 뒤면 다음 주 토요일", () => {
    const saturday: AutomationSchedule = { repeat: "weekly", weekday: 6, time: "22:00" };
    expect(next(saturday, "2026-10-10T23:00:00+09:00")).toBe(at("2026-10-17T22:00:00+09:00").toISOString());
  });

  it("hourly minute 15 — 10:20 뒤면 11:15, 10:14 뒤면 10:15, 정각이면 다음 시", () => {
    const hourly: AutomationSchedule = { repeat: "hourly", minute: 15 };
    expect(next(hourly, "2026-10-07T10:20:00+09:00")).toBe(at("2026-10-07T11:15:00+09:00").toISOString());
    expect(next(hourly, "2026-10-07T10:14:00+09:00")).toBe(at("2026-10-07T10:15:00+09:00").toISOString());
    expect(next(hourly, "2026-10-07T10:15:00+09:00")).toBe(at("2026-10-07T11:15:00+09:00").toISOString());
  });

  it("hourly — 23시 뒤면 다음 날 0시", () => {
    expect(next({ repeat: "hourly", minute: 15 }, "2026-10-07T23:20:00+09:00")).toBe(
      at("2026-10-08T00:15:00+09:00").toISOString(),
    );
  });

  it("hourly — 그 시간대의 자정 시각대(00시)를 같은 날 00시로 읽는다", () => {
    // 벽시계를 읽는 서식이 자정을 24시로 내면 00:10 이 「다음 날 00:10」 으로 밀린다
    expect(next({ repeat: "hourly", minute: 30 }, "2026-10-08T00:10:00+09:00")).toBe(
      at("2026-10-08T00:30:00+09:00").toISOString(),
    );
    // 15:00 KST 는 UTC 자정 — 오프셋을 재는 순간이 그 시간대의 자정에 걸린다
    expect(next({ repeat: "hourly", minute: 0 }, "2026-10-07T14:30:00+09:00")).toBe(
      at("2026-10-07T15:00:00+09:00").toISOString(),
    );
  });

  it("월말·연말 — 12-31 23:30 뒤 daily 23:00 은 다음 해 01-01 23:00", () => {
    expect(next(daily("23:00"), "2026-12-31T23:30:00+09:00")).toBe(
      at("2027-01-01T23:00:00+09:00").toISOString(),
    );
    expect(next(daily("09:00"), "2026-10-31T10:00:00+09:00")).toBe(
      at("2026-11-01T09:00:00+09:00").toISOString(),
    );
  });

  it("윤년 — 2028-02-28 뒤는 02-29, 평년 2027-02-28 뒤는 03-01", () => {
    expect(next(daily("09:00"), "2028-02-28T10:00:00+09:00")).toBe(
      at("2028-02-29T09:00:00+09:00").toISOString(),
    );
    expect(next(daily("09:00"), "2027-02-28T10:00:00+09:00")).toBe(
      at("2027-03-01T09:00:00+09:00").toISOString(),
    );
  });
});

describe("nextRunAt — America/New_York 서머타임", () => {
  it("평소에는 그 시간대의 오프셋으로 — 여름 EDT(-4), 겨울 EST(-5)", () => {
    expect(next(daily("09:00"), "2026-07-01T00:00:00-04:00", NEW_YORK)).toBe("2026-07-01T13:00:00.000Z");
    expect(next(daily("09:00"), "2026-01-15T00:00:00-05:00", NEW_YORK)).toBe("2026-01-15T14:00:00.000Z");
  });

  it("봄 — 없는 02:30 은 그날 03:00 EDT(첫 유효 순간), 다음 날은 다시 02:30", () => {
    // 2026-03-08 02:00 EST 에 03:00 EDT 로 건너뛴다
    expect(next(daily("02:30"), "2026-03-08T00:00:00-05:00", NEW_YORK)).toBe("2026-03-08T07:00:00.000Z");
    expect(next(daily("02:30"), "2026-03-08T07:00:00Z", NEW_YORK)).toBe("2026-03-09T06:30:00.000Z");
  });

  it("봄 — 건너뛰는 구간 밖의 시각은 그대로", () => {
    expect(next(daily("01:59"), "2026-03-08T00:00:00-05:00", NEW_YORK)).toBe("2026-03-08T06:59:00.000Z");
    expect(next(daily("03:00"), "2026-03-08T00:00:00-05:00", NEW_YORK)).toBe("2026-03-08T07:00:00.000Z");
  });

  it("가을 — 두 번 있는 01:30 은 첫 번째(EDT)만, 두 번째(EST)는 건너뛰고 다음 날로", () => {
    // 2026-11-01 02:00 EDT 에 01:00 EST 로 돌아간다 — 01:30 EDT = 05:30Z, 01:30 EST = 06:30Z
    expect(next(daily("01:30"), "2026-11-01T00:00:00-04:00", NEW_YORK)).toBe("2026-11-01T05:30:00.000Z");
    expect(next(daily("01:30"), "2026-11-01T05:30:00Z", NEW_YORK)).toBe("2026-11-02T06:30:00.000Z");
    expect(next(daily("01:30"), "2026-11-01T06:00:00Z", NEW_YORK)).toBe("2026-11-02T06:30:00.000Z");
  });

  it("봄 — 매시간은 없는 벽시계 시각을 건너뛴다: 01:15 EST 다음은 03:15 EDT(03:00 에 한 번 더 돌지 않는다)", () => {
    const quarter: AutomationSchedule = { repeat: "hourly", minute: 15 };
    // 01:15:30 EST(06:15:30Z) 뒤 — 02:15 는 없다
    expect(next(quarter, "2026-03-08T06:15:30Z", NEW_YORK)).toBe("2026-03-08T07:15:00.000Z");
    expect(next(quarter, "2026-03-08T07:15:30Z", NEW_YORK)).toBe("2026-03-08T08:15:00.000Z");
    // 정시(:00)는 03:00 이 곧 그 시의 회차라 그대로
    expect(next({ repeat: "hourly", minute: 0 }, "2026-03-08T06:00:30Z", NEW_YORK)).toBe(
      "2026-03-08T07:00:00.000Z",
    );
  });

  it("가을 — 돌아간 뒤의 시각은 EST 로", () => {
    expect(next(daily("02:30"), "2026-11-01T00:00:00-04:00", NEW_YORK)).toBe("2026-11-01T07:30:00.000Z");
  });
});

describe("assertTimeZone", () => {
  it("있는 IANA 이름은 통과하고 Intl 의 정규형을 돌려준다", () => {
    expect(assertTimeZone(SEOUL)).toBe(SEOUL);
    expect(assertTimeZone(NEW_YORK)).toBe(NEW_YORK);
    expect(assertTimeZone("UTC")).toBe("UTC");
    expect(assertTimeZone("asia/seoul")).toBe(SEOUL);
    expect(assertTimeZone("US/Eastern")).toBe(NEW_YORK);
  });

  it("없는 이름·빈 이름은 VALIDATION", () => {
    for (const tz of ["Mars/Base", ""]) {
      let caught: unknown;
      try {
        assertTimeZone(tz);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpError);
      expect((caught as HttpError).body.code).toBe("VALIDATION");
    }
  });
});

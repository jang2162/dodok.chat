/**
 * 예약 자동화의 다음 실행 시각(자동화 스펙 「다음 실행 시각」 절). 시간대 계산은 Intl.DateTimeFormat 하나로 한다(의존성 없음) —
 * 후보 벽시계를 하루씩(매시간은 한 시간씩) 넘기며 반복 규칙에 맞는 것을 그 시간대의 순간으로 바꿔, after 보다 엄격히 뒤인 첫 순간을 고른다.
 * 서머타임: 없는 벽시계 시각(봄)은 그 뒤 첫 유효 순간, 두 번 있는 시각(가을)은 첫 번째만 — 두 번째는 다음 회차로 넘어간다.
 * 매시간만 다르다 — 없는 벽시계 시각은 건너뛴다. 첫 유효 순간(예: 03:00)으로 밀면 곧 다음 시의 회차(03:15)가 와서 15분 간격으로 두 번 돈다.
 */
import type { AutomationSchedule } from "@dodok/shared";
import { apiError } from "../../http/errors";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** 후보를 넘겨 보는 상한 — weekly 도 8일 안에 회차가 있다. 넘으면 계산이 틀린 것이다 */
const SEARCH_DAYS = 8;

/** 시간대마다 만든 서식기 — 만들기가 비싸다. 이름은 대소문자를 가리지 않아 변형이 끝없이 쌓일 수 있으므로 넘치면 비운다 */
const formatters = new Map<string, Intl.DateTimeFormat>();
const FORMATTERS_MAX = 64;

/** 틀린 이름이면 RangeError — 부르는 쪽(assertTimeZone)이 VALIDATION 으로 바꾼다 */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (fmt === undefined) {
    if (formatters.size >= FORMATTERS_MAX) formatters.clear();
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * 틀린 시간대 이름이면 VALIDATION, 맞으면 Intl 의 정규형(asia/seoul → Asia/Seoul, US/Eastern → America/New_York) —
 * 워크스페이스 설정에 저장하기 전에 불러 그 값을 저장한다. 시간대 선택 목록의 이름과 저장값이 맞게.
 * IANA 이름만 받는다 — Intl 은 고정 오프셋(+09:00·+0900·-05:30)도 받아 그 꼴(+09:00)을 정규형으로 주지만 거절한다.
 * Intl.supportedValuesOf("timeZone") 로 거르지 않는다: 그 목록에는 UTC·Etc/GMT-9 처럼 받아야 할 이름이 빠져 있다
 */
export function assertTimeZone(timeZone: string): string {
  let resolved: string;
  try {
    resolved = formatterFor(timeZone).resolvedOptions().timeZone;
  } catch {
    throw apiError("VALIDATION", "unknown time zone", { field: "timeZone" });
  }
  if (/^[+-]/.test(resolved)) throw apiError("VALIDATION", "unknown time zone", { field: "timeZone" });
  return resolved;
}

/**
 * 순간 t 의 그 시간대 벽시계(분까지)를 「UTC 로 읽은 같은 글자」의 ms 로 — 벽시계끼리 빼고 비교하려는 꼴이다.
 * 초 아래는 버린다(예약은 분 단위)
 */
function wallOf(fmt: Intl.DateTimeFormat, t: number): number {
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(t))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
}

/** 그 순간의 시간대 오프셋(벽시계 − UTC, ms) */
function offsetAt(fmt: Intl.DateTimeFormat, t: number): number {
  const minute = Math.floor(t / MINUTE_MS) * MINUTE_MS;
  return wallOf(fmt, minute) - minute;
}

/**
 * 벽시계 wall(UTC 로 읽은 ms) → 순간. 하루 앞·뒤의 오프셋 둘로 후보를 만든다 — 맞는 것이 둘이면 겹친 시각(가을)이라 이른 쪽,
 * 하나면 그것, 없으면 건너뛴 시각(봄)이라 두 후보 사이에서 벽시계가 wall 이상이 되는 첫 분을 찾는다(전환 순간)
 */
function wallToInstant(fmt: Intl.DateTimeFormat, wall: number): number {
  const candidates = [wall - offsetAt(fmt, wall - DAY_MS), wall - offsetAt(fmt, wall + DAY_MS)];
  const hits = candidates.filter((t) => wallOf(fmt, t) === wall);
  if (hits.length > 0) return Math.min(...hits);
  // 건너뛴 구간 안: lo 의 벽시계는 wall 앞, hi 의 벽시계는 wall 뒤. 그 사이에서 벽시계는 전환 한 번만 있어 단조롭다
  let lo = Math.min(...candidates) / MINUTE_MS;
  let hi = Math.max(...candidates) / MINUTE_MS;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (wallOf(fmt, mid * MINUTE_MS) >= wall) hi = mid;
    else lo = mid;
  }
  return hi * MINUTE_MS;
}

/** 벽시계 날짜(UTC 로 읽은 자정 ms)의 요일 — 0 = 일요일. 벽시계 글자로 세므로 시간대와 무관하다 */
const weekdayOf = (wallDay: number): number => new Date(wallDay).getUTCDay();

function dayMatches(schedule: Exclude<AutomationSchedule, { repeat: "hourly" }>, wallDay: number): boolean {
  if (schedule.repeat === "daily") return true;
  const weekday = weekdayOf(wallDay);
  if (schedule.repeat === "weekdays") return weekday >= 1 && weekday <= 5;
  return weekday === schedule.weekday;
}

/**
 * after 보다 엄격히 뒤인 가장 이른 회차. 정각에 돈 틱이 after 로 그 회차 시각을 넘기면 다음 회차가 나온다.
 * 틀린 시간대 이름이면 RangeError — 저장 때 assertTimeZone 으로 막는다
 */
export function nextRunAt(schedule: AutomationSchedule, timeZone: string, after: Date): Date {
  const fmt = formatterFor(timeZone);
  const afterMs = after.getTime();
  const start = wallOf(fmt, afterMs);
  // 한 칸 앞부터 본다 — 건너뛴 구간이 자정에 걸치면 전날 벽시계가 after 뒤의 순간으로 풀릴 수 있다
  if (schedule.repeat === "hourly") {
    const startHour = Math.floor(start / HOUR_MS) * HOUR_MS;
    for (let i = -1; i <= SEARCH_DAYS * 24; i++) {
      const wall = startHour + i * HOUR_MS + schedule.minute * MINUTE_MS;
      const t = wallToInstant(fmt, wall);
      // 없는 벽시계 시각이면 wallToInstant 가 그 뒤 순간으로 민다 — 매시간은 그 회차를 건너뛴다
      if (t > afterMs && wallOf(fmt, t) === wall) return new Date(t);
    }
  } else {
    const [hh, mm] = schedule.time.split(":").map(Number) as [number, number];
    const startDay = Math.floor(start / DAY_MS) * DAY_MS;
    for (let i = -1; i <= SEARCH_DAYS; i++) {
      const day = startDay + i * DAY_MS;
      if (!dayMatches(schedule, day)) continue;
      const t = wallToInstant(fmt, day + hh * HOUR_MS + mm * MINUTE_MS);
      if (t > afterMs) return new Date(t);
    }
  }
  throw apiError("INTERNAL", "no schedule time within search window");
}

import type { Conversation } from "@dodok/shared";

export type DateGroup = "today" | "yesterday" | "week" | "older";

/** 묶음 머리 글(에이전트 DM 스펙 3.2) — 순서가 화면 순서다 */
export const DATE_GROUP_LABEL: Record<DateGroup, string> = {
  today: "오늘",
  yesterday: "어제",
  week: "이번 주",
  older: "이전",
};

const DAY_MS = 86_400_000;
/** 그 시각이 든 날의 0시(브라우저 시간대) */
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * 시각이 어느 묶음인가(에이전트 DM 계획 판정 PD12) — 브라우저 시간대의 달력 날짜로 센다: 오늘 · 어제 · 이번 주(오늘 포함 7일 — 2~6일 전) ·
 * 이전. 하루 길이가 23·25시간인 날(일광 절약 시간)도 반올림으로 하루로 센다. 시계가 어긋나 미래인 시각은 오늘이다
 */
export function dateGroupOf(iso: string, now: Date = new Date()): DateGroup {
  const days = Math.round((startOfDay(now) - startOfDay(new Date(iso))) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  return "older";
}

/**
 * 최근 활동순 목록을 그 순서 그대로 묶는다 — 마지막 글 시각(없으면 만든 시각) 기준. 목록이 최근 활동순이라 같은 묶음은 이어져 있다.
 * 순서가 어긋난 줄(실시간으로 위로 올라온 세션 등)이 있어도 줄을 옮기지 않고 그 자리에서 새 묶음을 연다 — 같은 머리가 두 번 보일 수 있다
 */
export function groupByDate(
  conversations: readonly Conversation[],
  now: Date = new Date(),
): Array<{ group: DateGroup; conversations: Conversation[] }> {
  const out: Array<{ group: DateGroup; conversations: Conversation[] }> = [];
  for (const c of conversations) {
    const group = dateGroupOf(c.lastMessageAt ?? c.createdAt, now);
    const last = out.at(-1);
    if (last?.group === group) last.conversations.push(c);
    else out.push({ group, conversations: [c] });
  }
  return out;
}

import type { Message } from "@dodok/shared";
import type { PendingMessage, Timeline } from "./timeline";

/** 메시지 목록의 한 행. key 는 가상 목록이 스크롤 위치를 붙드는 기준이라 같은 항목이면 늘 같아야 한다 */
export type Row =
  | { kind: "divider"; key: string; date: string }
  | { kind: "message"; key: string; message: Message; head: boolean }
  | { kind: "pending"; key: string; pending: PendingMessage }
  | { kind: "bubble"; key: string; runId: string };

/** 같은 작성자의 연속 메시지를 한 묶음(머리 생략)으로 보는 간격(스펙 5.3) */
const GROUP_GAP_MS = 5 * 60_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
/** 그 시간대의 날짜 `YYYY-MM-DD`. tz 가 없으면 브라우저 시간대 */
function dayOf(iso: string, tz: string | undefined): string {
  const id = tz ?? "";
  let f = formatters.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short" });
    formatters.set(id, f);
  }
  return f.format(new Date(iso));
}

function continues(prev: Message, m: Message): boolean {
  if (prev.kind === "system" || m.kind === "system") return false;
  if (prev.authorType !== m.authorType || prev.authorId !== m.authorId) return false;
  const gap = Date.parse(m.createdAt) - Date.parse(prev.createdAt);
  return gap >= 0 && gap < GROUP_GAP_MS;
}

/**
 * 타임라인 → 목록 행(스펙 5.3·5.5). 날짜가 바뀌는 자리에 구분선, 같은 작성자 5분 안 연속은 `head: false`,
 * 시스템 메시지는 늘 머리이고 앞뒤 묶음을 끊는다. 순서는 확정 → 스트리밍 버블 → 보내는 중.
 * 더 옛 메시지가 남아 있으면(`hasOlder`) 맨 위 구분선은 두지 않는다 — 그 날의 첫 메시지인지 아직 모르고,
 * 과거 페이지를 붙일 때 구분선이 맨 위에 남아 있으면 스크롤 기준 행이 되어 위치가 튄다
 */
export function groupRows(timeline: Timeline, bubbleRunIds: readonly string[], tz?: string): Row[] {
  const rows: Row[] = [];
  let prev: Message | undefined;
  let prevDay: string | undefined;
  for (const message of timeline.items) {
    const day = dayOf(message.createdAt, tz);
    const newDay = day !== prevDay;
    if (newDay && (prev !== undefined || !timeline.hasOlder)) {
      rows.push({ kind: "divider", key: `date:${day}`, date: day });
    }
    const head = newDay || prev === undefined || !continues(prev, message);
    rows.push({ kind: "message", key: `msg:${message.id}`, message, head });
    prev = message;
    prevDay = day;
  }
  for (const runId of bubbleRunIds) rows.push({ kind: "bubble", key: `run:${runId}`, runId });
  for (const pending of timeline.pending) {
    rows.push({ kind: "pending", key: `pending:${pending.clientMsgId}`, pending });
  }
  return rows;
}

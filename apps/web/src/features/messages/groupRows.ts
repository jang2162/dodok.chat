import type { Approval, Message } from "@dodok/shared";
import type { PendingMessage, Timeline } from "./timeline";

/** 메시지 목록의 한 행. key 는 가상 목록이 스크롤 위치를 붙드는 기준이라 같은 항목이면 늘 같아야 한다 */
export type Row =
  | { kind: "divider"; key: string; date: string }
  | { kind: "message"; key: string; message: Message; head: boolean }
  | { kind: "pending"; key: string; pending: PendingMessage }
  | { kind: "bubble"; key: string; runId: string }
  | { kind: "approval"; key: string; approvalId: string };

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

const NO_APPROVALS: readonly Approval[] = [];
const approvalRow = (a: Approval): Row => ({ kind: "approval", key: `approval:${a.id}`, approvalId: a.id });
/** 승인은 이른 것부터. 같은 시각이면 id 순(uuid v7 = 생성 순) */
const byAge = (a: Approval, b: Approval): number =>
  a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1;

/**
 * 타임라인 → 목록 행(스펙 5.3·5.5, 설계 5.3). 날짜가 바뀌는 자리에 구분선, 같은 작성자 5분 안 연속은 `head: false`,
 * 시스템 메시지는 늘 머리이고 앞뒤 묶음을 끊는다. 순서는 확정 → 미해결 승인 → 스트리밍 버블 → 보내는 중.
 * 확정된 승인 카드는 **사라지지 않고** `createdAt` 자리에 남는다(기록) — 승인 행도 시스템 카드처럼 앞뒤 묶음을 끊는다.
 * 더 옛 메시지가 남아 있으면(`hasOlder`) 맨 위 구분선은 두지 않는다 — 그 날의 첫 메시지인지 아직 모르고,
 * 과거 페이지를 붙일 때 구분선이 맨 위에 남아 있으면 스크롤 기준 행이 되어 위치가 튄다
 */
export function groupRows(
  timeline: Timeline,
  bubbleRunIds: readonly string[],
  approvals: readonly Approval[] = NO_APPROVALS,
  tz?: string,
): Row[] {
  const rows: Row[] = [];
  const sorted = [...approvals].sort(byAge);
  // 확정된 승인은 시간 자리에, 아직 답하지 않은 승인은 맨 아래로 — 시간이 흐르는 카드라 끝에 붙어 있어야 눈에 든다
  const settled = sorted.filter((a) => a.status !== "pending");
  const open = sorted.filter((a) => a.status === "pending");
  let next = 0;
  let prev: Message | undefined;
  let prevDay: string | undefined;
  for (const message of timeline.items) {
    // 이 메시지보다 먼저 만들어진 확정 승인을 여기에 끼운다 — 승인 행은 시스템 카드처럼 묶음을 끊는다(prev 를 버린다)
    for (let a = settled[next]; a && a.createdAt <= message.createdAt; a = settled[next]) {
      rows.push(approvalRow(a));
      next += 1;
      prev = undefined;
    }
    const day = dayOf(message.createdAt, tz);
    const newDay = day !== prevDay;
    if (newDay && (prevDay !== undefined || !timeline.hasOlder)) {
      rows.push({ kind: "divider", key: `date:${day}`, date: day });
    }
    const head = newDay || prev === undefined || !continues(prev, message);
    rows.push({ kind: "message", key: `msg:${message.id}`, message, head });
    prev = message;
    prevDay = day;
  }
  for (const a of settled.slice(next)) rows.push(approvalRow(a));
  for (const a of open) rows.push(approvalRow(a));
  for (const runId of bubbleRunIds) rows.push({ kind: "bubble", key: `run:${runId}`, runId });
  for (const pending of timeline.pending) {
    rows.push({ kind: "pending", key: `pending:${pending.clientMsgId}`, pending });
  }
  return rows;
}

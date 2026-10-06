import type { Approval, Message } from "@dodok/shared";
import type { PendingMessage, Timeline } from "./timeline";

/** 메시지 목록의 한 행. key 는 가상 목록이 스크롤 위치를 붙드는 기준이라 같은 항목이면 늘 같아야 한다 */
export type Row =
  | { kind: "divider"; key: string; date: string }
  | { kind: "message"; key: string; message: Message; head: boolean }
  | { kind: "pending"; key: string; pending: PendingMessage }
  | { kind: "bubble"; key: string; runId: string }
  | { kind: "approval"; key: string; approvalId: string }
  | { kind: "unread"; key: "unread" };

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

/** 구분선이 서는 메시지 — 읽음 위치 뒤의 남의 최상위 보통 메시지. 에이전트 글은 id 가 같아도 내 글이 아니다 */
function isNewForMe(m: Message, opts: { entryReadSeq?: number; me?: string }): boolean {
  if (opts.entryReadSeq === undefined || m.seq <= opts.entryReadSeq) return false;
  if (m.kind !== "normal" || m.threadRootId !== undefined) return false;
  return !(m.authorType === "user" && m.authorId === opts.me);
}

/**
 * 첫 안 읽은 곳이 불러온 목록 안에서 정해졌는가. 목록이 일부(`hasOlder`)이고 그 맨 앞이 이미 `entryReadSeq + 1` 보다 뒤면
 * 그곳은 아직 안 불러온 쪽에 있다 — 배너가 맡는다(`hasOlder` 일 때 배너 조건의 정확한 반대다). 그래도 두면 맨 위 행이 되어,
 * 과거 페이지를 붙일 때 맨 위 날짜 구분선처럼 스크롤 기준 행이 되고 안 읽은 글을 따라 올라가 위치가 튄다
 */
function unreadSettled(timeline: Timeline, entryReadSeq: number | undefined): boolean {
  if (entryReadSeq === undefined) return false;
  const first = timeline.items[0];
  return !timeline.hasOlder || (first !== undefined && first.seq <= entryReadSeq + 1);
}

const NO_APPROVALS: readonly Approval[] = [];
const approvalRow = (a: Approval): Row => ({ kind: "approval", key: `approval:${a.id}`, approvalId: a.id });
/**
 * 목록에서 승인이 서는 시각 — 미해결은 요구 시각, 확정은 **결정 시각**(없으면 요구 시각). 대기 카드는 맨 아래에 있으므로
 * 결정 시각에 서야 확정 순간 자리가 그대로다 — 요구 시각으로 돌아가면 대기 중 뒤에 낀 메시지 위로 한 프레임에 튄다(D4)
 */
const placedAt = (a: Approval): string =>
  a.status === "pending" ? a.createdAt : (a.decidedAt ?? a.createdAt);
/** 승인은 이른 것부터. 같은 시각이면 id 순(uuid v7 = 생성 순) */
const byPlace = (a: Approval, b: Approval): number => {
  const x = placedAt(a);
  const y = placedAt(b);
  return x === y ? (a.id < b.id ? -1 : 1) : x < y ? -1 : 1;
};

/**
 * 타임라인 → 목록 행(스펙 5.3·5.5, 설계 5.3). 날짜가 바뀌는 자리에 구분선, 같은 작성자 5분 안 연속은 `head: false`,
 * 시스템 메시지는 늘 머리이고 앞뒤 묶음을 끊는다. 순서는 확정 → 미해결 승인 → 스트리밍 버블 → 보내는 중.
 * 확정된 승인 카드는 **사라지지 않고** 결정 자리(`placedAt`)에 남는다(기록) — 승인 행도 시스템 카드처럼 앞뒤 묶음을 끊는다.
 * 더 옛 메시지가 남아 있으면(`hasOlder`) 맨 위 구분선은 두지 않는다 — 그 날의 첫 메시지인지 아직 모르고,
 * 과거 페이지를 붙일 때 구분선이 맨 위에 남아 있으면 스크롤 기준 행이 되어 위치가 튄다.
 * `entryReadSeq` 가 있으면 그 뒤의 첫 남의 최상위 보통 메시지 앞(같은 자리의 날짜 구분선 뒤)에 「새 메시지」 행을 한 번 둔다 — 그 메시지는 머리.
 * 그 자리가 불러온 목록 안에서 정해졌을 때만이다(`unreadSettled`)
 */
export function groupRows(
  timeline: Timeline,
  bubbleRunIds: readonly string[],
  approvals: readonly Approval[] = NO_APPROVALS,
  tz?: string,
  opts: { entryReadSeq?: number; me?: string } = {},
): Row[] {
  const rows: Row[] = [];
  const sorted = [...approvals].sort(byPlace);
  // 확정된 승인은 결정 시각 자리에, 아직 답하지 않은 승인은 맨 아래로 — 시간이 흐르는 카드라 끝에 붙어 있어야 눈에 든다
  const settled = sorted.filter((a) => a.status !== "pending");
  const open = sorted.filter((a) => a.status === "pending");
  let next = 0;
  let prev: Message | undefined;
  let prevDay: string | undefined;
  let unreadPlaced = !unreadSettled(timeline, opts.entryReadSeq);
  for (const message of timeline.items) {
    // 이 메시지보다 먼저 만들어진 확정 승인을 여기에 끼운다 — 승인 행은 시스템 카드처럼 묶음을 끊는다(prev 를 버린다)
    for (let a = settled[next]; a && placedAt(a) <= message.createdAt; a = settled[next]) {
      rows.push(approvalRow(a));
      next += 1;
      prev = undefined;
    }
    const day = dayOf(message.createdAt, tz);
    const newDay = day !== prevDay;
    if (newDay && (prevDay !== undefined || !timeline.hasOlder)) {
      rows.push({ kind: "divider", key: `date:${day}`, date: day });
    }
    const startsUnread = !unreadPlaced && isNewForMe(message, opts);
    if (startsUnread) {
      rows.push({ kind: "unread", key: "unread" });
      unreadPlaced = true;
    }
    const head = newDay || startsUnread || prev === undefined || !continues(prev, message);
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

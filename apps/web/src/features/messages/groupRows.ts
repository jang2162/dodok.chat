import type { Approval, Message } from "@dodok/shared";
import { type Bundle, bundleIndex } from "./bundles";
import { isChannelVisible, type PendingMessage, type Timeline } from "./timeline";

/** 메시지 목록의 한 행. key 는 가상 목록이 스크롤 위치를 붙드는 기준이라 같은 항목이면 늘 같아야 한다 */
export type Row =
  | { kind: "divider"; key: string; date: string }
  /** `activity` — 이 메시지에 활동 요약 줄을 붙인다(그 런의 메시지 가운데 이 목록에서 가장 앞 것 하나만) */
  | { kind: "message"; key: string; message: Message; head: boolean; activity: boolean }
  | { kind: "pending"; key: string; pending: PendingMessage }
  | { kind: "bubble"; key: string; runId: string }
  | { kind: "approval"; key: string; approvalId: string }
  /** 여러 에이전트 답 묶음 — 루트 글 바로 뒤(답 묶음 설계). `bundle` 은 그릴 내용, 자리는 key(`bundle:<rootId>`)가 붙든다 */
  | { kind: "bundle"; key: string; rootId: string; bundle: Bundle }
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
  // 채널에도 보낸 답글은 링크 줄이 붙으므로 앞 글과 이어 붙이지 않고 늘 머리 줄(이름·시각)을 그린다
  if (m.threadRootId !== undefined) return false;
  if (prev.authorType !== m.authorType || prev.authorId !== m.authorId) return false;
  const gap = Date.parse(m.createdAt) - Date.parse(prev.createdAt);
  return gap >= 0 && gap < GROUP_GAP_MS;
}

/** 구분선이 서는 메시지 — 읽음 위치 뒤의 남의 채널에 보이는(최상위 또는 채널에도 보낸 답글) 보통 메시지. 에이전트 글은 id 가 같아도 내 글이 아니다 */
function isNewForMe(m: Message, opts: GroupOpts): boolean {
  if (opts.entryReadSeq === undefined || m.seq <= opts.entryReadSeq) return false;
  if (m.kind !== "normal" || !isChannelVisible(m)) return false;
  return !(m.authorType === "user" && m.authorId === opts.me);
}

/**
 * `entryReadSeq` 가 있으면 「새 메시지」 행을 둔다. `settledReadSeq` 는 서버에 물어 확정한 진입 위치다 — 받은 목록의 맨 앞이 바로 읽음
 * 위치 뒤 첫 루트였을 때(페이지 경계가 우연히 맞았다) 「맨 앞 seq − 1」. 그 사이는 답글뿐이라 칩 수·`isNewForMe` 는 `entryReadSeq` 로 잰
 * 것과 같다
 */
type GroupOpts = {
  entryReadSeq?: number;
  me?: string;
  settledReadSeq?: number;
  /** 답 묶음(`computeBundles`) — 든 메시지·버블은 메인 행에서 빠지고 루트 글 뒤에 bundle 행 하나. 없으면 묶지 않는다 */
  bundles?: ReadonlyMap<string, Bundle>;
};

/**
 * 첫 안 읽은 곳이 불러온 목록 안에서 정해졌는가. 목록이 일부(`hasOlder`)이고 그 맨 앞이 이미 `entryReadSeq + 1` 보다 뒤면
 * 그곳은 아직 안 불러온 쪽에 있다 — 배너가 맡는다(`hasOlder` 일 때 배너 조건의 정확한 반대다). 그래도 두면 맨 위 행이 되어,
 * 과거 페이지를 붙일 때 맨 위 날짜 구분선처럼 스크롤 기준 행이 되고 안 읽은 글을 따라 올라가 위치가 튄다.
 * 서버가 맨 앞이 바로 그 자리라고 확정했으면(`settledReadSeq`) 정해진 것이다
 */
function unreadSettled(timeline: Timeline, opts: GroupOpts): boolean {
  if (opts.entryReadSeq === undefined) return false;
  const first = timeline.items[0];
  if (!timeline.hasOlder) return true;
  if (first === undefined) return false;
  return (
    first.seq <= opts.entryReadSeq + 1 ||
    (opts.settledReadSeq !== undefined && first.seq <= opts.settledReadSeq + 1)
  );
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
 * 그 자리가 불러온 목록 안에서 정해졌을 때만이다(`unreadSettled` — 서버에 물어 확정한 `settledReadSeq` 포함).
 * `bundles` 가 있으면 묶음에 든 메시지는 루트 글 자리에 있는 것으로 본다 — 행을 따로 두지 않고 구분선도 세우지 않으며, 루트 뒤 bundle 행이
 * 시스템 카드처럼 앞뒤 묶음을 끊는다. 묶음 런의 버블도 맨 아래에 두지 않는다(묶음 줄 안에서 그린다)
 */
export function groupRows(
  timeline: Timeline,
  bubbleRunIds: readonly string[],
  approvals: readonly Approval[] = NO_APPROVALS,
  tz?: string,
  opts: GroupOpts = {},
): Row[] {
  const rows: Row[] = [];
  const sorted = [...approvals].sort(byPlace);
  // 확정된 승인은 결정 시각 자리에, 아직 답하지 않은 승인은 맨 아래로 — 시간이 흐르는 카드라 끝에 붙어 있어야 눈에 든다
  const settled = sorted.filter((a) => a.status !== "pending");
  const open = sorted.filter((a) => a.status === "pending");
  let next = 0;
  let prev: Message | undefined;
  let prevDay: string | undefined;
  let unreadPlaced = !unreadSettled(timeline, opts);
  // 한 런이 메시지를 여럿 낼 수 있다(러너의 게시 + 마지막 답 등) — 요약 줄은 seq 가 가장 작은 것(가진 범위에서) 하나에만
  const activityRuns = new Set<string>();
  const bundles = opts.bundles;
  const index = bundles && bundles.size > 0 ? bundleIndex(bundles) : undefined;
  for (const message of timeline.items) {
    if (index?.byMessage.has(message.id)) continue;
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
    const runId = message.authorType === "agent" ? message.runId : undefined;
    const activity = runId !== undefined && !activityRuns.has(runId);
    if (runId !== undefined) activityRuns.add(runId);
    rows.push({ kind: "message", key: `msg:${message.id}`, message, head, activity });
    prev = message;
    prevDay = day;
    const bundle = bundles?.get(message.id);
    if (bundle) {
      rows.push({ kind: "bundle", key: `bundle:${message.id}`, rootId: message.id, bundle });
      prev = undefined;
    }
  }
  for (const a of settled.slice(next)) rows.push(approvalRow(a));
  for (const a of open) rows.push(approvalRow(a));
  for (const runId of bubbleRunIds) {
    if (!index?.byRun.has(runId)) rows.push({ kind: "bubble", key: `run:${runId}`, runId });
  }
  for (const pending of timeline.pending) {
    rows.push({ kind: "pending", key: `pending:${pending.clientMsgId}`, pending });
  }
  return rows;
}

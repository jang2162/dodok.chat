import type { Approval, ApprovalDecision, ApprovalStatus } from "@dodok/shared";
import { create } from "zustand";

/** 카드 하나의 화면 상태. `sending` 은 누른 결정 — ack 을 기다리는 동안 버튼을 잠근다 */
export type ApprovalView = { approval: Approval; sending?: ApprovalDecision };

/** 더는 바뀌지 않는 상태. 이 뒤에 온 `pending` 은 늦게 도착한 요구 프레임이므로 무시한다 */
export const SETTLED: ReadonlySet<ApprovalStatus> = new Set(["allowed", "denied", "expired", "cancelled"]);

/** 확정이 싣는 값들 — 통째로 같이 움직인다(허용됐다가 취소되면 앞 결정이 남지 않게) */
type Outcome = Pick<Approval, "status" | "decision" | "reason" | "decidedBy" | "decidedAt">;
const outcomeOf = (a: Approval): Outcome => ({
  status: a.status,
  decision: a.decision,
  reason: a.reason,
  decidedBy: a.decidedBy,
  decidedAt: a.decidedAt,
});

/** 뒤에 온 사실이 채워 줄 수 있는 자리 — 프레임마다 싣는 값이 다르다(p2-t6 보고서 C) */
const FILLABLE = [
  "runId",
  "toolCallId",
  "toolName",
  "pluginId",
  "description",
  "detail",
  "urlPath",
] as const satisfies ReadonlyArray<keyof Approval>;

/**
 * 같은 승인이 프레임 둘로 온다 — 어댑터가 병합본을 새 필드가 채워질 때마다 다시 발행한다(p2-t6 Ruling C).
 * 그래서 덮어쓰지 않고 **병합**한다: 이미 아는 값은 지키고 빈 자리만 메운다.
 * 확정(`status` 와 그에 딸린 값들)은 통째로 나중 것이 이기되, 확정 뒤에 온 `pending` 은 무시한다.
 */
export function mergeApproval(prev: Approval | undefined, next: Approval): Approval {
  if (!prev) return next;
  const kept = Object.fromEntries(
    FILLABLE.filter((key) => prev[key] !== undefined).map((key) => [key, prev[key]]),
  ) as Partial<Approval>;
  const settled = next.status === "pending" && SETTLED.has(prev.status) ? prev : next;
  return { ...next, ...kept, ...outcomeOf(settled) };
}

type ApprovalStore = {
  /** channelId → approvalId → 카드 */
  byChannel: Record<string, Record<string, ApprovalView>>;
  apply(approval: Approval): void;
  applyMany(approvals: readonly Approval[]): void;
  setSending(approvalId: string, decision?: ApprovalDecision): void;
  reset(): void;
};

function put(byChannel: ApprovalStore["byChannel"], approval: Approval): ApprovalStore["byChannel"] {
  const channel = byChannel[approval.channelId] ?? {};
  const prev = channel[approval.id];
  const merged = mergeApproval(prev?.approval, approval);
  // 확정되면 잠금을 푼다 — 결과 한 줄로 바뀌는 자리라 누를 버튼이 더는 없다
  const sending = SETTLED.has(merged.status) ? undefined : prev?.sending;
  return { ...byChannel, [approval.channelId]: { ...channel, [approval.id]: { approval: merged, sending } } };
}

/**
 * 채널별 승인(설계 5.5). 들어오는 길 셋: 구독 ack 의 `pendingApprovals`, wire `approval.requested`/`resolved`,
 * 카드의 잠금. 확정된 카드도 지우지 않는다 — 기록으로 남는다(설계 5.3)
 */
export const useApprovalStore = create<ApprovalStore>()((set) => ({
  byChannel: {},
  apply: (approval) => set((s) => ({ byChannel: put(s.byChannel, approval) })),
  applyMany: (approvals) =>
    set((s) => ({ byChannel: approvals.reduce((acc, a) => put(acc, a), s.byChannel) })),
  setSending: (approvalId, decision) =>
    set((s) => {
      for (const [channelId, channel] of Object.entries(s.byChannel)) {
        const view = channel[approvalId];
        if (!view || view.sending === decision) continue;
        return {
          byChannel: {
            ...s.byChannel,
            [channelId]: { ...channel, [approvalId]: { ...view, sending: decision } },
          },
        };
      }
      return s;
    }),
  reset: () => set({ byChannel: {} }),
}));

/** 이른 것부터. 같은 시각이면 id 순(uuid v7 = 생성 순)이라 순서가 흔들리지 않는다 */
const byAge = (a: ApprovalView, b: ApprovalView): number =>
  a.approval.createdAt === b.approval.createdAt
    ? a.approval.id < b.approval.id
      ? -1
      : 1
    : a.approval.createdAt < b.approval.createdAt
      ? -1
      : 1;

/**
 * 그 채널의 승인 전부(이른 것부터, 확정된 것 포함). 부를 때마다 새 배열을 돌려주므로 컴포넌트에서는
 * 반드시 `useApprovalStore(useShallow(selectChannelApprovals(id)))` 로 쓴다(그냥 쓰면 매 렌더 새 참조 → 무한 렌더)
 */
export const selectChannelApprovals =
  (channelId: string) =>
  (s: Pick<ApprovalStore, "byChannel">): ApprovalView[] =>
    Object.values(s.byChannel[channelId] ?? {}).sort(byAge);

/**
 * 아직 답하지 않은 승인 하나(가장 이른 것) — 활동 탭 맨 위가 쓴다. `runId` 를 주면 그 런의 것만 본다.
 * 만료는 서버 사실(`status`)로만 본다 — 클라이언트 시계는 표시용이다(설계 5.5)
 */
export const selectPendingApproval =
  (channelId: string, runId?: string) =>
  (s: Pick<ApprovalStore, "byChannel">): ApprovalView | undefined =>
    selectChannelApprovals(channelId)(s).find(
      (v) => v.approval.status === "pending" && (runId === undefined || v.approval.runId === runId),
    );

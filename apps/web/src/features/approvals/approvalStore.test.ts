import type { Approval, ApprovalStatus } from "@dodok/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { AGENT, APPROVAL, APPROVAL2, CH, CH2, RUN, RUN2, approval, uid } from "../../../test/fixtures";
import {
  mergeApproval,
  selectChannelApprovals,
  selectPendingApproval,
  useApprovalStore,
} from "./approvalStore";

const store = () => useApprovalStore.getState();
const cards = (channelId = CH) => store().byChannel[channelId] ?? {};
const view = (id = APPROVAL, channelId = CH) => cards(channelId)[id];
/** 스토어를 채워 두는 길 — 들어오는 길과 같게 하나씩 넣는다 */
const seed = (...approvals: Approval[]) => approvals.forEach((a) => store().apply(a));

beforeEach(() => store().reset());

describe("승인 스토어", () => {
  // 확정 넷 전부 — 늦게 온 요구 프레임이 어느 확정도 되살리지 못한다(SETTLED 전체를 잠근다)
  it.each<[ApprovalStatus, Partial<Approval>]>([
    ["allowed", { decision: "allow-once", reason: "user", decidedBy: AGENT }],
    ["denied", { decision: "deny", reason: "user", decidedBy: AGENT }],
    ["expired", { decision: "deny", reason: "timeout" }],
    ["cancelled", { reason: "run-aborted" }],
  ])("나중에 온 사실이 이긴다 — %s 로 확정된 뒤 온 pending 은 무시", (status, settled) => {
    store().apply(approval({ status: "pending" }));
    store().apply(approval({ status, ...settled }));
    store().apply(approval({ status: "pending" }));

    expect(view()?.approval).toMatchObject({ status, ...settled });
  });

  it("확정은 통째로 나중 것이 이긴다 — 허용 뒤 취소가 오면 앞 결정이 남지 않는다", () => {
    store().apply(approval({ status: "allowed", decision: "allow-once", reason: "user" }));
    store().apply(approval({ status: "cancelled", reason: "run-aborted" }));

    expect(view()?.approval).toMatchObject({ status: "cancelled", reason: "run-aborted" });
    expect(view()?.approval.decision).toBeUndefined();
  });

  it("같은 승인이 프레임 둘로 와도 카드는 하나 — 둘째 프레임이 toolCallId·urlPath 를 채운다", () => {
    // 실물은 전역 프레임(toolCallId 있음·urlPath 없음)과 세션 프레임(그 반대)을 함께 보낸다(p2-t6 보고서 C)
    store().apply(approval({ toolCallId: undefined, urlPath: "/approve/abc" }));
    store().apply(approval({ toolCallId: "toolu_77", urlPath: undefined }));

    expect(Object.keys(cards())).toEqual([APPROVAL]);
    expect(view()?.approval).toMatchObject({ toolCallId: "toolu_77", urlPath: "/approve/abc" });
  });

  it("병합은 이미 아는 값을 덮지 않는다 — 빈 자리만 메운다(FILLABLE 전부)", () => {
    // 뒤 프레임이 같은 자리에 **다른 값**을 싣고 와도 앞엣것이 남는다 — 확정 값(outcome)만 뒤엣것이 이긴다
    const first = {
      toolCallId: "toolu_first",
      runId: RUN,
      detail: "긴 인자",
      description: "짧은 인자",
      toolName: "Write",
      pluginId: "claude-cli",
      urlPath: "/approve/first",
    };
    store().apply(approval(first));
    store().apply(
      approval({
        toolCallId: "toolu_second",
        runId: RUN2,
        detail: undefined,
        description: "뒤에 온 인자",
        toolName: "Bash",
        pluginId: "other-plugin",
        urlPath: "/approve/second",
      }),
    );

    expect(view()?.approval).toMatchObject(first);
  });

  it("mergeApproval: 앞이 없으면 그대로", () => {
    const a = approval();
    expect(mergeApproval(undefined, a)).toBe(a);
  });

  it("syncPending 은 채널별로 나눠 담는다(구독 ack 의 pendingApprovals)", () => {
    store().syncPending(CH, [approval(), approval({ id: APPROVAL2, channelId: CH2 })]);

    expect(Object.keys(cards())).toEqual([APPROVAL]);
    expect(Object.keys(cards(CH2))).toEqual([APPROVAL2]);
  });

  it("setSending 은 누른 결정을 적고, 확정 사실이 오면 스스로 풀린다", () => {
    store().apply(approval());
    store().setSending(APPROVAL, "allow-once");
    expect(view()?.sending).toBe("allow-once");

    // ack 실패로 되돌릴 때
    store().setSending(APPROVAL, undefined);
    expect(view()?.sending).toBeUndefined();

    store().setSending(APPROVAL, "deny");
    store().apply(approval({ status: "denied", decision: "deny", reason: "user" }));
    expect(view()?.sending).toBeUndefined();
  });

  it("setSending 은 모르는 승인이면 아무것도 바꾸지 않는다", () => {
    store().apply(approval());
    const before = store().byChannel;
    store().setSending(uid(204), "deny");
    expect(store().byChannel).toBe(before);
  });

  it("아직 확정되지 않은 승인에는 잠금이 남는다 — 요구 프레임이 한 번 더 와도", () => {
    store().apply(approval());
    store().setSending(APPROVAL, "allow-once");
    store().apply(approval({ urlPath: "/approve/abc" }));
    expect(view()?.sending).toBe("allow-once");
  });

  /**
   * 재구독 ack 는 그 채널 미해결 승인의 정본이다(브라우저 검증 D8) — 끊긴 동안 놓친 확정이 옛 탭에
   * 미해결 카드로 남으면 버튼이 살아 있고 시간이 다하면 「만료됨」을 거짓으로 보인다
   */
  it("syncPending: ack 에 없는 로컬 pending 은 닫는다", () => {
    seed(approval(), approval({ id: APPROVAL2 }));

    store().syncPending(CH, [approval({ id: APPROVAL2 })]);

    expect(Object.keys(cards())).toEqual([APPROVAL2]);
    expect(view(APPROVAL2)?.approval.status).toBe("pending");
  });

  it("syncPending: 확정된 카드는 남긴다 — 그 탭의 기록이고 ack 에는 오지 않는다", () => {
    seed(approval({ status: "allowed", decision: "allow-once", reason: "user" }));
    seed(approval({ id: APPROVAL2, status: "expired", reason: "timeout" }));

    store().syncPending(CH, []);

    expect(Object.keys(cards())).toEqual([APPROVAL, APPROVAL2]);
    expect(view()?.approval.status).toBe("allowed");
  });

  it("syncPending: 다른 채널의 승인은 건드리지 않는다", () => {
    seed(approval(), approval({ id: APPROVAL2, channelId: CH2 }));

    store().syncPending(CH, []);

    expect(Object.keys(cards())).toEqual([]);
    expect(view(APPROVAL2, CH2)?.approval.status).toBe("pending");
  });

  it("syncPending: 바꿀 것이 없으면 스토어를 그대로 둔다", () => {
    seed(approval({ status: "allowed", decision: "allow-once", reason: "user" }));
    const before = store().byChannel;
    store().syncPending(CH, []);
    expect(store().byChannel).toBe(before);
  });

  it("reset 은 모든 채널을 비운다", () => {
    seed(approval(), approval({ id: APPROVAL2, channelId: CH2 }));
    store().reset();
    expect(store().byChannel).toEqual({});
  });
});

describe("선택자", () => {
  const early = approval({ id: APPROVAL, createdAt: "2027-01-15T08:00:00.000Z" });
  const late = approval({ id: APPROVAL2, createdAt: "2027-01-15T08:00:05.000Z", runId: RUN2 });

  it("selectChannelApprovals: 그 채널의 승인을 이른 것부터, 확정된 것도 함께", () => {
    seed(late, { ...early, status: "allowed" }, approval({ id: uid(203), channelId: CH2 }));

    expect(selectChannelApprovals(CH)(store()).map((v) => v.approval.id)).toEqual([APPROVAL, APPROVAL2]);
    expect(selectChannelApprovals(CH2)(store())).toHaveLength(1);
    expect(selectChannelApprovals("없는-채널")(store())).toEqual([]);
  });

  it("selectPendingApproval: 가장 이른 미해결 하나. runId 를 주면 그 런의 것만", () => {
    seed(early, late);
    expect(selectPendingApproval(CH)(store())?.approval.id).toBe(APPROVAL);
    expect(selectPendingApproval(CH, RUN2)(store())?.approval.id).toBe(APPROVAL2);

    // 앞엣것이 확정되면 다음 미해결로 넘어간다
    store().apply({ ...early, status: "allowed", decision: "allow-once" });
    expect(selectPendingApproval(CH)(store())?.approval.id).toBe(APPROVAL2);

    store().apply({ ...late, status: "expired", reason: "timeout" });
    expect(selectPendingApproval(CH)(store())).toBeUndefined();
  });
});

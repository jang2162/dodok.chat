import { type Agent, type Message, StoredComponentsV1 } from "@dodok/shared";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { AGENT, APPROVAL, approval, msg, uid } from "../../../test/fixtures";
import { authorsClient, DEV, renderWithClient } from "../../../test/messages";
import { useBundleExpansion } from "./bundleExpansion";
import { type BundleRun, computeBundles } from "./bundles";
import { ReplyBundle } from "./ReplyBundle";

const FIN = uid(12);
const FIN_AGENT: Agent = { ...DEV, id: FIN, handle: "fin", name: "Fin", providerAgentId: "fin" };
const [RA, RB] = [uid(301), uid(302)];
const root = msg(1, { bodyMd: "@dev @fin 봐줘" });
const R = root.id;
const reply = (seq: number, agentId: string, runId: string, over: Partial<Message> = {}) =>
  msg(seq, {
    authorType: "agent",
    authorId: agentId,
    runId,
    runRoot: { runId, agentId, rootMessageId: R, triggerMessageId: R },
    ...over,
  });
const CARD = StoredComponentsV1.parse({
  id: "cmp_1",
  blocks: [{ type: "actions", items: [{ type: "button", id: "ok", label: "확인" }] }],
});
const future = new Date(Date.now() + 3_600_000).toISOString();

function draw(items: Message[], runs: BundleRun[] = [], extra: { onApproval?: (id: string) => void } = {}) {
  const bundle = computeBundles(items, runs).get(R);
  if (!bundle) throw new Error("묶음이 없다");
  const byId = new Map(items.map((m) => [m.id, m]));
  const qc = authorsClient([DEV, FIN_AGENT]);
  const view = renderWithClient(<ReplyBundle bundle={bundle} messagesById={byId} {...extra} />, qc);
  const redraw = (next: Message[], nextRuns: BundleRun[] = runs) => {
    const b = computeBundles(next, nextRuns).get(R);
    if (!b) throw new Error("묶음이 없다");
    view.rerender(<ReplyBundle bundle={b} messagesById={new Map(next.map((m) => [m.id, m]))} {...extra} />);
  };
  return { ...view, redraw };
}
/** 줄 단추 — 이름은 「@핸들 …」로 시작한다(릴레이 줄의 「@dev → @fin」 에 걸리지 않게 앞에서 맞춘다) */
const lane = (handle: string) => screen.getByRole("button", { name: new RegExp(`^@${handle} `) });

beforeEach(() => {
  useBundleExpansion.getState().reset();
  useApprovalStore.getState().reset();
});

describe("ReplyBundle", () => {
  it("묶음은 이름 있는 group — 「@dev·@fin 답」", () => {
    draw([root, reply(2, AGENT, RA), reply(3, FIN, RB)]);
    expect(screen.getByRole("group", { name: "@dev·@fin 답" })).toBeInTheDocument();
  });

  it("줄은 접혀 있고 누르면 그 답을 펼친다", async () => {
    draw([root, reply(2, AGENT, RA, { bodyMd: "dev 의 답\n둘째 줄" }), reply(3, FIN, RB)]);
    const dev = lane("dev");
    expect(dev).toHaveAttribute("aria-expanded", "false");
    // 접힌 줄은 첫 줄 미리보기만
    expect(dev).toHaveTextContent("dev 의 답");
    expect(screen.queryByText("둘째 줄")).toBeNull();
    await userEvent.click(dev);
    expect(lane("dev")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/둘째 줄/)).toBeInTheDocument();
  });

  it("누를 수 있는 카드가 든 줄은 펼친 채, 소비된 카드면 접힘", () => {
    const live = reply(2, AGENT, RA, {
      components: CARD,
      componentState: { expiresAt: future, consumed: [] },
    });
    const used = reply(3, FIN, RB, {
      components: CARD,
      componentState: { expiresAt: future, consumed: ["ok"] },
    });
    draw([root, live, used]);
    expect(lane("dev")).toHaveAttribute("aria-expanded", "true");
    expect(lane("fin")).toHaveAttribute("aria-expanded", "false");
  });

  it("만료된 카드는 펼치지 않는다", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const expired = reply(2, AGENT, RA, {
      components: CARD,
      componentState: { expiresAt: past, consumed: [] },
    });
    draw([root, expired, reply(3, FIN, RB)]);
    expect(lane("dev")).toHaveAttribute("aria-expanded", "false");
  });

  it("진행 중 줄은 상태 문구", () => {
    draw([root, reply(2, AGENT, RA)], [{ runId: RB, agentId: FIN, rootMessageId: R, status: "tool" }]);
    expect(lane("fin")).toHaveTextContent("도구 사용 중");
  });

  it("error 런은 「실패」, aborted 는 「중지됨」", () => {
    draw(
      [root],
      [
        { runId: RA, agentId: AGENT, rootMessageId: R, status: "error" },
        { runId: RB, agentId: FIN, rootMessageId: R, status: "aborted" },
      ],
    );
    expect(lane("dev")).toHaveTextContent("실패");
    expect(lane("fin")).toHaveTextContent("중지됨");
  });

  it("릴레이 줄은 「@dev → @fin」", () => {
    const m = reply(2, AGENT, RA);
    const relayed = reply(3, FIN, RB, {
      runRoot: { runId: RB, agentId: FIN, rootMessageId: R, triggerMessageId: m.id },
    });
    draw([root, m, relayed]);
    expect(lane("fin")).toHaveTextContent("@dev → @fin");
    expect(lane("dev")).not.toHaveTextContent("→");
  });

  it("승인 대기 배지를 누르면 승인 행으로 스크롤", async () => {
    useApprovalStore.getState().apply(approval({ runId: RB, agentId: FIN }));
    const onApproval = vi.fn();
    draw(
      [root, reply(2, AGENT, RA)],
      [{ runId: RB, agentId: FIN, rootMessageId: R, status: "awaiting_approval" }],
      { onApproval },
    );
    // dev 줄에는 없다 — 그 런의 승인만
    expect(screen.getAllByRole("button", { name: /승인 카드로$/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "@fin 승인 대기 — 승인 카드로" }));
    expect(onApproval).toHaveBeenCalledWith(APPROVAL);
  });

  it("사람이 접은 줄은 카드가 있어도 다시 펼치지 않는다", async () => {
    const live = reply(2, AGENT, RA, {
      components: CARD,
      componentState: { expiresAt: future, consumed: [] },
    });
    const { redraw } = draw([root, live, reply(3, FIN, RB)]);
    await userEvent.click(lane("dev"));
    expect(lane("dev")).toHaveAttribute("aria-expanded", "false");
    // 같은 메시지가 새로 와도(갱신) 그대로
    redraw([root, { ...live, bodyMd: "고친 답" }, reply(3, FIN, RB)]);
    expect(lane("dev")).toHaveAttribute("aria-expanded", "false");
  });
});

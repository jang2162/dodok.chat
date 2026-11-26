import { type Agent, type Message, StoredComponentsV1 } from "@dodok/shared";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { setChannelSeq } from "@/realtime/timelineCache";
import { listKey, requestJump, useJumpStore } from "./jumpTarget";
import { MessageList } from "./MessageList";
import { emptyTimeline, threadFromPage } from "./timeline";
import { AGENT, APPROVAL, approval, CH, msg, uid } from "../../../test/fixtures";
import { authorsClient, DEV, renderWithClient } from "../../../test/messages";
import { stubScrollLayout } from "../../../test/scrollLayout";
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

  it("보고 있는 동안 카드가 만료되면 접힌 기본으로 돌아간다", async () => {
    const soon = new Date(Date.now() + 300).toISOString();
    const live = reply(2, AGENT, RA, { components: CARD, componentState: { expiresAt: soon, consumed: [] } });
    draw([root, live, reply(3, FIN, RB)]);
    expect(lane("dev")).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(lane("dev")).toHaveAttribute("aria-expanded", "false"), { timeout: 2_000 });
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

  it("에이전트 글이 부른 줄은 「@dev → @fin」, 사람 글이 부른 줄은 화살표 없음", () => {
    // 묶음 루트가 dev 의 글(부른 글 기준 2026-11-26) — 그 글이 부른 줄마다 부른 쪽을 적는다
    const agentRoot = msg(1, { authorType: "agent", authorId: AGENT, runId: uid(300), bodyMd: "@fin @dev" });
    const first = draw([agentRoot, reply(2, FIN, RB), reply(3, AGENT, RA)]);
    expect(lane("fin")).toHaveTextContent("@dev → @fin");
    first.unmount();
    draw([root, reply(2, AGENT, RA), reply(3, FIN, RB)]);
    expect(lane("dev")).not.toHaveTextContent("→");
    expect(lane("fin")).not.toHaveTextContent("→");
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

describe("ReplyBundle — 채널에도 보낸 답글의 묶음(답은 스레드에)", () => {
  const TROOT = msg(1, { bodyMd: "스레드 루트" });
  const ALSO = msg(5, { threadRootId: TROOT.id, alsoInChannel: true, bodyMd: "@dev @fin 봐줘" });
  const runOn = (runId: string, agentId: string, status: BundleRun["status"] = "streaming"): BundleRun => ({
    runId,
    agentId,
    rootMessageId: ALSO.id,
    triggerMessageId: ALSO.id,
    status,
  });
  const devAnswer = msg(6, {
    authorType: "agent",
    authorId: AGENT,
    runId: RA,
    threadRootId: TROOT.id,
    bodyMd: "dev 의 스레드 답\n둘째 줄",
  });
  function drawThread(withThreadCache: boolean) {
    const items = [TROOT, ALSO];
    const bundle = computeBundles(items, [runOn(RA, AGENT, "done"), runOn(RB, FIN)]).get(ALSO.id);
    if (!bundle) throw new Error("묶음이 없다");
    const qc = authorsClient([DEV, FIN_AGENT]);
    if (withThreadCache)
      qc.setQueryData(
        qk.thread(ALSO.channelId, ALSO.conversationId, TROOT.id),
        threadFromPage(undefined, TROOT, [ALSO, devAnswer], false),
      );
    return renderWithClient(
      <ReplyBundle bundle={bundle} messagesById={new Map(items.map((m) => [m.id, m]))} />,
      qc,
    );
  }
  const laneLink = (handle: string) => screen.getByRole("link", { name: new RegExp(`^@${handle} `) });

  beforeEach(() => useJumpStore.setState({ targets: {} }));

  it("머리 「@dev·@fin 답 · 스레드에서 진행」", () => {
    drawThread(false);
    expect(screen.getByRole("group", { name: "@dev·@fin 답 · 스레드에서 진행" })).toBeInTheDocument();
    expect(screen.getByText("@dev·@fin 답 · 스레드에서 진행")).toBeInTheDocument();
  });

  it("줄 미리보기: 스레드 캐시에 그 런의 메시지가 있으면 첫 줄, 없으면 상태 문구만", () => {
    const { unmount } = drawThread(true);
    expect(laneLink("dev")).toHaveTextContent("dev 의 스레드 답");
    expect(laneLink("dev")).not.toHaveTextContent("둘째 줄");
    unmount();
    drawThread(false);
    expect(laneLink("dev")).not.toHaveTextContent("dev 의 스레드 답");
    expect(laneLink("fin")).toHaveTextContent(/.+/);
  });

  it("줄을 누르면 펼치지 않고 그 스레드로 가 그 답으로 점프한다", async () => {
    const { router } = drawThread(true);
    const dev = laneLink("dev");
    expect(dev).toHaveAttribute("href", `/c/${ALSO.channelId}/s/${ALSO.conversationId}/t/${TROOT.id}`);
    expect(dev).not.toHaveAttribute("aria-expanded");
    await userEvent.click(dev);
    expect(useJumpStore.getState().targets[listKey(ALSO.conversationId, TROOT.id)]).toEqual({
      messageId: devAnswer.id,
      seq: devAnswer.seq,
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/c/${ALSO.channelId}/s/${ALSO.conversationId}/t/${TROOT.id}`,
      ),
    );
    expect(screen.queryByText(/둘째 줄/)).toBeNull();
  });
});

describe("ReplyBundle — 줄 안 하위 묶음·따라온 런(부른 글 기준 2026-11-26)", () => {
  const [C, D] = [uid(31), uid(32)];
  const [RC, RD] = [uid(331), uid(332)];
  const C_AGENT: Agent = { ...DEV, id: C, handle: "c", name: "C", providerAgentId: "c" };
  const D_AGENT: Agent = { ...DEV, id: D, handle: "d", name: "D", providerAgentId: "d" };
  const a = reply(2, AGENT, RA, { bodyMd: "dev 가 c·d 를 부른다" });
  const b = reply(3, FIN, RB);
  const called = (seq: number, agentId: string, runId: string, bodyMd: string) =>
    reply(seq, agentId, runId, {
      bodyMd,
      runRoot: { runId, agentId, rootMessageId: R, triggerMessageId: a.id },
    });
  function drawAll(items: Message[], runs: BundleRun[] = [], bubbleRunIds: string[] = []) {
    const bundles = computeBundles(items, runs);
    const bundle = bundles.get(R);
    if (!bundle) throw new Error("묶음이 없다");
    const qc = authorsClient([DEV, FIN_AGENT, C_AGENT, D_AGENT]);
    return renderWithClient(
      <ReplyBundle
        bundle={bundle}
        bundles={bundles}
        messagesById={new Map(items.map((m) => [m.id, m]))}
        bubbleRunIds={new Set(bubbleRunIds)}
        bubbles={(runId) => <p>버블 {runId}</p>}
      />,
      qc,
    );
  }

  it("펼친 줄 안 글이 하위 묶음 루트면 그 글 아래에 하위 묶음 group", async () => {
    drawAll([root, a, b, called(4, C, RC, "c 의 답"), called(5, D, RD, "d 의 답")]);
    // 바깥 줄을 펼치기 전에는 하위 묶음이 없다
    expect(screen.queryByRole("group", { name: "@c·@d 답" })).toBeNull();
    await userEvent.click(lane("dev"));
    const sub = screen.getByRole("group", { name: "@c·@d 답" });
    const outer = screen.getByRole("group", { name: "@dev·@fin 답" });
    expect(outer).toContainElement(sub);
    const aEl = screen.getByText("dev 가 c·d 를 부른다", { selector: "p" }).closest("[data-message-id]");
    expect(aEl).not.toBeNull();
    // 하위 묶음은 그 글 바로 뒤 — 강조 상자(그 글의 data-message-id) 밖
    expect(aEl?.contains(sub)).toBe(false);
    expect(aEl!.compareDocumentPosition(sub) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // c·d 의 답은 바깥 줄에 바로 그리지 않는다 — 하위 줄을 펼쳐야 보인다
    expect(screen.queryByText("c 의 답", { selector: "p" })).toBeNull();
    await userEvent.click(lane("c"));
    expect(screen.getByText("c 의 답", { selector: "p" })).toBeInTheDocument();
  });

  it("따라온 런이 스트리밍 중이면 그 줄 안에 버블", async () => {
    // dev 의 글이 c 하나만 불렀다 — c 의 런은 dev 줄을 따라간다
    drawAll(
      [root, a, b],
      [{ runId: RC, agentId: C, rootMessageId: R, triggerMessageId: a.id, status: "streaming" }],
      [RC],
    );
    expect(screen.queryByText(`버블 ${RC}`)).toBeNull();
    await userEvent.click(lane("dev"));
    const devLane = screen.getByText("dev 가 c·d 를 부른다", { selector: "p" }).closest("[data-run-id]");
    expect(devLane).toHaveAttribute("data-run-id", RA);
    expect(devLane).toContainElement(screen.getByText(`버블 ${RC}`));
    // fin 줄에는 없다
    await userEvent.click(lane("fin"));
    expect(screen.getAllByText(`버블 ${RC}`)).toHaveLength(1);
  });
});

describe("ReplyBundle — 하위 묶음 안 메시지로 결과로 가기", () => {
  const [C, D] = [uid(31), uid(32)];
  const [RC, RD] = [uid(331), uid(332)];
  const RECT = { width: 800, height: 600 };
  let restore: () => void;
  beforeEach(() => {
    restore = stubScrollLayout(RECT);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ code: "NOT_FOUND", message: "없음" }), { status: 404 }),
      ),
    );
  });
  afterEach(() => {
    restore();
    vi.unstubAllGlobals();
    useJumpStore.setState({ targets: {} });
  });

  it("바깥 줄과 하위 줄이 펼쳐지고 강조", async () => {
    const a = reply(2, AGENT, RA, { bodyMd: "dev 가 c·d 를 부른다" });
    const called = (seq: number, agentId: string, runId: string, bodyMd: string) =>
      reply(seq, agentId, runId, {
        bodyMd,
        runRoot: { runId, agentId, rootMessageId: R, triggerMessageId: a.id },
      });
    const target = called(5, D, RD, "d 의 답");
    const filler = Array.from({ length: 96 }, (_, i) => msg(6 + i, { bodyMd: `본문 ${6 + i}` }));
    const items = [root, a, reply(3, FIN, RB), called(4, C, RC, "c 의 답"), target, ...filler];
    const qc = authorsClient([
      DEV,
      FIN_AGENT,
      { ...DEV, id: C, handle: "c", name: "C", providerAgentId: "c" },
      { ...DEV, id: D, handle: "d", name: "D", providerAgentId: "d" },
    ]);
    qc.setQueryData(qk.timeline(CH, CH), {
      ...emptyTimeline(),
      items,
      hasOlder: false,
      lastSeq: items.at(-1)?.seq ?? 0,
    });
    setChannelSeq(qc, CH, items.at(-1)?.seq ?? 0);
    renderWithClient(<MessageList channelId={CH} conversationId={CH} initialRect={RECT} />, qc);
    // 묶음은 맨 위 — 처음에는 끝에 붙어 그려지지 않는다
    await waitFor(() => expect(screen.queryByRole("group", { name: /답$/ })).toBeNull());
    act(() => requestJump({ conversationId: CH, messageId: target.id, seq: target.seq }));
    await waitFor(() => expect(lane("dev")).toHaveAttribute("aria-expanded", "true"));
    await waitFor(() => expect(lane("d")).toHaveAttribute("aria-expanded", "true"));
    const lit = screen.getByText("d 의 답", { selector: "p" }).closest("[data-message-id]");
    expect(lit).toHaveAttribute("data-highlighted", "true");
    // 다른 줄은 그대로 접힘
    expect(lane("fin")).toHaveAttribute("aria-expanded", "false");
    expect(lane("c")).toHaveAttribute("aria-expanded", "false");
  });
});

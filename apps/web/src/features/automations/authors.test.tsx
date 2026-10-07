import type { AutomationSummary } from "@dodok/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { MessageItem } from "@/features/messages/MessageItem";
import { automationOf } from "../../../test/automationsServer";
import { msg } from "../../../test/fixtures";
import { ME_USER, authorsClient, renderWithClient } from "../../../test/messages";
import { json } from "../../../test/shellApi";

// 자동화 글의 작성자(자동화 스펙 「웹」 장, 계획 판정 PA6): admin 이상은 「⚙ 자동화 · <이름>」(목록 질의), 목록에 없으면
// 「⚙ 지운 자동화」, member 는 「⚙ 자동화」 — 목록 API 가 403 이라 부르지 않는다
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MORNING = automationOf(1, { name: "아침 점검" });
/** 글은 목록을 받기 전에 쓰였다 — 받은 목록에 없으면 지운 것이다 */
const POSTED = "2026-10-01T00:00:00.000Z";
const byAutomation = (id: string, createdAt = POSTED) =>
  msg(1, { authorType: "automation", authorId: id, createdAt });
const article = () => within(screen.getByRole("article"));

/** GET /automations 만 답한다 — `hold` 면 답을 붙잡아 둔다. 부른 수를 돌려준다 */
function stubList(list: AutomationSummary[], { hold = false } = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    if (url !== "/api/v1/automations") return json(404, { code: "NOT_FOUND", message: url });
    if (hold) await new Promise(() => {});
    return json(200, list);
  });
  vi.stubGlobal("fetch", fetch);
  return () => fetch.mock.calls.filter((c) => String(c[0]) === "/api/v1/automations").length;
}

function memberClient() {
  const qc = authorsClient();
  qc.setQueryData(qk.me, { ...ME_USER, role: "member" });
  return qc;
}

describe("자동화 작성자", () => {
  it("admin 은 목록을 받아 「⚙ 자동화 · <이름>」", async () => {
    const calls = stubList([MORNING]);
    renderWithClient(<MessageItem message={byAutomation(MORNING.id)} head />);
    expect(await article().findByText("⚙ 자동화 · 아침 점검")).toBeInTheDocument();
    expect(calls()).toBe(1);
  });

  it("목록에 없는 자동화는 「⚙ 지운 자동화」", async () => {
    stubList([MORNING]);
    renderWithClient(<MessageItem message={byAutomation(automationOf(9).id)} head />);
    expect(await article().findByText("⚙ 지운 자동화")).toBeInTheDocument();
  });

  it("목록을 받기 전에는 「⚙ 자동화」 — 지운 것으로 먼저 보이지 않는다", async () => {
    const calls = stubList([], { hold: true });
    renderWithClient(<MessageItem message={byAutomation(MORNING.id)} head />);
    await waitFor(() => expect(calls()).toBe(1));
    expect(article().getByText("⚙ 자동화")).toBeInTheDocument();
    expect(article().queryByText(/지운/)).toBeNull();
  });

  it("member 는 「⚙ 자동화」 — 목록을 부르지 않는다", async () => {
    const calls = stubList([MORNING]);
    renderWithClient(<MessageItem message={byAutomation(MORNING.id)} head />, memberClient());
    expect(article().getByText("⚙ 자동화")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls()).toBe(0);
    expect(article().getByText("⚙ 자동화")).toBeInTheDocument();
  });

  it("역할이 member 로 내려가면 받아 둔 목록이 남아 있어도 「⚙ 자동화」 — 이름도 「지운 자동화」도 보이지 않는다", async () => {
    const calls = stubList([MORNING]);
    const qc = memberClient();
    qc.setQueryData<AutomationSummary[]>(qk.automations, [MORNING]);
    renderWithClient(
      <>
        <MessageItem message={byAutomation(MORNING.id)} head />
        <MessageItem message={{ ...byAutomation(automationOf(9).id), id: automationOf(9).id }} head />
      </>,
      qc,
    );
    const [named, gone] = screen.getAllByRole("article");
    expect(within(named!).getByText("⚙ 자동화")).toBeInTheDocument();
    expect(within(gone!).getByText("⚙ 자동화")).toBeInTheDocument();
    expect(calls()).toBe(0);
  });

  it("받아 둔 목록이 그 글보다 앞이면 다시 받는다 — 다른 탭에서 만든 자동화가 「지운 자동화」로 보이지 않게", async () => {
    const calls = stubList([MORNING]);
    const qc = authorsClient();
    qc.setQueryData<AutomationSummary[]>(qk.automations, [], { updatedAt: Date.parse(POSTED) - 60_000 });
    renderWithClient(<MessageItem message={byAutomation(MORNING.id)} head />, qc);
    expect(article().queryByText("⚙ 지운 자동화")).toBeNull();
    expect(await article().findByText("⚙ 자동화 · 아침 점검")).toBeInTheDocument();
    expect(calls()).toBe(1);
  });

  it("받아 둔 목록이 그 글보다 뒤면 다시 받지 않는다 — 없으면 지운 것", async () => {
    const calls = stubList([MORNING]);
    const qc = authorsClient();
    qc.setQueryData<AutomationSummary[]>(qk.automations, []);
    renderWithClient(<MessageItem message={byAutomation(MORNING.id)} head />, qc);
    expect(article().getByText("⚙ 지운 자동화")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls()).toBe(0);
  });

  it("자동화 글에도 반응을 단다 — 「반응 추가」가 있다", () => {
    stubList([MORNING]);
    renderWithClient(<MessageItem message={byAutomation(MORNING.id)} head />);
    expect(article().getByRole("button", { name: "반응 추가" })).toBeInTheDocument();
  });
});

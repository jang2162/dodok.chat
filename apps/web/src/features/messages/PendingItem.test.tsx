import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { uploaded } from "../../../test/fakeXhr";
import { renderWithClient } from "../../../test/messages";
import { PendingActionsContext } from "./pendingActions";
import { PendingItem } from "./PendingItem";
import type { PendingMessage } from "./timeline";

vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: undefined, subscriptions: undefined }),
}));

const pending = (over: Partial<PendingMessage> = {}): PendingMessage => ({
  clientMsgId: "c-1",
  channelId: "ch",
  bodyMd: "보낼 말",
  createdAt: "2027-01-15T08:00:00.000Z",
  state: "sending",
  ...over,
});

it("첨부가 있으면 서버 경로로 격자를 그린다 — 보내는 중에는 크게 보기가 없다", () => {
  const a1 = uploaded(1, "첫.png");
  const a2 = uploaded(2, "둘.png");
  const { container } = renderWithClient(<PendingItem pending={pending({ attachments: [a1, a2] })} />);
  expect(screen.getByRole("img", { name: "첫.png" })).toHaveAttribute("src", `/api/v1/attachments/${a1.id}`);
  expect(screen.getByRole("img", { name: "둘.png" })).toHaveAttribute("src", `/api/v1/attachments/${a2.id}`);
  expect(container.querySelector("[data-slot=attachment-grid]")).not.toBeNull();
  expect(screen.queryByRole("button", { name: /크게 보기/ })).toBeNull();
  expect(screen.getByText("보낼 말")).toBeInTheDocument();
});

it("글 없는 이미지 메시지는 빈 본문 단락 없이 격자만", () => {
  const { container } = renderWithClient(
    <PendingItem pending={pending({ bodyMd: "", attachments: [uploaded(1)] })} />,
  );
  // 내용 칸: 머리 줄 다음 흐린 칸 — 그 안에 격자 하나뿐(빈 본문 없음)
  const faded = container.querySelector("article")?.children[1]?.children[1] as HTMLElement;
  expect(faded.children).toHaveLength(1);
  expect(faded.querySelector("[data-slot=attachment-grid]")).not.toBeNull();
});

it("첨부가 없으면 격자도 없다", () => {
  const { container } = renderWithClient(<PendingItem pending={pending()} />);
  expect(container.querySelector("[data-slot=attachment-grid]")).toBeNull();
});

it("레이트리밋으로 실패하면 「너무 빠르게 보내고 있습니다 — 잠시 뒤 다시」 — 다시 보내기는 그대로", () => {
  const retry = vi.fn();
  renderWithClient(
    <PendingActionsContext.Provider value={{ retry, discard: vi.fn() }}>
      <PendingItem pending={pending({ state: "failed", reason: "rate_limited" })} />
    </PendingActionsContext.Provider>,
  );
  expect(screen.getByText("너무 빠르게 보내고 있습니다 — 잠시 뒤 다시")).toBeInTheDocument();
  expect(screen.queryByText("전송 실패")).toBeNull();
  screen.getByRole("button", { name: "다시 보내기" }).click();
  expect(retry).toHaveBeenCalledWith("c-1");
});

it("그 밖의 실패는 「전송 실패」", () => {
  renderWithClient(<PendingItem pending={pending({ state: "failed" })} />);
  expect(screen.getByText("전송 실패")).toBeInTheDocument();
  expect(screen.queryByText(/너무 빠르게/)).toBeNull();
});

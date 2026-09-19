import { screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { CH, msg } from "../../../test/fixtures";
import { authorsClient, renderWithClient } from "../../../test/messages";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { MessageList } from "./MessageList";
import { emptyTimeline } from "./timeline";

// 본문 렌더러가 특정 메시지에서 던지게 한다 — 그 행만 대체 문구, 옆 행은 그대로
vi.mock("./MessageBody", () => ({
  MessageBody: ({ bodyMd }: { bodyMd: string }) => {
    if (bodyMd === "터지는 본문") throw new Error("render boom");
    return <p>{bodyMd}</p>;
  },
}));

let restore: () => void;
beforeEach(() => {
  restore = stubScrollLayout();
  // React 는 경계가 잡은 오류도 콘솔에 남긴다 — 테스트 출력만 조용히
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

it("한 메시지의 렌더 예외는 그 행만 「표시할 수 없는 메시지」로 바꾸고 옆 행은 그린다", async () => {
  const qc = authorsClient();
  const items = [
    msg(1, { bodyMd: "앞 메시지" }),
    msg(2, { bodyMd: "터지는 본문" }),
    msg(3, { bodyMd: "뒤 메시지" }),
  ];
  qc.setQueryData(qk.timeline(CH), { ...emptyTimeline(), items, lastSeq: 3 });
  renderWithClient(<MessageList channelId={CH} initialRect={{ width: 800, height: 600 }} />, qc);

  expect(await screen.findByText("표시할 수 없는 메시지")).toBeInTheDocument();
  expect(screen.getAllByText("표시할 수 없는 메시지")).toHaveLength(1);
  expect(screen.getByText("앞 메시지")).toBeInTheDocument();
  expect(screen.getByText("뒤 메시지")).toBeInTheDocument();
});

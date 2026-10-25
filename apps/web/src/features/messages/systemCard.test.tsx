import { ComponentsV1, type Message } from "@dodok/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createAppRouter } from "@/app/router";
import { useWireStatus } from "@/realtime/wire";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { msg, RUN, uid } from "../../../test/fixtures";
import { authorsClient, ME_USER } from "../../../test/messages";
import { SystemCard } from "./SystemCard";

// 「다시 실행」 테스트만 소켓을 쥔다
let fake: FakeSocket | undefined;
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: fake?.wire, subscriptions: undefined }),
}));
afterEach(() => {
  fake = undefined;
  useWireStatus.getState().setStatus("idle");
});

/** 라우터 문맥 안에 그린다 — owner 링크가 라우터 Link 다 */
function renderCard(message: Message, role?: string) {
  const qc = authorsClient();
  const { role: _owner, ...noRole } = ME_USER;
  qc.setQueryData(qk.me, role === undefined ? noRole : { ...ME_USER, role });
  const router = createAppRouter(qc, createMemoryHistory({ initialEntries: ["/"] }));
  render(
    <QueryClientProvider client={qc}>
      <RouterContextProvider router={router}>
        <SystemCard message={message} />
      </RouterContextProvider>
    </QueryClientProvider>,
  );
}

/** 서버(ops/budget)가 남기는 run_limit 카드 모양 */
const runLimit = (limit?: { scope: "channel" | "workspace"; limit: number }) =>
  msg(1, {
    kind: "system",
    authorType: "system",
    authorId: undefined,
    bodyMd: "오늘 런 한도(300)에 도달했습니다 — 내일 0시에 풀립니다",
    systemMeta: { kind: "run_limit", ...(limit ? { limit } : {}) },
  });

describe("run_limit 카드", () => {
  it("주의 모양 + 본문", () => {
    renderCard(runLimit({ scope: "workspace", limit: 300 }), "owner");
    const card = screen.getByRole("note");
    expect(card).toHaveAttribute("data-system-kind", "run_limit");
    expect(within(card).getByRole("img", { name: "주의" })).toBeInTheDocument();
    expect(card).toHaveTextContent("오늘 런 한도(300)에 도달했습니다");
  });

  it("owner 에게는 「운영에서 한도 바꾸기」 링크(/settings/operations)", () => {
    renderCard(runLimit({ scope: "workspace", limit: 300 }), "owner");
    const link = within(screen.getByRole("note")).getByRole("link", { name: "운영에서 한도 바꾸기" });
    expect(link).toHaveAttribute("href", "/settings/operations");
  });

  it("채널 한도(scope channel)면 그 채널 설정으로 — 「채널 설정에서 한도 바꾸기」", () => {
    const message = runLimit({ scope: "channel", limit: 5 });
    renderCard(message, "owner");
    const note = screen.getByRole("note");
    const link = within(note).getByRole("link", { name: "채널 설정에서 한도 바꾸기" });
    expect(link).toHaveAttribute("href", `/c/${message.channelId}/s/${message.channelId}/settings`);
    expect(within(note).queryByRole("link", { name: "운영에서 한도 바꾸기" })).not.toBeInTheDocument();
  });

  it("admin 에게도 링크 — 운영·채널 릴레이 정책은 admin 이상이 바꾼다(팀 스펙 2장)", () => {
    renderCard(runLimit({ scope: "workspace", limit: 300 }), "admin");
    expect(
      within(screen.getByRole("note")).getByRole("link", { name: "운영에서 한도 바꾸기" }),
    ).toBeInTheDocument();
  });

  it.each([["member"], [undefined]])("관리자가 아니면(%s) 링크가 없다", (role) => {
    renderCard(runLimit({ scope: "channel", limit: 5 }), role);
    expect(within(screen.getByRole("note")).queryByRole("link")).not.toBeInTheDocument();
  });

  it("systemMeta.limit 이 없으면 owner 에게도 링크가 없다", () => {
    renderCard(runLimit(), "owner");
    expect(within(screen.getByRole("note")).queryByRole("link")).not.toBeInTheDocument();
  });
});

// 서버(runs/orchestrator 의 RETRY_COMPONENTS)가 만드는 카드 모양 그대로 — 새로 그리는 것 없이 컴포넌트 렌더를 탄다.
// 그 id(retry_run)를 서버가 가로채 같은 트리거로 새 런을 만든다
describe("run_error 카드의 「다시 실행」", () => {
  const runError = () =>
    msg(2, {
      kind: "system",
      authorType: "system",
      authorId: undefined,
      bodyMd: "dev 의 실행이 실패했습니다 (TIMEOUT)",
      systemMeta: { kind: "run_error", runId: RUN },
      components: ComponentsV1.parse({
        id: "cmp_retry",
        ttlMs: 86_400_000,
        blocks: [
          {
            type: "actions",
            items: [{ type: "button", id: "retry_run", label: "다시 실행", style: "primary" }],
          },
        ],
      }),
      componentState: { expiresAt: "2999-01-01T00:00:00.000Z", consumed: [] },
    });

  it("오류 모양 안에 컴포넌트 버튼으로 보이고, 누르면 component.interact(retry_run)", async () => {
    fake = createFakeSocket();
    fake.onAck("component.interact", () => ({ ok: true, data: { interactionId: uid(500) } }));
    useWireStatus.getState().setStatus("connected");
    const message = runError();
    renderCard(message, "member");
    const card = screen.getByRole("note");
    expect(within(card).getByRole("img", { name: "오류" })).toBeInTheDocument();
    const button = within(card).getByRole("button", { name: "다시 실행" });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(fake.sentOf("component.interact")).toEqual([
      { messageId: message.id, componentId: "cmp_retry", itemId: "retry_run", values: {} },
    ]);
  });

  it("run_error 에는 한도 링크가 없다", () => {
    renderCard(runError(), "owner");
    expect(within(screen.getByRole("note")).queryByRole("link")).not.toBeInTheDocument();
  });
});

// 이 웹보다 새 서버가 늘린 kind — 화면이 깨지지 않고 정보 모양으로 그린다
it("모르는 kind 의 시스템 메시지는 정보 모양으로 그린다", () => {
  // 픽스처는 shared 스키마로 파싱하므로 모르는 kind 는 파싱 뒤에 얹는다
  const message = {
    ...msg(3, { kind: "system", authorType: "system", authorId: undefined, bodyMd: "새 서버가 보낸 알림" }),
    systemMeta: { kind: "future_kind" },
  } as unknown as Message;
  renderCard(message, "owner");
  const card = screen.getByRole("note");
  expect(card).toHaveAttribute("data-system-kind", "future_kind");
  expect(within(card).getByRole("img", { name: "정보" })).toBeInTheDocument();
  expect(card).toHaveTextContent("새 서버가 보낸 알림");
});

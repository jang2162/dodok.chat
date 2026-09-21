import { ComponentsV1, type Message } from "@dodok/shared";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWireStatus } from "@/realtime/wire";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { msg, uid, USER } from "../../../test/fixtures";
import { renderWithClient } from "../../../test/messages";
import { Components } from "./Components";
import { DISABLED_REASON_TEXT, type ItemState } from "./state";

// 소켓은 테스트가 쥔 가짜 — WireProvider 의 나머지(구독 훅 등)는 원본
let fake: FakeSocket | undefined;
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: fake?.wire, subscriptions: undefined }),
}));

const COMPONENT_ID = "cmp_1";
const FUTURE = "2999-01-01T00:00:00.000Z";

function withButtons(over: Partial<Message> = {}, blocks?: unknown[], extra: Record<string, unknown> = {}) {
  return msg(1, {
    kind: "system",
    authorType: "system",
    authorId: undefined,
    systemMeta: { kind: "relay_limit" },
    components: ComponentsV1.parse({
      id: COMPONENT_ID,
      blocks: blocks ?? [
        {
          type: "actions",
          items: [
            { type: "button", id: "continue_relay", label: "이어가기", style: "primary" },
            { type: "button", id: "stop", label: "그만", style: "danger", emoji: "✋" },
            { type: "button", id: "doc", label: "문서", url: "https://example.com/doc" },
          ],
        },
      ],
      ...extra,
    }),
    componentState: { expiresAt: FUTURE, consumed: [] },
    ...over,
  });
}

beforeEach(() => {
  fake = createFakeSocket();
  useWireStatus.getState().setStatus("connected");
});
afterEach(() => {
  fake = undefined;
  useWireStatus.getState().setStatus("idle");
  vi.restoreAllMocks();
});

// ── ActionButtons.test.tsx 에서 옮긴 것 ──────────────────────────────────────
describe("Components — 버튼", () => {
  it("누르면 component.interact { messageId, componentId, itemId, values: {} }", async () => {
    fake?.onAck("component.interact", () => ({ ok: true, data: { interactionId: uid(500) } }));
    const message = withButtons();
    renderWithClient(<Components message={message} />);
    await userEvent.click(screen.getByRole("button", { name: "이어가기" }));
    expect(fake?.sentOf("component.interact")).toEqual([
      { messageId: message.id, componentId: COMPONENT_ID, itemId: "continue_relay", values: {} },
    ]);
  });

  it("블록에 id 가 있으면 blockId 도 싣는다, 이모지는 이름 앞에", async () => {
    fake?.onAck("component.interact", () => ({ ok: true, data: { interactionId: uid(500) } }));
    const message = withButtons({}, [
      { type: "actions", id: "act", items: [{ type: "button", id: "ok", label: "좋아", emoji: "👍" }] },
    ]);
    renderWithClient(<Components message={message} />);
    await userEvent.click(screen.getByRole("button", { name: "👍 좋아" }));
    expect(fake?.sentOf("component.interact")).toEqual([
      { messageId: message.id, componentId: COMPONENT_ID, blockId: "act", itemId: "ok", values: {} },
    ]);
  });

  it("링크 버튼은 새 탭 링크이고 interact 를 보내지 않는다", async () => {
    renderWithClient(<Components message={withButtons()} />);
    const link = screen.getByRole("link", { name: "문서" });
    expect(link).toHaveAttribute("href", "https://example.com/doc");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("button", { name: "문서" })).toBeNull();
    // jsdom 은 새 탭 이동을 하지 않는다 — 누르는 것만으로 보내는 것이 없는지 본다
    link.addEventListener("click", (e) => e.preventDefault());
    await userEvent.click(link);
    expect(fake?.sentOf("component.interact")).toEqual([]);
  });

  it("소비된 아이템·만료된 메시지·allowedUsers 밖이면 비활성", () => {
    const { unmount } = renderWithClient(
      <Components message={withButtons({ componentState: { expiresAt: FUTURE, consumed: ["stop"] } })} />,
    );
    expect(screen.getByRole("button", { name: "이어가기" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "✋ 그만" })).toBeDisabled();
    unmount();

    const expired = withButtons({ componentState: { expiresAt: "2020-01-01T00:00:00.000Z", consumed: [] } });
    const second = renderWithClient(<Components message={expired} />);
    expect(screen.getByRole("button", { name: "이어가기" })).toBeDisabled();
    second.unmount();

    const only = (users: string[]) =>
      withButtons({}, [
        { type: "actions", items: [{ type: "button", id: "ok", label: "좋아", allowedUsers: users }] },
      ]);
    const third = renderWithClient(<Components message={only([uid(99)])} />);
    expect(screen.getByRole("button", { name: "좋아" })).toBeDisabled();
    third.unmount();
    renderWithClient(<Components message={only([USER])} />);
    expect(screen.getByRole("button", { name: "좋아" })).toBeEnabled();
  });

  it("소켓이 없거나 wire 가 연결되지 않았으면 비활성", () => {
    useWireStatus.getState().setStatus("reconnecting");
    const { unmount } = renderWithClient(<Components message={withButtons()} />);
    expect(screen.getByRole("button", { name: "이어가기" })).toBeDisabled();
    unmount();
    useWireStatus.getState().setStatus("connected");
    fake = undefined;
    renderWithClient(<Components message={withButtons()} />);
    expect(screen.getByRole("button", { name: "이어가기" })).toBeDisabled();
  });

  it.each([
    ["CONSUMED", "이미 처리된 버튼입니다"],
    ["EXPIRED", "만료된 버튼입니다"],
    ["FORBIDDEN", "이 버튼을 누를 권한이 없습니다"],
    ["VALIDATION", "처리할 수 없는 요청입니다"],
  ] as const)("ack %s → 토스트 「%s」", async (code, text) => {
    const error = vi.spyOn(toast, "error");
    fake?.onAck("component.interact", () => ({ ok: false, error: { code, message: "server says" } }));
    renderWithClient(<Components message={withButtons()} />);
    await userEvent.click(screen.getByRole("button", { name: "이어가기" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(text));
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("ack 이 없으면(TIMEOUT) 「서버 응답이 없습니다」, 표에 없는 코드는 서버 message", async () => {
    const error = vi.spyOn(toast, "error");
    renderWithClient(<Components message={withButtons()} />);
    // 대본이 없으면 가짜 소켓의 emitWithAck 가 던진다 = 시간 초과
    await userEvent.click(screen.getByRole("button", { name: "이어가기" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("서버 응답이 없습니다"));
    fake?.onAck("component.interact", () => ({ ok: false, error: { code: "INTERNAL", message: "터졌다" } }));
    await userEvent.click(screen.getByRole("button", { name: "이어가기" }));
    await waitFor(() => expect(error).toHaveBeenLastCalledWith("터졌다"));
  });

  it("응답을 기다리는 동안 그 버튼은 비활성(두 번 보내지 않음)", async () => {
    let answer: (v: unknown) => void = () => {};
    fake?.onAck("component.interact", () => new Promise((r) => (answer = r)) as never);
    renderWithClient(<Components message={withButtons()} />);
    const button = screen.getByRole("button", { name: "이어가기" });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(fake?.sentOf("component.interact")).toHaveLength(1);
    answer({ ok: true, data: { interactionId: uid(500) } });
    await waitFor(() => expect(button).toBeEnabled());
  });

  // 옛 테스트는 「셀렉트·그 밖의 블록은 자리표시 문구」였다 — 자리표시는 없어지고(뒤 태스크가 그린다) 버튼은 그대로 그린다
  it("버튼 아닌 블록이 섞여도 버튼 줄은 그리고, 옛 자리표시 문구는 없다", () => {
    const message = withButtons({}, [
      { type: "section", text: "설명" },
      { type: "actions", items: [{ type: "button", id: "ok", label: "좋아" }] },
      { type: "actions", items: [{ type: "select", id: "pick", options: [{ value: "a", label: "A" }] }] },
      { type: "separator" },
    ]);
    renderWithClient(<Components message={message} />);
    expect(screen.getByRole("button", { name: "좋아" })).toBeEnabled();
    expect(screen.queryByText(/Phase 2 에서 지원/)).toBeNull();
  });
});

// ── 이 태스크가 더한 것 ─────────────────────────────────────────────────────
describe("Components — 카드와 비활성 사유", () => {
  it("components 가 없으면 아무것도 그리지 않는다", () => {
    const { container } = renderWithClient(<Components message={msg(1)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each<[string, Partial<Message>, string]>([
    ["소비", { componentState: { expiresAt: FUTURE, consumed: ["continue_relay"] } }, "이미 처리되었습니다"],
    ["만료", { componentState: { expiresAt: "2020-01-01T00:00:00.000Z", consumed: [] } }, "만료되었습니다"],
  ])("비활성 사유(%s)를 회색으로만 두지 않고 title·설명으로 말한다", (_, over, text) => {
    renderWithClient(<Components message={withButtons(over)} />);
    const button = screen.getByRole("button", { name: "이어가기" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", text);
    expect(button).toHaveAccessibleDescription(text);
  });

  it("연결이 끊겨 비활성이면 그 사유를 말한다", () => {
    useWireStatus.getState().setStatus("reconnecting");
    renderWithClient(<Components message={withButtons()} />);
    expect(screen.getByRole("button", { name: "이어가기" })).toHaveAccessibleDescription(
      "연결이 끊겨 지금은 보낼 수 없습니다",
    );
  });

  it("allowedUsers 밖이면 권한 사유를 말한다", () => {
    const message = withButtons({}, [
      { type: "actions", items: [{ type: "button", id: "ok", label: "좋아", allowedUsers: [uid(99)] }] },
    ]);
    renderWithClient(<Components message={message} />);
    expect(screen.getByRole("button", { name: "좋아" })).toHaveAccessibleDescription(
      "이 항목을 쓸 권한이 없습니다",
    );
  });

  // toHaveAccessibleDescription 은 aria-describedby 가 없는 id 를 가리키면 title 로 대신 계산한다 —
  // 그래서 DisabledHint 가 실제로 그 문구를 내는지는 가리키는 요소를 꺼내 따로 잰다
  it.each<[NonNullable<ItemState["reason"]>, string, () => Promise<string>]>([
    [
      "consumed",
      "이미 처리되었습니다",
      async () => {
        const over = { componentState: { expiresAt: FUTURE, consumed: ["continue_relay"] } };
        renderWithClient(<Components message={withButtons(over)} />);
        return "이어가기";
      },
    ],
    [
      "expired",
      "만료되었습니다",
      async () => {
        const over = { componentState: { expiresAt: "2020-01-01T00:00:00.000Z", consumed: [] } };
        renderWithClient(<Components message={withButtons(over)} />);
        return "이어가기";
      },
    ],
    [
      "disconnected",
      "연결이 끊겨 지금은 보낼 수 없습니다",
      async () => {
        useWireStatus.getState().setStatus("reconnecting");
        renderWithClient(<Components message={withButtons()} />);
        return "이어가기";
      },
    ],
    [
      "forbidden",
      "이 항목을 쓸 권한이 없습니다",
      async () => {
        const blocks = [
          { type: "actions", items: [{ type: "button", id: "ok", label: "좋아", allowedUsers: [uid(99)] }] },
        ];
        renderWithClient(<Components message={withButtons({}, blocks)} />);
        return "좋아";
      },
    ],
    [
      "busy",
      "보내는 중입니다",
      async () => {
        fake?.onAck("component.interact", () => new Promise(() => {}) as never);
        renderWithClient(<Components message={withButtons()} />);
        await userEvent.click(screen.getByRole("button", { name: "이어가기" }));
        return "이어가기";
      },
    ],
  ])("비활성 사유 %s — aria-describedby 가 가리키는 힌트가 「%s」를 낸다", async (reason, text, setup) => {
    const button = screen.getByRole("button", { name: await setup() });
    expect(button).toBeDisabled();
    const id = button.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const hint = document.getElementById(id ?? "");
    expect(hint).not.toBeNull();
    expect(hint).not.toBe(button);
    expect(hint?.textContent).toBe(text);
    expect(text).toBe(DISABLED_REASON_TEXT[reason]);
  });

  it("눌리는 버튼에는 사유가 붙지 않는다", () => {
    renderWithClient(<Components message={withButtons()} />);
    const button = screen.getByRole("button", { name: "이어가기" });
    expect(button).not.toHaveAttribute("title");
    expect(button).not.toHaveAttribute("aria-describedby");
  });

  it("reusable 카드는 소비된 아이템도 다시 누를 수 있다", () => {
    const message = withButtons(
      { componentState: { expiresAt: FUTURE, consumed: ["continue_relay"] } },
      undefined,
      {
        reusable: true,
      },
    );
    renderWithClient(<Components message={message} />);
    expect(screen.getByRole("button", { name: "이어가기" })).toBeEnabled();
  });

  it("서버가 아직 id 를 주지 않은 카드는 누를 수 없다", () => {
    const noId = withButtons({
      components: ComponentsV1.parse({
        blocks: [{ type: "actions", items: [{ type: "button", id: "continue_relay", label: "이어가기" }] }],
      }),
    });
    renderWithClient(<Components message={noId} />);
    expect(screen.getByRole("button", { name: "이어가기" })).toBeDisabled();
  });

  it("버튼 블록이 여럿이면 블록마다 한 줄, 배열 순서대로", () => {
    const message = withButtons({}, [
      { type: "actions", items: [{ type: "button", id: "a", label: "첫째" }] },
      { type: "actions", items: [{ type: "button", id: "b", label: "둘째" }] },
    ]);
    const { container } = renderWithClient(<Components message={message} />);
    const rows = container.querySelectorAll("[data-slot=actions]");
    expect(Array.from(rows, (r) => r.textContent)).toEqual(["첫째", "둘째"]);
  });
});

describe("Components — 만료 시계", () => {
  const NOW = Date.parse("2030-01-01T00:00:00.000Z");
  const MAX_TIMER_MS = 2_147_483_647;
  const at = (ms: number) => ({
    componentState: { expiresAt: new Date(NOW + ms).toISOString(), consumed: [] },
  });
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  // 스파이는 가짜 시계 위에 걸렸다 — 바깥 restoreAllMocks 가 시계를 거둔 뒤 돌면 가짜 setTimeout 을 되살린다
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("열려 있는 동안 만료 시각이 지나면 다시 그려 비활성·「만료되었습니다」", () => {
    renderWithClient(<Components message={withButtons(at(1234))} />);
    const button = screen.getByRole("button", { name: "이어가기" });
    act(() => vi.advanceTimersByTime(1233));
    expect(button).toBeEnabled();
    act(() => vi.advanceTimersByTime(1));
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "만료되었습니다");
  });

  it("setTimeout 상한(약 24.8일)을 넘는 먼 만료에는 타이머를 걸지 않는다 — 걸면 넘쳐서 곧바로 만료로 보인다", () => {
    const set = vi.spyOn(globalThis, "setTimeout");
    renderWithClient(<Components message={withButtons(at(MAX_TIMER_MS + 60_000))} />);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("button", { name: "이어가기" })).toBeEnabled();
    expect(set.mock.calls.filter(([, ms]) => (ms ?? 0) > MAX_TIMER_MS)).toEqual([]);
  });

  it("언마운트하면 만료 타이머를 거둔다", () => {
    const set = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = renderWithClient(<Components message={withButtons(at(1234))} />);
    const i = set.mock.calls.findIndex(([, ms]) => ms === 1234);
    expect(i).toBeGreaterThanOrEqual(0);
    const timer: unknown = set.mock.results[i]?.value;
    expect(clear).not.toHaveBeenCalledWith(timer);
    unmount();
    expect(clear).toHaveBeenCalledWith(timer);
  });
});

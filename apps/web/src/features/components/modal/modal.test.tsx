import { ComponentsV1, type Message } from "@dodok/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWireStatus } from "@/realtime/wire";
import { createFakeSocket, type FakeSocket } from "../../../../test/fakeSocket";
import { msg, uid, USER } from "../../../../test/fixtures";
import { renderWithClient } from "../../../../test/messages";
import { Components } from "../Components";
import { DISABLED_REASON_TEXT } from "../state";

// 소켓은 테스트가 쥔 가짜 — WireProvider 의 나머지(구독 훅 등)는 원본
let fake: FakeSocket | undefined;
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: fake?.wire, subscriptions: undefined }),
}));

const COMPONENT_ID = "cmp_1";
const FUTURE = "2999-01-01T00:00:00.000Z";
const OK = { ok: true, data: { interactionId: uid(500) } } as const;
const OPTS = [
  { value: "hi", label: "높음" },
  { value: "lo", label: "낮음" },
];

const BASE_MODAL = {
  id: "form",
  title: "새 작업",
  triggerLabel: "작업 만들기",
  fields: [{ type: "text", id: "title", label: "제목", required: true }],
};

/** 모달 하나를 단 카드. fields 를 주면 그것으로 바꾼다 */
function withModal(
  modal: Record<string, unknown> = {},
  over: Partial<Message> = {},
  extra: Record<string, unknown> = {},
) {
  return msg(1, {
    components: ComponentsV1.parse({ id: COMPONENT_ID, modal: { ...BASE_MODAL, ...modal }, ...extra }),
    componentState: { expiresAt: FUTURE, consumed: [] },
    ...over,
  });
}

const trigger = () => screen.getByRole("button", { name: "작업 만들기" });
async function open() {
  await userEvent.click(trigger());
  return screen.findByRole("dialog", { name: "새 작업" });
}
const submit = (dialog: HTMLElement) => userEvent.click(within(dialog).getByRole("button", { name: "제출" }));
const sentValues = () => fake?.sentOf("component.interact").map((p) => (p as { values: unknown }).values);

/** 브라우저는 못 읽는 입력(number 의 「e」, date 의 「02/31」)에 value 를 "" 로 두고 validity.badInput 을 켠다 — jsdom 은 몰라서 흉내 낸다 */
function setBadInput(input: HTMLElement, badInput: boolean) {
  Object.defineProperty(input, "validity", { configurable: true, value: { badInput } });
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

describe("모달 — 트리거와 대화상자", () => {
  it("트리거 버튼은 triggerLabel 로 그리고, 누르면 대화상자가 제목과 함께 열린다", async () => {
    renderWithClient(<Components message={withModal()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    const dialog = await open();
    expect(within(dialog).getByRole("heading", { name: "새 작업" })).toBeVisible();
    // Radix Dialog 가 초점을 안으로 가져간다 — 첫 칸
    expect(within(dialog).getByLabelText("제목")).toHaveFocus();
  });

  it("트리거는 블록들 아래 한 줄이다", () => {
    const message = withModal(
      {},
      {},
      { blocks: [{ type: "actions", items: [{ type: "button", id: "ok", label: "확인" }] }] },
    );
    renderWithClient(<Components message={message} />);
    const [first, second] = screen.getAllByRole("button");
    expect(first).toHaveAccessibleName("확인");
    expect(second).toBe(trigger());
  });

  it("modal 이 없으면 트리거를 그리지 않는다", () => {
    const message = msg(1, {
      components: ComponentsV1.parse({
        id: COMPONENT_ID,
        blocks: [{ type: "actions", items: [{ type: "button", id: "ok", label: "확인" }] }],
      }),
      componentState: { expiresAt: FUTURE, consumed: [] },
    });
    renderWithClient(<Components message={message} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("Esc 로 닫으면 초점이 트리거로 돌아온다 — Radix Dialog 가 한다", async () => {
    renderWithClient(<Components message={withModal()} />);
    await open();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger()).toHaveFocus();
  });

  it("「취소」로 닫고 다시 열면 처음 값으로 돌아간다", async () => {
    renderWithClient(<Components message={withModal()} />);
    let dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("제목"), "쓰다 만 것");
    await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    dialog = await open();
    expect(within(dialog).getByLabelText("제목")).toHaveValue("");
  });

  it("다시 열면 지난 제출의 오류도 지워져 있다 — 칸 아래도 하단 줄도", async () => {
    fake?.onAck("component.interact", () => ({
      ok: false,
      error: { code: "EXPIRED", message: "component expired" },
    }));
    renderWithClient(<Components message={withModal()} />);
    const close = async (dialog: HTMLElement) => {
      await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    };
    // 칸 아래 오류
    let dialog = await open();
    await submit(dialog);
    expect(within(dialog).getByLabelText("제목")).toHaveAccessibleDescription("필수 항목입니다");
    await close(dialog);
    dialog = await open();
    expect(within(dialog).getByLabelText("제목")).not.toHaveAttribute("aria-describedby");
    expect(within(dialog).queryByText("필수 항목입니다")).toBeNull();
    // 하단 줄
    await userEvent.type(within(dialog).getByLabelText("제목"), "보고서");
    await submit(dialog);
    expect(await within(dialog).findByText("만료된 버튼입니다")).toBeVisible();
    await close(dialog);
    dialog = await open();
    expect(within(dialog).queryByText("만료된 버튼입니다")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "제출" })).not.toHaveAttribute("aria-describedby");
  });
});

describe("모달 — 필드 7종", () => {
  it("필드 7종이 각자 위젯으로 그려진다", async () => {
    const message = withModal({
      fields: [
        { type: "text", id: "t", label: "제목", placeholder: "무엇을" },
        { type: "textarea", id: "ta", label: "본문" },
        { type: "number", id: "n", label: "개수", min: 1, max: 5, step: 1 },
        { type: "date", id: "d", label: "마감" },
        { type: "select", id: "s", label: "태그", multi: true, options: OPTS },
      ],
    });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    const text = within(dialog).getByRole("textbox", { name: "제목" });
    expect(text.tagName).toBe("INPUT");
    expect(text).toHaveAttribute("placeholder", "무엇을");
    expect(text).not.toBeRequired();
    expect(within(dialog).getByRole("textbox", { name: "본문" }).tagName).toBe("TEXTAREA");
    const number = within(dialog).getByRole("spinbutton", { name: "개수" });
    expect(number).toHaveAttribute("min", "1");
    expect(number).toHaveAttribute("max", "5");
    expect(within(dialog).getByLabelText("마감")).toHaveAttribute("type", "date");
    const tags = within(dialog).getByRole("group", { name: "태그" });
    expect(within(tags).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(tags).queryAllByRole("radio")).toEqual([]);
  });

  it("checkbox·radio·단일 select 도 각자 위젯으로 그려진다", async () => {
    const message = withModal({
      fields: [
        { type: "checkbox", id: "c", label: "동의" },
        { type: "radio", id: "r", label: "우선순위", options: OPTS },
        { type: "select", id: "s", label: "형식", options: OPTS },
      ],
    });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    expect(within(dialog).getByRole("checkbox", { name: "동의" })).not.toBeChecked();
    const radio = within(dialog).getByRole("group", { name: "우선순위" });
    expect(within(radio).getAllByRole("radio")).toHaveLength(2);
    const single = within(dialog).getByRole("group", { name: "형식" });
    expect(within(single).getAllByRole("radio")).toHaveLength(2);
    expect(within(single).queryAllByRole("checkbox")).toEqual([]);
  });

  it("select·radio 의 이름은 legend 하나뿐이다 — ui/label 을 겹쳐 달지 않는다", async () => {
    const message = withModal({
      fields: [
        { type: "radio", id: "r", label: "우선순위", options: OPTS },
        { type: "select", id: "s", label: "태그", multi: true, options: OPTS },
      ],
    });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    for (const name of ["우선순위", "태그"]) {
      expect(within(dialog).getAllByText(name)).toHaveLength(1);
      expect(within(dialog).getByText(name).tagName).toBe("LEGEND");
    }
  });

  it("default 가 초깃값으로 채워진다", async () => {
    const message = withModal({
      fields: [
        { type: "text", id: "t", label: "제목", default: "보고서" },
        { type: "number", id: "n", label: "개수", default: 3 },
        { type: "date", id: "d", label: "마감", default: "2026-09-30" },
        { type: "checkbox", id: "c", label: "동의", default: true },
        { type: "radio", id: "r", label: "우선순위", options: OPTS, default: "lo" },
      ],
    });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    expect(within(dialog).getByLabelText("제목")).toHaveValue("보고서");
    expect(within(dialog).getByLabelText("개수")).toHaveValue(3);
    expect(within(dialog).getByLabelText("마감")).toHaveValue("2026-09-30");
    expect(within(dialog).getByRole("checkbox", { name: "동의" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "낮음" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "높음" })).not.toBeChecked();
  });

  it("textarea·select 의 default 도 채워진다", async () => {
    const message = withModal({
      fields: [
        { type: "textarea", id: "ta", label: "본문", default: "첫 줄" },
        { type: "select", id: "s", label: "태그", multi: true, options: OPTS, default: ["hi"] },
      ],
    });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    expect(within(dialog).getByLabelText("본문")).toHaveValue("첫 줄");
    expect(within(dialog).getByRole("checkbox", { name: "높음" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "낮음" })).not.toBeChecked();
  });
});

describe("모달 — 제출", () => {
  it("제출하면 values: { fields: {...} } 로 나가고 성공하면 닫힌다", async () => {
    fake?.onAck("component.interact", () => OK);
    const message = withModal({
      fields: [
        { type: "text", id: "t", label: "제목", required: true },
        { type: "number", id: "n", label: "개수" },
        { type: "select", id: "s", label: "태그", multi: true, options: OPTS },
        { type: "checkbox", id: "c", label: "동의" },
        { type: "radio", id: "r", label: "우선순위", options: OPTS },
      ],
    });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("제목"), "보고서");
    await userEvent.type(within(dialog).getByLabelText("개수"), "4");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "낮음" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "동의" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: "높음" }));
    await submit(dialog);
    expect(fake?.sentOf("component.interact")).toEqual([
      {
        messageId: message.id,
        componentId: COMPONENT_ID,
        itemId: "form",
        values: { fields: { t: "보고서", n: 4, s: ["lo"], c: true, r: "hi" } },
      },
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("비워 둔 선택 칸은 싣지 않는다 — 체크박스의 false 는 싣는다", async () => {
    fake?.onAck("component.interact", () => OK);
    const message = withModal({
      fields: [
        { type: "text", id: "t", label: "제목" },
        { type: "date", id: "d", label: "마감" },
        { type: "checkbox", id: "c", label: "동의" },
      ],
    });
    renderWithClient(<Components message={message} />);
    await submit(await open());
    expect(fake?.sentOf("component.interact")).toMatchObject([{ values: { fields: { c: false } } }]);
  });

  it("Enter 로도 제출한다", async () => {
    fake?.onAck("component.interact", () => OK);
    renderWithClient(<Components message={withModal()} />);
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("제목"), "보고서{Enter}");
    expect(fake?.sentOf("component.interact")).toMatchObject([{ values: { fields: { title: "보고서" } } }]);
  });

  it("required 를 비우고 제출하면 보내지 않고 칸 아래 오류가 뜬다", async () => {
    fake?.onAck("component.interact", () => OK);
    renderWithClient(<Components message={withModal()} />);
    const dialog = await open();
    const title = within(dialog).getByLabelText("제목");
    expect(title).toBeRequired();
    // 오류 자리는 비어 있는 채로 늘 있고, 오류가 없으면 칸이 가리키지 않는다(field-error 관습)
    expect(title).not.toHaveAttribute("aria-describedby");
    expect(title).not.toHaveAttribute("aria-invalid");
    await submit(dialog);
    expect(fake?.sentOf("component.interact")).toEqual([]);
    expect(within(dialog).getByText("필수 항목입니다")).toBeVisible();
    expect(title).toHaveAccessibleDescription("필수 항목입니다");
    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("오류 자리는 제출 전부터 비어 있는 라이브 영역으로 있다", async () => {
    renderWithClient(<Components message={withModal()} />);
    const dialog = await open();
    const regions = dialog.querySelectorAll("[data-slot=field-error]");
    // 칸 하나 + 하단 한 줄
    expect(regions).toHaveLength(2);
    for (const r of regions) {
      expect(r).toHaveAttribute("aria-live", "polite");
      expect(r).toBeEmptyDOMElement();
    }
  });

  it("범위를 벗어난 number 는 보내지 않고 칸 아래에 까닭을 보인다", async () => {
    fake?.onAck("component.interact", () => OK);
    const message = withModal({ fields: [{ type: "number", id: "n", label: "개수", min: 1, max: 5 }] });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("개수"), "9");
    await submit(dialog);
    expect(fake?.sentOf("component.interact")).toEqual([]);
    expect(within(dialog).getByLabelText("개수")).toHaveAccessibleDescription("5 이하여야 합니다");
  });

  it.each(["e", "-"])(
    "빈 number 칸에 못 읽는 「%s」를 치면 비었다고 보지 않고 막는다 — 지우면 오류가 내려가고 다시 보낼 수 있다",
    async (typed) => {
      fake?.onAck("component.interact", () => OK);
      // 선택 칸 — 막지 않으면 사용자가 친 것이 소리 없이 빠진 채 나간다
      const message = withModal({ fields: [{ type: "number", id: "n", label: "개수" }] });
      renderWithClient(<Components message={message} />);
      const dialog = await open();
      const input = within(dialog).getByLabelText("개수");
      setBadInput(input, true);
      await userEvent.type(input, typed);
      // value 는 "" 그대로다 — React 의 onChange 가 안 불리는 자리
      expect(input).toHaveValue(null);
      await submit(dialog);
      expect(sentValues()).toEqual([]);
      expect(input).toHaveAccessibleDescription("숫자를 입력하세요");
      // 지워도 value 는 "" 그대로 — 브라우저는 input 만 낸다
      setBadInput(input, false);
      await userEvent.type(input, "{Backspace}");
      expect(input).not.toHaveAttribute("aria-describedby");
      await submit(dialog);
      expect(sentValues()).toEqual([{ fields: {} }]);
    },
  );

  it("값이 있던 number 칸도 못 읽게 고치면(「3」→「3e」) 막고, 되돌리면 그 값으로 보낸다", async () => {
    fake?.onAck("component.interact", () => OK);
    const message = withModal({ fields: [{ type: "number", id: "n", label: "개수", default: 3 }] });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    const input = within(dialog).getByLabelText("개수");
    setBadInput(input, true);
    await userEvent.type(input, "e");
    await submit(dialog);
    expect(sentValues()).toEqual([]);
    expect(input).toHaveAccessibleDescription("숫자를 입력하세요");
    setBadInput(input, false);
    await userEvent.type(input, "{Backspace}");
    await submit(dialog);
    expect(sentValues()).toEqual([{ fields: { n: 3 } }]);
  });

  it("키로 끝까지 친 날짜가 그대로 나간다 — 마지막 키를 뗀 것(keyup)이 칸 값을 지우지 않는다", async () => {
    fake?.onAck("component.interact", () => OK);
    const message = withModal({ fields: [{ type: "date", id: "d", label: "마감" }] });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    // keyup 이 칸 값(e.currentTarget.value)을 읽는다 — 그 출처가 바뀌면 완성한 날짜가 마지막 keyup 에 지워진다(c2-t4 재리뷰 D7)
    await userEvent.type(within(dialog).getByLabelText("마감"), "2026-09-30");
    await submit(dialog);
    expect(sentValues()).toEqual([{ fields: { d: "2026-09-30" } }]);
  });

  it("빈 date 칸의 부분 입력도 막는다 — 이벤트가 하나도 안 와도, 지우면 다시 보낼 수 있다", async () => {
    fake?.onAck("component.interact", () => OK);
    const message = withModal({ fields: [{ type: "date", id: "d", label: "마감" }] });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    const input = within(dialog).getByLabelText("마감");
    setBadInput(input, true);
    // Chrome 은 부분 날짜(「02/31」까지)에 value "" 와 badInput 만 두고 input·change 를 하나도 안 낸다.
    // user-event 도 온전한 날짜가 아니면 이벤트를 안 낸다
    await userEvent.type(input, "2026-02");
    expect(input).toHaveValue("");
    await submit(dialog);
    expect(sentValues()).toEqual([]);
    expect(input).toHaveAccessibleDescription("날짜 형식이 올바르지 않습니다");
    // 지워도 이벤트가 없다 — 제출하는 순간 다시 읽는다
    setBadInput(input, false);
    await submit(dialog);
    expect(sentValues()).toEqual([{ fields: {} }]);
  });

  it("date 의 부분 입력을 다 지우면 형식 오류가 바로 내려간다 — 이벤트가 없어도 키를 뗀 것으로", async () => {
    const message = withModal({ fields: [{ type: "date", id: "d", label: "마감" }] });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    const input = within(dialog).getByLabelText("마감");
    setBadInput(input, true);
    await userEvent.type(input, "2026");
    await submit(dialog);
    expect(input).toHaveAccessibleDescription("날짜 형식이 올바르지 않습니다");
    // Chrome 은 지울 때도 input·change 를 안 낸다 — keydown·keyup 만
    setBadInput(input, false);
    await userEvent.type(input, "{Backspace}");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("필수 오류 뒤 date 에 부분 입력을 치면 「필수 항목입니다」가 내려간다 — 친 것이 있으니", async () => {
    const message = withModal({ fields: [{ type: "date", id: "d", label: "마감", required: true }] });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    const input = within(dialog).getByLabelText("마감");
    await submit(dialog);
    expect(input).toHaveAccessibleDescription("필수 항목입니다");
    setBadInput(input, true);
    await userEvent.type(input, "2026");
    expect(input).not.toHaveAttribute("aria-describedby");
  });

  it.each(["{Delete}", "{ArrowUp}", "{ArrowDown}"])(
    "date 칸을 「%s」로 고쳐도 그 칸의 오류가 내려간다 — 지우기·올리고 내리기도 고친 것",
    async (key) => {
      const message = withModal({ fields: [{ type: "date", id: "d", label: "마감" }] });
      renderWithClient(<Components message={message} />);
      const dialog = await open();
      const input = within(dialog).getByLabelText("마감");
      setBadInput(input, true);
      await userEvent.type(input, "2026");
      await submit(dialog);
      expect(input).toHaveAccessibleDescription("날짜 형식이 올바르지 않습니다");
      await userEvent.type(input, key);
      expect(input).not.toHaveAttribute("aria-describedby");
    },
  );

  it("date 칸에서 Enter 로 제출해도 오류가 남는다 — 그 Enter 를 뗀 것은 칸을 고친 것이 아니다", async () => {
    fake?.onAck("component.interact", () => OK);
    const message = withModal({ fields: [{ type: "date", id: "d", label: "마감", required: true }] });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    const input = within(dialog).getByLabelText("마감");
    await userEvent.type(input, "{Enter}");
    expect(sentValues()).toEqual([]);
    expect(input).toHaveAccessibleDescription("필수 항목입니다");
  });

  it("Tab 으로 date 칸에 들어오기만 해서는 오류가 안 내려간다", async () => {
    const message = withModal({
      fields: [
        { type: "text", id: "t", label: "제목" },
        { type: "date", id: "d", label: "마감", required: true },
      ],
    });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    const input = within(dialog).getByLabelText("마감");
    await submit(dialog);
    expect(input).toHaveAccessibleDescription("필수 항목입니다");
    await userEvent.click(within(dialog).getByLabelText("제목"));
    // Tab 의 keydown 은 앞 칸에, keyup 은 들어온 칸에 난다
    await userEvent.tab();
    expect(input).toHaveFocus();
    expect(input).toHaveAccessibleDescription("필수 항목입니다");
    // 뒤로(Shift+Tab) 들어와도 — Shift 를 늦게 떼면 그 keyup 도 이 칸에 난다
    await userEvent.tab();
    expect(within(dialog).getByRole("button", { name: "취소" })).toHaveFocus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(input).toHaveFocus();
    expect(input).toHaveAccessibleDescription("필수 항목입니다");
  });

  it("필수 칸이어도 못 읽는 입력이면 「필수 항목입니다」가 아니라 까닭을 말한다 — 친 것이 있으니", async () => {
    fake?.onAck("component.interact", () => OK);
    const message = withModal({
      fields: [
        { type: "number", id: "n", label: "개수", required: true },
        { type: "date", id: "d", label: "마감", required: true },
      ],
    });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    const number = within(dialog).getByLabelText("개수");
    const date = within(dialog).getByLabelText("마감");
    setBadInput(number, true);
    setBadInput(date, true);
    await userEvent.type(number, "-");
    await submit(dialog);
    expect(sentValues()).toEqual([]);
    expect(number).toHaveAccessibleDescription("숫자를 입력하세요");
    expect(date).toHaveAccessibleDescription("날짜 형식이 올바르지 않습니다");
    expect(within(dialog).queryByText("필수 항목입니다")).toBeNull();
  });

  it("칸을 고치면 그 칸의 오류가 내려간다", async () => {
    renderWithClient(<Components message={withModal()} />);
    const dialog = await open();
    await submit(dialog);
    const title = within(dialog).getByLabelText("제목");
    expect(title).toHaveAccessibleDescription("필수 항목입니다");
    await userEvent.type(title, "a");
    expect(title).not.toHaveAttribute("aria-describedby");
    expect(within(dialog).queryByText("필수 항목입니다")).toBeNull();
  });
});

describe("모달 — 칸 id 가 Object.prototype 의 이름이어도(계약 ItemId 가 받는다)", () => {
  it("열리고, 필수 오류가 그 칸에 뜨고, 고치면 그 칸만 내려가고, 채운 값이 그 id 로 나간다", async () => {
    fake?.onAck("component.interact", () => OK);
    const message = withModal({
      fields: [
        { type: "text", id: "__proto__", label: "제목", required: true },
        { type: "number", id: "constructor", label: "개수", required: true },
      ],
    });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    const title = within(dialog).getByLabelText("제목");
    const count = within(dialog).getByLabelText("개수");
    // 없는 오류를 Object.prototype 에서 읽지 않는다 — `__proto__` 면 오류 자리에 객체가 그려져 렌더가 던진다
    expect(title).not.toHaveAttribute("aria-invalid");
    expect(count).not.toHaveAttribute("aria-invalid");
    await submit(dialog);
    expect(sentValues()).toEqual([]);
    expect(title).toHaveAccessibleDescription("필수 항목입니다");
    expect(count).toHaveAccessibleDescription("필수 항목입니다");
    await userEvent.type(title, "보고서");
    expect(title).not.toHaveAttribute("aria-describedby");
    expect(count).toHaveAccessibleDescription("필수 항목입니다");
    await userEvent.type(count, "3");
    expect(count).not.toHaveAttribute("aria-describedby");
    await submit(dialog);
    // wire(JSON)에 그 키로 실린다
    expect(JSON.stringify(sentValues())).toBe('[{"fields":{"__proto__":"보고서","constructor":3}}]');
  });

  it("비워 둔 선택 칸은 그 이름이어도 빈 칸이다 — 막지 않고 빼고 보낸다", async () => {
    fake?.onAck("component.interact", () => OK);
    const message = withModal({
      fields: [
        { type: "date", id: "__proto__", label: "마감" },
        { type: "select", id: "constructor", label: "태그", multi: true, options: OPTS },
        { type: "text", id: "title", label: "제목", required: true },
      ],
    });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    expect(within(dialog).getByLabelText("마감")).not.toHaveAttribute("aria-invalid");
    expect(within(dialog).getByRole("group", { name: "태그" })).not.toHaveAttribute("aria-describedby");
    await userEvent.type(within(dialog).getByLabelText("제목"), "보고서");
    await submit(dialog);
    expect(JSON.stringify(sentValues())).toBe('[{"fields":{"title":"보고서"}}]');
  });

  it("서버가 다른 칸을 가리켜도 그 이름의 칸들은 멀쩡하다", async () => {
    fake?.onAck("component.interact", () => ({
      ok: false,
      error: {
        code: "VALIDATION",
        message: "invalid values",
        details: { issues: [{ path: ["fields", "n"], message: "Too big" }] },
      },
    }));
    const message = withModal({
      fields: [
        { type: "text", id: "__proto__", label: "제목" },
        { type: "text", id: "constructor", label: "부제" },
        { type: "number", id: "n", label: "개수" },
      ],
    });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("개수"), "2");
    await submit(dialog);
    const n = within(dialog).getByLabelText("개수");
    await waitFor(() => expect(n).toHaveAccessibleDescription("받아들일 수 없는 값입니다"));
    expect(within(dialog).getByLabelText("제목")).not.toHaveAttribute("aria-invalid");
    expect(within(dialog).getByLabelText("부제")).not.toHaveAttribute("aria-invalid");
  });
});

describe("모달 — ack 오류는 대화상자 안에", () => {
  it("ack 오류면 대화상자가 열린 채 문구가 뜬다 — 토스트가 아니라", async () => {
    const error = vi.spyOn(toast, "error");
    fake?.onAck("component.interact", () => ({
      ok: false,
      error: { code: "EXPIRED", message: "component expired" },
    }));
    renderWithClient(<Components message={withModal()} />);
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("제목"), "보고서");
    await submit(dialog);
    expect(await within(dialog).findByText("만료된 버튼입니다")).toBeVisible();
    // 대화상자 안 한 곳에만 — 밖(가려지는 자리)에 겹쳐 내지 않는다
    expect(screen.getAllByText("만료된 버튼입니다")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toBe(dialog);
    // 입력은 그대로 남는다 — 다시 보낼 수 있게
    expect(within(dialog).getByLabelText("제목")).toHaveValue("보고서");
    expect(within(dialog).getByRole("button", { name: "제출" })).toHaveAccessibleDescription(
      "만료된 버튼입니다",
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("칸을 고치면 하단 줄도 내려간다 — 고친 값에 대한 오류처럼 남지 않게", async () => {
    fake?.onAck("component.interact", () => ({
      ok: false,
      error: { code: "EXPIRED", message: "component expired" },
    }));
    renderWithClient(<Components message={withModal()} />);
    const dialog = await open();
    const title = within(dialog).getByLabelText("제목");
    await userEvent.type(title, "보고서");
    await submit(dialog);
    expect(await within(dialog).findByText("만료된 버튼입니다")).toBeVisible();
    await userEvent.type(title, "!");
    expect(within(dialog).queryByText("만료된 버튼입니다")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "제출" })).not.toHaveAttribute("aria-describedby");
  });

  it("응답이 없어도(TIMEOUT) 대화상자 안에 보인다", async () => {
    const error = vi.spyOn(toast, "error");
    // ack 대본이 없으면 가짜 소켓이 던진다 — 시간 초과와 같다
    renderWithClient(<Components message={withModal()} />);
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("제목"), "보고서");
    await submit(dialog);
    expect(await within(dialog).findByText("서버 응답이 없습니다")).toBeVisible();
    expect(error).not.toHaveBeenCalled();
  });

  it("VALIDATION 의 details.issues 가 가리키는 필드 아래에 붙는다", async () => {
    const error = vi.spyOn(toast, "error");
    fake?.onAck("component.interact", () => ({
      ok: false,
      error: {
        code: "VALIDATION",
        message: "invalid values",
        details: { issues: [{ path: ["fields", "n"], message: "Too big" }] },
      },
    }));
    const message = withModal({
      fields: [
        { type: "text", id: "title", label: "제목", required: true },
        { type: "number", id: "n", label: "개수" },
      ],
    });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("제목"), "보고서");
    await userEvent.type(within(dialog).getByLabelText("개수"), "2");
    await submit(dialog);
    const n = within(dialog).getByLabelText("개수");
    await waitFor(() => expect(n).toHaveAccessibleDescription("받아들일 수 없는 값입니다"));
    expect(n).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByLabelText("제목")).not.toHaveAttribute("aria-describedby");
    // 입력은 그대로 남는다 — 고치라는 칸에서 자기가 쓴 값을 잃지 않게
    expect(n).toHaveValue(2);
    expect(within(dialog).getByLabelText("제목")).toHaveValue("보고서");
    // 서버 문구(영문)를 그대로 내지 않는다
    expect(within(dialog).queryByText("Too big")).toBeNull();
    expect(within(dialog).queryByText("처리할 수 없는 요청입니다")).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it("select·radio 칸도 issues 로 가리키면 무리(fieldset)가 그 문구를 설명으로 든다", async () => {
    fake?.onAck("component.interact", () => ({
      ok: false,
      error: {
        code: "VALIDATION",
        message: "invalid values",
        details: {
          issues: [
            { path: ["fields", "r"], message: "Invalid option" },
            { path: ["fields", "s", 0], message: "Invalid option" },
          ],
        },
      },
    }));
    const message = withModal({
      fields: [
        { type: "radio", id: "r", label: "우선순위", options: OPTS },
        { type: "select", id: "s", label: "태그", multi: true, options: OPTS },
      ],
    });
    renderWithClient(<Components message={message} />);
    const dialog = await open();
    await submit(dialog);
    for (const name of ["우선순위", "태그"]) {
      await waitFor(() =>
        expect(within(dialog).getByRole("group", { name })).toHaveAccessibleDescription(
          "받아들일 수 없는 값입니다",
        ),
      );
    }
  });

  it("issues 가 칸을 못 가리키면 하단 한 줄로", async () => {
    fake?.onAck("component.interact", () => ({
      ok: false,
      error: {
        code: "VALIDATION",
        message: "invalid values",
        details: { issues: [{ path: ["fields"], message: "Unrecognized key" }] },
      },
    }));
    renderWithClient(<Components message={withModal()} />);
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("제목"), "보고서");
    await submit(dialog);
    expect(await within(dialog).findByText("처리할 수 없는 요청입니다")).toBeVisible();
    expect(within(dialog).getByLabelText("제목")).not.toHaveAttribute("aria-describedby");
  });

  it("보내는 동안 닫을 수 없고 「제출」이 잠긴다(두 번 보내지 않음)", async () => {
    let answer: (v: unknown) => void = () => {};
    fake?.onAck("component.interact", () => new Promise((r) => (answer = r)) as never);
    renderWithClient(<Components message={withModal()} />);
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("제목"), "보고서");
    await submit(dialog);
    const send = within(dialog).getByRole("button", { name: "제출" });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(DISABLED_REASON_TEXT.busy);
    await userEvent.click(send);
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: "닫기" })).toBeDisabled();
    expect(fake?.sentOf("component.interact")).toHaveLength(1);
    answer(OK);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("모달 — 결정 뒤 초점", () => {
  /**
   * 제출 → 서버가 message.updated 로 싣는 결과 줄(ack 의 interactionId 와 같은 id).
   * 1회용이면 모달이 소비되어 트리거가 잠긴다 — 잠긴 트리거로는 Radix 가 초점을 못 되돌리므로 「되돌림에 먹힘」은 재사용 카드에서 드러난다
   */
  const submittedCard = (extra: Record<string, unknown> = {}) =>
    withModal(
      {},
      {
        componentState: { expiresAt: FUTURE, consumed: extra.reusable ? [] : ["form"] },
        interactions: [
          {
            id: uid(500),
            componentId: COMPONENT_ID,
            userId: USER,
            itemId: "form",
            values: { fields: { title: "보고서" } },
            createdAt: "2030-01-01T00:00:00.000Z",
          },
        ],
      },
      extra,
    );
  const line = () => document.querySelector<HTMLElement>(`[data-interaction-id="${uid(500)}"]`);
  /** Radix FocusScope 는 닫혀 언마운트된 **다음 틱**(setTimeout 0)에 트리거로 되돌린다 — 그 틱과 뒤따르는 렌더까지 흘린다 */
  const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 20)));

  it("제출이 성공하면 대화상자가 닫힌 뒤 초점이 그 결과 줄로 간다 — 트리거로 되돌리는 것에 먹히지 않는다", async () => {
    let rerender: (ui: ReactElement) => void = () => {};
    // 서버는 message.updated 를 ack 앞에 낸다 — 줄이 대화상자가 열려 있는 동안 먼저 온다
    fake?.onAck("component.interact", async () => {
      await Promise.resolve();
      rerender(<Components message={submittedCard()} />);
      return OK;
    });
    ({ rerender } = renderWithClient(<Components message={withModal()} />));
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("제목"), "보고서");
    await submit(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settle();
    expect(line()).toHaveFocus();
    expect(line()).toHaveTextContent("@owner — 새 작업: 제목: 보고서");
  });

  it("재사용 카드(트리거가 다시 눌리는 채로 남음)에서도 — 닫힌 뒤 트리거로 되돌리는 것보다 나중에 옮긴다", async () => {
    let rerender: (ui: ReactElement) => void = () => {};
    fake?.onAck("component.interact", async () => {
      await Promise.resolve();
      rerender(<Components message={submittedCard({ reusable: true })} />);
      return OK;
    });
    ({ rerender } = renderWithClient(<Components message={withModal({}, {}, { reusable: true })} />));
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("제목"), "보고서");
    // 초점이 줄에 몇 번 오는가 — 닫히기 전에 먼저 가면 줄 → 트리거(되돌림) → 줄로 오가 스크린 리더가 같은 줄을 두 번 읽는다
    let toLine = 0;
    const count = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement && e.target.dataset.interactionId) toLine += 1;
    };
    document.addEventListener("focusin", count);
    try {
      await submit(dialog);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await settle();
    } finally {
      document.removeEventListener("focusin", count);
    }
    expect(trigger()).toBeEnabled();
    expect(line()).toHaveFocus();
    expect(toLine).toBe(1);
  });

  it("줄이 닫힌 뒤에 오면 그동안은 트리거에(<body> 가 아니라), 도착하면 줄로", async () => {
    fake?.onAck("component.interact", () => OK);
    const { rerender } = renderWithClient(<Components message={withModal()} />);
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("제목"), "보고서");
    await submit(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settle();
    expect(trigger()).toHaveFocus();
    rerender(<Components message={submittedCard()} />);
    expect(line()).toHaveFocus();
  });

  it("「취소」로 닫으면 트리거로만 — 보낸 것이 없다", async () => {
    const { rerender } = renderWithClient(<Components message={withModal()} />);
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settle();
    expect(trigger()).toHaveFocus();
    // 다른 사람이 같은 모달을 제출해 줄이 와도(재사용 카드) 초점은 그대로
    rerender(
      <Components
        message={withModal(
          {},
          { interactions: submittedCard().interactions.map((i) => ({ ...i, userId: uid(99) })) },
          { reusable: true },
        )}
      />,
    );
    expect(line()).not.toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it("ack 오류면 대화상자가 열린 채 초점도 대화상자 안에 남는다", async () => {
    fake?.onAck("component.interact", () => ({ ok: false, error: { code: "EXPIRED", message: "x" } }));
    renderWithClient(<Components message={withModal()} />);
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("제목"), "보고서");
    await submit(dialog);
    await settle();
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  });
});

describe("모달 — 트리거 잠김", () => {
  it.each<[string, Partial<Message>, Record<string, unknown>, keyof typeof DISABLED_REASON_TEXT]>([
    ["소비", { componentState: { expiresAt: FUTURE, consumed: ["form"] } }, {}, "consumed"],
    ["만료", { componentState: { expiresAt: "2020-01-01T00:00:00.000Z", consumed: [] } }, {}, "expired"],
    ["권한 밖", {}, { allowedUsers: [uid(99)] }, "forbidden"],
  ])("%s이면 트리거 버튼이 잠기고 사유를 말한다", async (_, over, modal, reason) => {
    renderWithClient(<Components message={withModal(modal, over)} />);
    const text = DISABLED_REASON_TEXT[reason];
    expect(trigger()).toBeDisabled();
    expect(trigger()).toHaveAttribute("title", text);
    expect(trigger()).toHaveAccessibleDescription(text);
    await userEvent.click(trigger());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("연결이 끊기면 잠긴다", () => {
    useWireStatus.getState().setStatus("reconnecting");
    renderWithClient(<Components message={withModal()} />);
    expect(trigger()).toBeDisabled();
    expect(trigger()).toHaveAccessibleDescription(DISABLED_REASON_TEXT.disconnected);
  });

  it("권한 안이면(allowedUsers 에 내가 있으면) 잠기지 않는다", () => {
    renderWithClient(<Components message={withModal({ allowedUsers: [USER] })} />);
    expect(trigger()).toBeEnabled();
    expect(trigger()).not.toHaveAttribute("aria-describedby");
  });

  it("reusable 카드는 소비된 모달도 다시 연다", () => {
    const message = withModal(
      {},
      { componentState: { expiresAt: FUTURE, consumed: ["form"] } },
      { reusable: true },
    );
    renderWithClient(<Components message={message} />);
    expect(trigger()).toBeEnabled();
  });

  it("열려 있는 동안 연결이 끊기면 「제출」이 잠기고 사유를 말한다 — 대화상자는 그대로", async () => {
    fake?.onAck("component.interact", () => OK);
    renderWithClient(<Components message={withModal()} />);
    const dialog = await open();
    await userEvent.type(within(dialog).getByLabelText("제목"), "보고서");
    useWireStatus.getState().setStatus("reconnecting");
    const send = await within(dialog).findByRole("button", { name: "제출" });
    await waitFor(() => expect(send).toBeDisabled());
    expect(send).toHaveAccessibleDescription(DISABLED_REASON_TEXT.disconnected);
    await userEvent.type(within(dialog).getByLabelText("제목"), "{Enter}");
    expect(fake?.sentOf("component.interact")).toEqual([]);
    expect(screen.getByRole("dialog")).toBe(dialog);
  });
});

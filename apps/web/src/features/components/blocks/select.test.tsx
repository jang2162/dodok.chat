import { ComponentsV1, type Message } from "@dodok/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const SINGLE = {
  type: "select",
  id: "fmt",
  placeholder: "보고서 형식",
  options: [
    { value: "pdf", label: "PDF" },
    { value: "md", label: "마크다운" },
  ],
};
const ABCD = ["a", "b", "c", "d"].map((v) => ({ value: v, label: `옵션 ${v.toUpperCase()}` }));
const MULTI = {
  type: "select",
  id: "tags",
  placeholder: "태그",
  multi: true,
  minValues: 2,
  maxValues: 3,
  options: ABCD,
};

/** 셀렉트 하나를 담은 actions 블록 카드. blockId 를 주면 블록에 id 를 단다 */
function withSelect(
  item: Record<string, unknown>,
  over: Partial<Message> = {},
  { blockId, extra = {} }: { blockId?: string; extra?: Record<string, unknown> } = {},
) {
  return msg(1, {
    components: ComponentsV1.parse({
      id: COMPONENT_ID,
      blocks: [{ type: "actions", ...(blockId ? { id: blockId } : {}), items: [item] }],
      ...extra,
    }),
    componentState: { expiresAt: FUTURE, consumed: [] },
    ...over,
  });
}

const send = () => screen.getByRole("button", { name: "보내기" });

beforeEach(() => {
  fake = createFakeSocket();
  useWireStatus.getState().setStatus("connected");
});
afterEach(() => {
  fake = undefined;
  useWireStatus.getState().setStatus("idle");
  vi.restoreAllMocks();
});

describe("셀렉트 — 단일", () => {
  it("단일 셀렉트는 라디오로 그리고, 고르기 전에는 「보내기」가 꺼져 있다", () => {
    renderWithClient(<Components message={withSelect(SINGLE)} />);
    const group = screen.getByRole("group", { name: "보고서 형식" });
    expect(within(group).getByText("보고서 형식").tagName).toBe("LEGEND");
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    expect(within(group).queryAllByRole("checkbox")).toEqual([]);
    expect(send()).toBeDisabled();
    expect(send()).toHaveAccessibleDescription("하나를 고르세요");
    expect(screen.getByText("하나를 고르세요")).toBeVisible();
  });

  it('하나 고르면 「보내기」가 켜지고, 누르면 values: { values: ["pdf"] } 로 나간다', async () => {
    fake?.onAck("component.interact", () => OK);
    const message = withSelect(SINGLE);
    renderWithClient(<Components message={message} />);
    await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
    expect(send()).toBeEnabled();
    expect(send()).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText("하나를 고르세요")).toBeNull();
    await userEvent.click(send());
    expect(fake?.sentOf("component.interact")).toEqual([
      { messageId: message.id, componentId: COMPONENT_ID, itemId: "fmt", values: { values: ["pdf"] } },
    ]);
  });

  it("블록에 id 가 있으면 blockId 도 싣는다", async () => {
    fake?.onAck("component.interact", () => OK);
    const message = withSelect(SINGLE, {}, { blockId: "pick" });
    renderWithClient(<Components message={message} />);
    await userEvent.click(screen.getByRole("radio", { name: "마크다운" }));
    await userEvent.click(send());
    expect(fake?.sentOf("component.interact")).toEqual([
      {
        messageId: message.id,
        componentId: COMPONENT_ID,
        blockId: "pick",
        itemId: "fmt",
        values: { values: ["md"] },
      },
    ]);
  });

  it("단일은 고른 것을 바꾸면 마지막 하나만 나간다", async () => {
    fake?.onAck("component.interact", () => OK);
    renderWithClient(<Components message={withSelect(SINGLE)} />);
    await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
    await userEvent.click(screen.getByRole("radio", { name: "마크다운" }));
    await userEvent.click(send());
    expect(fake?.sentOf("component.interact")).toMatchObject([{ values: { values: ["md"] } }]);
  });

  it("단일에 minValues: 0 이면 안 골라도 보낼 수 있다(values: [])", async () => {
    fake?.onAck("component.interact", () => OK);
    renderWithClient(<Components message={withSelect({ ...SINGLE, minValues: 0 })} />);
    expect(send()).toBeEnabled();
    await userEvent.click(send());
    expect(fake?.sentOf("component.interact")).toMatchObject([{ values: { values: [] } }]);
  });

  it("placeholder 가 없으면 이름 없이 그린다", () => {
    const { container } = renderWithClient(
      <Components message={withSelect({ ...SINGLE, placeholder: undefined })} />,
    );
    expect(container.querySelector("legend")).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });
});

describe("셀렉트 — 다중", () => {
  it("다중 셀렉트는 체크박스 — minValues 미만이면 「보내기」가 꺼져 있다", async () => {
    fake?.onAck("component.interact", () => OK);
    renderWithClient(<Components message={withSelect(MULTI)} />);
    const group = screen.getByRole("group", { name: "태그" });
    expect(within(group).getAllByRole("checkbox")).toHaveLength(4);
    expect(within(group).queryAllByRole("radio")).toEqual([]);

    await userEvent.click(screen.getByRole("checkbox", { name: "옵션 A" }));
    expect(send()).toBeDisabled();
    expect(send()).toHaveAccessibleDescription("2개 이상 고르세요");
    await userEvent.click(screen.getByRole("checkbox", { name: "옵션 B" }));
    expect(send()).toBeEnabled();
    await userEvent.click(send());
    expect(fake?.sentOf("component.interact")).toMatchObject([
      { itemId: "tags", values: { values: ["a", "b"] } },
    ]);
  });

  it("maxValues 를 넘겨 고를 수 없다 — 안 고른 항목이 잠기고 까닭이 보인다", async () => {
    fake?.onAck("component.interact", () => OK);
    renderWithClient(<Components message={withSelect(MULTI)} />);
    expect(screen.getByText("최대 3개까지 고를 수 있습니다")).toBeVisible();
    for (const name of ["옵션 A", "옵션 B", "옵션 C"]) {
      await userEvent.click(screen.getByRole("checkbox", { name }));
    }
    const d = screen.getByRole("checkbox", { name: "옵션 D" });
    expect(d).toBeDisabled();
    await userEvent.click(d);
    expect(d).not.toBeChecked();
    await userEvent.click(send());
    expect(fake?.sentOf("component.interact")).toMatchObject([{ values: { values: ["a", "b", "c"] } }]);
  });

  it("다중에 minValues 가 없으면 하나도 안 골라도 보낼 수 있다(values: [])", async () => {
    fake?.onAck("component.interact", () => OK);
    renderWithClient(<Components message={withSelect({ ...MULTI, minValues: undefined })} />);
    expect(send()).toBeEnabled();
    await userEvent.click(send());
    expect(fake?.sentOf("component.interact")).toMatchObject([{ values: { values: [] } }]);
  });

  it("다중에 maxValues 가 없으면 옵션을 모두 고를 수 있다(상한 25)", async () => {
    fake?.onAck("component.interact", () => OK);
    // 계약 상한인 25개 — 옵션이 적으면 기본값을 25 밑으로 내려도 안 걸린다
    const all = Array.from({ length: 25 }, (_, i) => ({ value: `o${i}`, label: `옵션 ${i}` }));
    renderWithClient(<Components message={withSelect({ ...MULTI, maxValues: undefined, options: all })} />);
    for (const o of all) await userEvent.click(screen.getByRole("checkbox", { name: o.label }));
    for (const o of all) expect(screen.getByRole("checkbox", { name: o.label })).toBeChecked();
    expect(screen.queryByText(/최대/)).toBeNull();
    await userEvent.click(send());
    expect(fake?.sentOf("component.interact")).toMatchObject([
      { values: { values: all.map((o) => o.value) } },
    ]);
  });
});

describe("셀렉트 — 잠김과 오류", () => {
  it.each<[string, Partial<Message>, Record<string, unknown>, keyof typeof DISABLED_REASON_TEXT]>([
    ["소비", { componentState: { expiresAt: FUTURE, consumed: ["fmt"] } }, {}, "consumed"],
    ["만료", { componentState: { expiresAt: "2020-01-01T00:00:00.000Z", consumed: [] } }, {}, "expired"],
    ["권한 밖", {}, { allowedUsers: [uid(99)] }, "forbidden"],
  ])("%s이면 목록과 「보내기」가 함께 잠기고 사유를 말한다", async (_, over, item, reason) => {
    renderWithClient(<Components message={withSelect({ ...SINGLE, ...item }, over)} />);
    const text = DISABLED_REASON_TEXT[reason];
    const group = screen.getByRole("group", { name: "보고서 형식" });
    expect(group).toHaveAccessibleDescription(text);
    for (const radio of within(group).getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(send()).toBeDisabled();
    expect(send()).toHaveAttribute("title", text);
    expect(send()).toHaveAccessibleDescription(text);
    // 잠긴 카드에는 「하나를 고르세요」 같은 고르기 안내를 내지 않는다 — 사유가 먼저다
    expect(screen.queryByText("하나를 고르세요")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
    expect(screen.getByRole("radio", { name: "PDF" })).not.toBeChecked();
  });

  it("권한 안이면(allowedUsers 에 내가 있으면) 잠기지 않는다", () => {
    renderWithClient(<Components message={withSelect({ ...SINGLE, allowedUsers: [USER] })} />);
    expect(screen.getByRole("radio", { name: "PDF" })).toBeEnabled();
    expect(screen.getByRole("group", { name: "보고서 형식" })).not.toHaveAttribute("aria-describedby");
  });

  it("reusable 카드는 소비된 셀렉트도 다시 고를 수 있다", () => {
    const message = withSelect(
      SINGLE,
      { componentState: { expiresAt: FUTURE, consumed: ["fmt"] } },
      {
        extra: { reusable: true },
      },
    );
    renderWithClient(<Components message={message} />);
    expect(screen.getByRole("radio", { name: "PDF" })).toBeEnabled();
  });

  it("연결이 끊기면 잠긴다", () => {
    useWireStatus.getState().setStatus("reconnecting");
    renderWithClient(<Components message={withSelect(SINGLE)} />);
    expect(screen.getByRole("radio", { name: "PDF" })).toBeDisabled();
    expect(send()).toHaveAccessibleDescription(DISABLED_REASON_TEXT.disconnected);
  });

  it("응답을 기다리는 동안 목록과 「보내기」가 잠긴다(두 번 보내지 않음)", async () => {
    let answer: (v: unknown) => void = () => {};
    fake?.onAck("component.interact", () => new Promise((r) => (answer = r)) as never);
    renderWithClient(<Components message={withSelect(SINGLE)} />);
    await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
    await userEvent.click(send());
    expect(send()).toBeDisabled();
    expect(screen.getByRole("radio", { name: "PDF" })).toBeDisabled();
    await userEvent.click(send());
    expect(fake?.sentOf("component.interact")).toHaveLength(1);
    answer(OK);
    await waitFor(() => expect(send()).toBeEnabled());
  });

  it("ack 오류는 토스트로 알린다", async () => {
    const error = vi.spyOn(toast, "error");
    fake?.onAck("component.interact", () => ({
      ok: false,
      error: { code: "VALIDATION", message: "invalid values" },
    }));
    renderWithClient(<Components message={withSelect(SINGLE)} />);
    await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
    await userEvent.click(send());
    await waitFor(() => expect(error).toHaveBeenCalledWith("처리할 수 없는 요청입니다"));
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("옵션 라벨이 화면에 보이고 value 는 안 보인다", () => {
    renderWithClient(<Components message={withSelect(MULTI)} />);
    for (const o of ABCD) {
      expect(screen.getByText(o.label)).toBeVisible();
      expect(screen.queryByText(o.value)).toBeNull();
    }
  });

  it("셀렉트 블록에는 버튼 줄을 그리지 않는다 — 「보내기」 하나뿐", () => {
    const { container } = renderWithClient(<Components message={withSelect(SINGLE)} />);
    expect(container.querySelector("[data-slot=actions]")).toBeNull();
    expect(screen.getAllByRole("button")).toEqual([send()]);
  });
});

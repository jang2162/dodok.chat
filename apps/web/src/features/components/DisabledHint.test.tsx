import { ComponentsV1, type Message } from "@dodok/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWireStatus } from "@/realtime/wire";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { msg, uid } from "../../../test/fixtures";
import { renderWithClient } from "../../../test/messages";
import { ChannelArchivedContext } from "@/features/channels/archived";
import { Components } from "./Components";
import { DISABLED_REASON_TEXT, type ItemState } from "./state";

// 소켓은 테스트가 쥔 가짜 — WireProvider 의 나머지(구독 훅 등)는 원본
let fake: FakeSocket | undefined;
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: fake?.wire, subscriptions: undefined }),
}));

const FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";
const OTHER = uid(99);

type Reason = NonNullable<ItemState["reason"]>;
const TEXTS = Object.values(DISABLED_REASON_TEXT);

type Lock = { expired?: boolean; consumed?: boolean; forbidden?: boolean };

/** 버튼 줄·셀렉트·모달을 한 카드에 — 사유를 셋에 똑같이 건다 */
function card({ expired = false, consumed = false, forbidden = false }: Lock = {}): Message {
  const who = forbidden ? { allowedUsers: [OTHER] } : {};
  return msg(1, {
    components: ComponentsV1.parse({
      id: "cmp_1",
      blocks: [
        { type: "actions", items: [{ type: "button", id: "ok", label: "좋아", ...who }] },
        {
          type: "actions",
          items: [
            {
              type: "select",
              id: "fmt",
              placeholder: "형식",
              options: [
                { value: "pdf", label: "PDF" },
                { value: "md", label: "마크다운" },
              ],
              ...who,
            },
          ],
        },
      ],
      modal: {
        id: "form",
        title: "새 작업",
        triggerLabel: "작업 만들기",
        fields: [{ type: "text", id: "title", label: "제목" }],
        ...who,
      },
    }),
    componentState: { expiresAt: expired ? PAST : FUTURE, consumed: consumed ? ["ok", "fmt", "form"] : [] },
  });
}

/** 버튼 몇 개만 담은 카드 — 버튼 줄이 사유를 어떻게 모으는지 */
function row(buttons: Record<string, unknown>[], over: Partial<Message> = {}): Message {
  return msg(1, {
    components: ComponentsV1.parse({ id: "cmp_1", blocks: [{ type: "actions", items: buttons }] }),
    componentState: { expiresAt: FUTURE, consumed: [] },
    ...over,
  });
}

const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot=${name}]`) as HTMLElement;
const button = (name: string) => screen.getByRole("button", { name, hidden: true });
/** 응답이 안 오는 ack — 누른 아이템이 「보내는 중」에 머문다 */
const hang = () => fake?.onAck("component.interact", () => new Promise(() => {}) as never);

type Spot = {
  name: string;
  /** 사유 글이 보일 자리 */
  region(): HTMLElement;
  /** 사유를 설명으로 가져야 하는 컨트롤 */
  controls(): HTMLElement[];
  /** 사유 없이 그린 뒤 이 자리를 쓸 수 있는 상태로 만든다(모달 제출은 대화상자를 연다) */
  ready?(): Promise<void>;
  /** 누른다 — 「보내는 중」을 만든다 */
  press(): Promise<void>;
};

async function openDialog() {
  await userEvent.click(button("작업 만들기"));
  await screen.findByRole("dialog", { name: "새 작업" });
}
const submitButton = () => within(screen.getByRole("dialog")).getByRole("button", { name: "제출" });

const SPOTS: Spot[] = [
  {
    name: "버튼",
    region: () => slot("actions"),
    controls: () => [button("좋아")],
    press: () => userEvent.click(button("좋아")),
  },
  {
    name: "셀렉트",
    region: () => slot("select"),
    // 목록(fieldset)과 「보내기」가 같은 사유를 가리킨다
    controls: () => [screen.getByRole("group", { name: "형식" }), button("보내기")],
    press: async () => {
      await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
      await userEvent.click(button("보내기"));
    },
  },
  {
    name: "모달 트리거",
    region: () => slot("modal-trigger"),
    controls: () => [button("작업 만들기")],
    press: async () => {
      await openDialog();
      await userEvent.click(submitButton());
    },
  },
  {
    name: "모달 제출",
    region: () => screen.getByRole("dialog"),
    controls: () => [submitButton()],
    ready: openDialog,
    press: () => userEvent.click(submitButton()),
  },
];

/** 이 요소부터 자리(region)까지 사이에 aria-hidden 이 있는가 — 자리 밖(대화상자가 바깥에 거는 것)은 세지 않는다 */
function hiddenWithin(el: HTMLElement, region: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n && n !== region.parentElement; n = n.parentElement) {
    if (n.getAttribute("aria-hidden") === "true") return true;
  }
  return false;
}

/** 눈에서 지우는 유틸리티(화면 폭별 포함) — 한 토큰 전체가 이것일 때만 센다(`overflow-hidden` 은 아니다) */
const HIDING_CLASS = /^(?:(?:max-)?(?:sm|md|lg|xl|2xl):)?(?:hidden|invisible|collapse|sr-only|opacity-0)$/;

/**
 * 이 요소의 안쪽 전부와 자리(region)까지의 바깥에 걸린 숨김 클래스. jsdom 은 Tailwind CSS 를 읽지 않아 `toBeVisible` 이
 * 클래스로 숨긴 것을 못 본다(`hidden sm:inline` 이면 폰에서 사라져도 통과한다) — 그래서 이름으로 잰다.
 * 안쪽도 보는 것은 힌트의 일부(섞인 줄의 이름)만 따로 싸서 숨기는 것까지 잡으려고
 */
function hidingClasses(el: HTMLElement, region: HTMLElement): string[] {
  const nodes: Element[] = Array.from(el.querySelectorAll("*"));
  for (let n: HTMLElement | null = el; n && n !== region.parentElement; n = n.parentElement) nodes.push(n);
  return nodes.flatMap((n) => Array.from(n.classList).filter((c) => HIDING_CLASS.test(c)));
}

/**
 * 사유가 (1) 눈에 보이는 글로 자리 안에 **한 번** 있고 (2) 컨트롤마다 그 글이 **정확히** 설명이며
 * (3) 그 글은 스크린 리더가 문서를 훑을 때 따로 읽지 않는다(aria-hidden) — 설명으로 한 번, 글로 또 한 번 읽히지 않게.
 * (4) title 은 없다 — 비활성 버튼에는 툴팁이 뜨지 않고, 있으면 설명 계산이 사라진 힌트를 가린다
 */
function expectSeenAndSpokenOnce(spot: Spot, text: string) {
  const region = spot.region();
  const seen = within(region).getAllByText(text);
  expect(seen).toHaveLength(1);
  const [hint] = seen as [HTMLElement];
  expect(hint).toBeVisible();
  expect(hidingClasses(hint, region)).toEqual([]);
  expect(hiddenWithin(hint, region)).toBe(true);
  for (const c of spot.controls()) {
    expect(c).toBeDisabled();
    expect(c).toHaveAccessibleDescription(text);
    expect(c).not.toHaveAttribute("title");
    expect(c.getAttribute("aria-describedby")?.split(" ")).toContain(hint.id);
  }
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

describe("비활성 사유는 보이는 글이다 — 여섯 사유 × 버튼·셀렉트·모달", () => {
  /** 사유를 건다 — 카드는 먼저 누를 수 있게 그려 두고(바뀌는 순간에도 글이 따라오는지) 그 위에 사유를 얹는다 */
  const lock: Record<
    Reason,
    (spot: Spot, rerender: (m: Message, archived?: boolean) => void) => Promise<void>
  > = {
    // 채널 화면이 내려 주는 보관 여부가 바뀐다(다른 탭의 보관 → channel.updated)
    archived: async (_, rerender) => rerender(card(), true),
    disconnected: async () => act(() => useWireStatus.getState().setStatus("reconnecting")),
    expired: async (_, rerender) => rerender(card({ expired: true })),
    consumed: async (_, rerender) => rerender(card({ consumed: true })),
    forbidden: async (_, rerender) => rerender(card({ forbidden: true })),
    busy: async (spot) => {
      hang();
      await spot.press();
    },
  };

  describe.each(SPOTS.map((s) => [s.name, s] as const))("%s", (_, spot) => {
    it.each(Object.keys(lock) as Reason[])("%s — 보이는 글 한 번, 설명 한 번", async (reason) => {
      // 처음부터 Provider 로 감싼다 — 보관 여부만 바뀌어야 카드가 새로 마운트되지 않고 그 자리에서 잠긴다
      const inChannel = (m: Message, archived = false) => (
        <ChannelArchivedContext.Provider value={archived}>
          <Components message={m} />
        </ChannelArchivedContext.Provider>
      );
      const { rerender } = renderWithClient(inChannel(card()));
      await spot.ready?.();
      await lock[reason](spot, (m, archived) => rerender(inChannel(m, archived)));
      expectSeenAndSpokenOnce(spot, DISABLED_REASON_TEXT[reason]);
    });

    it("누를 수 있을 때는 사유 글이 없고 자리도 차지하지 않는다", async () => {
      renderWithClient(<Components message={card()} />);
      await spot.ready?.();
      const region = spot.region();
      expect(region.querySelector("[data-slot=disabled-hint]")).toBeNull();
      for (const text of TEXTS) expect(within(region).queryByText(text)).toBeNull();
      for (const c of spot.controls()) {
        expect(c).not.toHaveAttribute("title");
        for (const text of TEXTS) expect(c).not.toHaveAccessibleDescription(text);
      }
    });
  });

  it("사유가 풀리면 글도 내려간다", async () => {
    useWireStatus.getState().setStatus("reconnecting");
    renderWithClient(<Components message={card()} />);
    expect(screen.getAllByText(DISABLED_REASON_TEXT.disconnected)).toHaveLength(3);
    act(() => useWireStatus.getState().setStatus("connected"));
    expect(screen.queryByText(DISABLED_REASON_TEXT.disconnected)).toBeNull();
    expect(document.querySelector("[data-slot=disabled-hint]")).toBeNull();
  });
});

describe("버튼 줄 — 사유를 모아 말한다", () => {
  const THREE = [
    { type: "button", id: "a", label: "하나" },
    { type: "button", id: "b", label: "둘" },
    { type: "button", id: "c", label: "셋" },
  ];

  it("줄 전체가 같은 사유면 글은 한 번만 보이고, 세 버튼이 모두 그 글을 가리킨다", () => {
    renderWithClient(
      <Components message={row(THREE, { componentState: { expiresAt: PAST, consumed: [] } })} />,
    );
    const text = DISABLED_REASON_TEXT.expired;
    const [hint, ...rest] = within(slot("actions")).getAllByText(text);
    expect(rest).toEqual([]);
    // 사유가 하나뿐이면 어느 버튼인지 앞에 적지 않는다
    expect(hint?.closest("[data-slot=disabled-hint]")).toHaveTextContent(new RegExp(`^${text}$`));
    for (const name of ["하나", "둘", "셋"]) {
      expect(button(name)).toHaveAccessibleDescription(text);
      expect(button(name)).toHaveAttribute("aria-describedby", hint?.id);
    }
  });

  it("일부만 잠겨도 사유가 하나면 이름을 붙이지 않는다 — 회색 버튼이 곧 그것이다", () => {
    renderWithClient(
      <Components message={row(THREE, { componentState: { expiresAt: FUTURE, consumed: ["a"] } })} />,
    );
    const shown = Array.from(document.querySelectorAll<HTMLElement>("[data-slot=disabled-hint]"));
    expect(shown.map((h) => h.textContent)).toEqual([DISABLED_REASON_TEXT.consumed]);
    // 한 줄뿐이면 버튼 옆에 붙는다 — 줄을 따로 쓰는 것은 섞일 때만
    expect(shown[0]).not.toHaveClass("basis-full");
    expect(button("둘")).toBeEnabled();
    expect(button("둘")).not.toHaveAttribute("aria-describedby");
  });

  it("사유가 섞이면 어느 버튼의 것인지 앞에 적되, 스크린 리더에는 사유만 읽힌다(이름을 두 번 읽지 않게)", () => {
    const buttons = [
      { type: "button", id: "a", label: "하나" },
      { type: "button", id: "b", label: "둘", allowedUsers: [OTHER] },
      { type: "button", id: "c", label: "셋", emoji: "✋" },
      { type: "button", id: "d", label: "넷" },
    ];
    renderWithClient(
      <Components message={row(buttons, { componentState: { expiresAt: FUTURE, consumed: ["a", "c"] } })} />,
    );
    const shown = Array.from(document.querySelectorAll<HTMLElement>("[data-slot=disabled-hint]"));
    expect(shown.map((h) => h.textContent)).toEqual([
      `하나, ✋ 셋: ${DISABLED_REASON_TEXT.consumed}`,
      `둘: ${DISABLED_REASON_TEXT.forbidden}`,
    ]);
    for (const h of shown) {
      // 이름까지 눈에 보이고
      expect(h).toBeVisible();
      expect(hidingClasses(h, slot("actions"))).toEqual([]);
      // 이름까지 통째로 훑기에서 빠진다 — aria-hidden 이 사유(id) 쪽에만 걸리면 「둘: 」이 떨어진 글로 따로 읽힌다
      expect(hiddenWithin(h, slot("actions"))).toBe(true);
      // 섞인 힌트는 줄을 하나씩 쓴다 — 간격으로만 붙어 있으면 어디까지가 어느 버튼 얘기인지 흐리다.
      // 줄바꿈 자체는 jsdom 이 못 재 클래스로 잠근다
      expect(h).toHaveClass("basis-full");
    }
    expect(button("하나")).toHaveAccessibleDescription(DISABLED_REASON_TEXT.consumed);
    expect(button("✋ 셋")).toHaveAccessibleDescription(DISABLED_REASON_TEXT.consumed);
    expect(button("둘")).toHaveAccessibleDescription(DISABLED_REASON_TEXT.forbidden);
    expect(button("넷")).toBeEnabled();
    expect(button("넷")).not.toHaveAttribute("aria-describedby");
  });
});

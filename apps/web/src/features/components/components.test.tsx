import { ComponentsV1, INTERACTIONS_MAX, type Message, type MessageInteraction } from "@dodok/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWireStatus } from "@/realtime/wire";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { msg, uid, USER } from "../../../test/fixtures";
import { renderWithClient } from "../../../test/messages";
import { LINK_BLOCKED } from "./blocks/ActionsBlock";
import { ARTIFACT_PENDING } from "./blocks/artifact";
import { Components, UNKNOWN_USER } from "./Components";
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

  it("링크 버튼은 https:// 로 시작해야만 링크가 된다 — javascript:·data:·http:·대문자 HTTPS://·가운데·앞 공백 https://·상대 주소 // 와 / 는 링크 없이 비활성", () => {
    const OK_URL = "https://example.com/ok";
    const BAD = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://example.com/x",
      "HTTPS://example.com/x",
      // https:// 를 가운데 품은 값 — 접두사 검사가 includes·indexOf 로 느슨해지는 것을 잡는다
      "http://evil.example/?next=https://ok.example",
      // 앞에 공백 — 검사 전에 trim 으로 느슨해지는 것을 잡는다(계약 SafeUrl 도 ^https:// 라 거절한다)
      " https://example.com/x",
      // 프로토콜 상대 주소 — 「상대 주소는 같은 출처라 안전」으로 / 를 허용하는 것을 잡는다. //host 는 다른 출처다
      "//evil.example/x",
      // 같은 출처 경로 — // 만 막고 / 는 허용하는 것을 잡는다. 새 탭 링크가 쿠키 실린 같은 출처 GET 이 된다
      "/api/me",
      // artifact:// 를 닮았지만 아닌 값 — 첨부 문구가 아니라 「열 수 없음」이어야 한다(아래 artifact 테스트의 짝).
      // 대문자(i 플래그로 느슨해짐)·앞 공백(trim)·가운데 품음(includes) 을 잡는다
      "ARTIFACT://files/x",
      " artifact://files/x",
      "http://evil.example/?next=artifact://files/x",
      // 스킴만 맞고 // 가 모자란 값 — 접두사가 "artifact:"·"artifact:/" 로 짧아지거나 new URL().protocol 로 가르는 것을 잡는다
      "artifact:files/x",
      "artifact:/files/x",
    ];
    // withButtons() 의 ComponentsV1.parse 를 건너뛴다 — 계약(SafeUrl)이 먼저 거르면 렌더러의 허용목록이 안 잠긴다.
    // 서버는 쓸 때만 검증하므로 옛 행·느슨해진 계약의 값은 여기까지 온다(url 의 TS 타입은 string 이라 캐스트 없이 들어간다)
    const components: ComponentsV1 = {
      id: COMPONENT_ID,
      reusable: false,
      ttlMs: 1_800_000,
      blocks: [
        {
          type: "actions",
          items: [OK_URL, ...BAD].map((url, i) => ({
            type: "button",
            id: `link_${i}`,
            label: url,
            style: "secondary",
            url,
          })),
        },
      ],
    };
    const { container } = renderWithClient(<Components message={{ ...withButtons(), components }} />);
    expect(Array.from(container.querySelectorAll("a"), (a) => a.getAttribute("href"))).toEqual([OK_URL]);
    for (const url of BAD) {
      // 접근 이름은 앞뒤 공백을 버린다
      const blocked = screen.getByRole("button", { name: url.trim() });
      expect(blocked).toBeDisabled();
      expect(blocked).toHaveAccessibleDescription(LINK_BLOCKED);
      expect(blocked).not.toHaveAttribute("title");
      const hint = document.getElementById(blocked.getAttribute("aria-describedby") ?? "");
      expect(hint?.textContent).toBe(LINK_BLOCKED);
    }
    // 같은 사유는 줄 끝에 한 번만 보인다(DisabledHint.test)
    expect(screen.getAllByText(LINK_BLOCKED)).toHaveLength(1);
  });

  it("artifact:// 링크 버튼은 링크가 아니라 비활성이고, 사유는 media·file 과 같은 첨부 문구다 — 「열 수 없음」이 아니라", () => {
    // javascript: 는 계약 밖이라 parse 를 건너뛴다(위 테스트와 같은 까닭) — artifact:// 는 계약을 통과하는 유일한 비-https 값이라
    // 운영에서 실제로 렌더러에 닿는다
    const components: ComponentsV1 = {
      id: COMPONENT_ID,
      reusable: false,
      ttlMs: 1_800_000,
      blocks: [
        {
          type: "actions",
          items: [
            {
              type: "button",
              id: "att",
              label: "보고서 받기",
              style: "secondary",
              url: "artifact://files/abc123",
            },
            { type: "button", id: "js", label: "나쁜 링크", style: "secondary", url: "javascript:alert(1)" },
          ],
        },
      ],
    };
    const { container } = renderWithClient(<Components message={{ ...withButtons(), components }} />);
    // artifact:// 가 a 로 새지 않는다
    expect(container.querySelectorAll("a")).toHaveLength(0);
    const att = screen.getByRole("button", { name: "보고서 받기" });
    expect(att).toBeDisabled();
    expect(att).not.toHaveAttribute("title");
    expect(att).toHaveAccessibleDescription(ARTIFACT_PENDING);
    expect(document.getElementById(att.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      ARTIFACT_PENDING,
    );
    const js = screen.getByRole("button", { name: "나쁜 링크" });
    expect(js).not.toHaveAttribute("title");
    expect(js).toHaveAccessibleDescription(LINK_BLOCKED);
    // 두 사유가 한 줄에 섞였다 — 어느 버튼의 것인지 앞에 적어 보인다
    expect(Array.from(container.querySelectorAll("[data-slot=disabled-hint]"), (h) => h.textContent)).toEqual(
      [`보고서 받기: ${ARTIFACT_PENDING}`, `나쁜 링크: ${LINK_BLOCKED}`],
    );
  });

  it("같은 카드의 같은 artifact:// 값은 media·file·링크 버튼이 같은 말을 한다", () => {
    const ART = "artifact://files/abc123";
    const message = withButtons({}, [
      { type: "media", items: [{ url: ART, alt: "도표" }] },
      { type: "file", url: ART, name: "보고서.pdf" },
      { type: "actions", items: [{ type: "button", id: "att", label: "받기", url: ART }] },
    ]);
    const { container } = renderWithClient(<Components message={message} />);
    const q = (slot: string) => container.querySelector(`[data-slot=${slot}]`);
    expect(q("media")).toHaveTextContent(ARTIFACT_PENDING);
    expect(q("file")).toHaveTextContent(ARTIFACT_PENDING);
    expect(screen.getByRole("button", { name: "받기" })).toHaveAccessibleDescription(ARTIFACT_PENDING);
    expect(container).not.toHaveTextContent(LINK_BLOCKED);
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
  ])("비활성 사유(%s)를 회색으로만 두지 않고 보이는 글·설명으로 말한다", (_, over, text) => {
    renderWithClient(<Components message={withButtons(over)} />);
    const button = screen.getByRole("button", { name: "이어가기" });
    expect(button).toBeDisabled();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(button).not.toHaveAttribute("title");
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

  // 가리키는 요소를 꺼내 따로 잰다 — 예전에는 title 이 같은 설명을 대신 내 toHaveAccessibleDescription 만으로는 힌트가 안 잠겼다
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

const OK = { ok: true, data: { interactionId: uid(500) } } as const;
const OTHER = uid(99);

/** 상호작용 하나 — n 이 클수록 나중(초 단위). id 는 uid(700 + n), 내 것이 기본 */
function ix(n: number, itemId: string, over: Partial<MessageInteraction> = {}): MessageInteraction {
  return {
    id: uid(700 + n),
    componentId: COMPONENT_ID,
    userId: USER,
    itemId,
    values: {},
    createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, n)).toISOString(),
    ...over,
  };
}

/** 결과 줄들의 글자 — 목록이 없으면 빈 배열 */
function lines(): string[] {
  const list = screen.queryByRole("list", { name: "상호작용 기록" });
  return list
    ? within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent ?? "")
    : [];
}
const lineOf = (id: string) => document.querySelector<HTMLElement>(`[data-interaction-id="${id}"]`);

const SELECT_CARD = [
  { type: "actions", items: [{ type: "button", id: "ok", label: "확인", emoji: "👍" }] },
  {
    type: "actions",
    items: [
      {
        type: "select",
        id: "fmt",
        placeholder: "보고서 형식",
        multi: true,
        options: [
          { value: "pdf", label: "PDF" },
          { value: "md", label: "마크다운" },
        ],
      },
    ],
  },
];

describe("Components — 결과 줄", () => {
  it("결과 줄이 오래된 것부터 `@핸들 — 라벨: 값` 으로 그려진다 — 실려 온 순서가 아니라", () => {
    const message = withButtons(
      { interactions: [ix(3, "ok"), ix(1, "fmt", { values: { values: ["pdf", "md"] } })] },
      SELECT_CARD,
    );
    renderWithClient(<Components message={message} />);
    expect(lines()).toEqual(["@owner — 보고서 형식: PDF, 마크다운", "@owner — 확인"]);
  });

  it("모르는 사용자는 「알 수 없는 사용자」", () => {
    renderWithClient(
      <Components message={withButtons({ interactions: [ix(1, "stop", { userId: OTHER })] })} />,
    );
    expect(lines()).toEqual([`${UNKNOWN_USER} — 그만`]);
  });

  it("결과 줄은 카드 맨 아래 — 블록들과 모달 트리거 뒤", () => {
    const message = withButtons({ interactions: [ix(1, "stop")] }, undefined, {
      modal: {
        id: "form",
        title: "새 작업",
        triggerLabel: "작업 만들기",
        fields: [{ type: "text", id: "t", label: "제목" }],
      },
    });
    const { container } = renderWithClient(<Components message={message} />);
    const card = container.querySelector("[data-slot=components]");
    expect(Array.from(card?.children ?? [], (el) => el.getAttribute("data-slot"))).toEqual([
      "actions",
      "modal-trigger",
      "interaction-log",
    ]);
  });

  it("상호작용이 없으면 결과 줄 자리도 없다", () => {
    const { container } = renderWithClient(<Components message={withButtons()} />);
    expect(container.querySelector("[data-slot=interaction-log]")).toBeNull();
  });

  it("상한에 닿으면 「최근 20건」을 덧붙인다 — 목록 밖에, 하나 모자라면 없다", () => {
    const many = (k: number) => Array.from({ length: k }, (_, i) => ix(i, "stop"));
    const { rerender } = renderWithClient(
      <Components message={withButtons({ interactions: many(INTERACTIONS_MAX - 1) })} />,
    );
    expect(lines()).toHaveLength(INTERACTIONS_MAX - 1);
    expect(screen.queryByText(`최근 ${INTERACTIONS_MAX}건`)).toBeNull();
    rerender(<Components message={withButtons({ interactions: many(INTERACTIONS_MAX) })} />);
    expect(lines()).toHaveLength(INTERACTIONS_MAX);
    const note = screen.getByText(`최근 ${INTERACTIONS_MAX}건`);
    expect(screen.getByRole("list", { name: "상호작용 기록" })).not.toContainElement(note);
  });

  it("결과 줄은 초점을 받을 수 있지만 탭 차례에는 안 든다 — 줄 수만큼 Tab 이 늘지 않게", async () => {
    renderWithClient(
      <Components message={withButtons({ interactions: [ix(1, "stop"), ix(2, "continue_relay")] })} />,
    );
    const items = within(screen.getByRole("list", { name: "상호작용 기록" })).getAllByRole("listitem");
    // 결정 뒤 초점은 스크립트로 오므로 -1 이어야 한다 — 빠지면 focus() 가 먹지 않는다
    for (const li of items) expect(li).toHaveAttribute("tabindex", "-1");
    // Tab 으로 한 바퀴 — 버튼 둘과 문서 링크만 들르고 줄에는 서지 않는다
    const visited: Element[] = [];
    for (let i = 0; i < items.length + 4; i++) {
      await userEvent.tab();
      if (document.activeElement) visited.push(document.activeElement);
    }
    expect(visited.filter((el) => el.tagName === "LI")).toEqual([]);
  });

  it("줄은 상호작용 id 로 가른다 — 재사용 카드에 같은 itemId 줄이 여럿이어도 넘김 뒤 초점이 제 줄에 남는다", () => {
    // React 는 같은 key 를 console.error 로 알린다
    const errors = vi.spyOn(console, "error");
    const card = (interactions: MessageInteraction[]) =>
      withButtons({ interactions }, undefined, { reusable: true });
    const all = [ix(1, "stop"), ix(2, "stop", { userId: OTHER }), ix(3, "stop")];
    const { rerender } = renderWithClient(<Components message={card(all.slice(0, 2))} />);
    act(() => lineOf(uid(702))?.focus());
    // 상한 넘김 — 가장 오래된 줄이 빠지고 새 줄이 붙는다
    rerender(<Components message={card(all.slice(1))} />);
    expect(lines()).toEqual([`${UNKNOWN_USER} — 그만`, "@owner — 그만"]);
    expect(lineOf(uid(702))).toHaveFocus();
    expect(errors).not.toHaveBeenCalled();
  });

  it("summarize 가 못 푸는 줄은 건너뛴다 — 카드가 깨지지 않는다", () => {
    const message = withButtons({ interactions: [ix(1, "stop"), ix(2, "gone"), ix(3, "continue_relay")] });
    const { rerender, container } = renderWithClient(<Components message={message} />);
    expect(lines()).toEqual(["@owner — 그만", "@owner — 이어가기"]);
    expect(lineOf(uid(702))).toBeNull();
    expect(screen.getByRole("button", { name: "이어가기" })).toBeInTheDocument();
    // 하나도 못 풀면 목록을 두지 않는다 — 빈 목록을 읽지 않게
    rerender(<Components message={withButtons({ interactions: [ix(2, "gone")] })} />);
    expect(container.querySelector("[data-slot=interaction-log]")).toBeNull();
    expect(screen.getByRole("button", { name: "이어가기" })).toBeInTheDocument();
  });
});

describe("Components — 결정 뒤 초점", () => {
  it("내가 보낸 뒤 초점이 그 결과 줄로 간다 — 줄이 ack 뒤에 와도", async () => {
    fake?.onAck("component.interact", () => OK);
    const { rerender } = renderWithClient(<Components message={withButtons()} />);
    await userEvent.click(screen.getByRole("button", { name: "이어가기" }));
    // 서버의 message.updated — 소비되어 버튼이 잠기고 결과 줄이 생긴다
    rerender(
      <Components
        message={withButtons({
          componentState: { expiresAt: FUTURE, consumed: ["continue_relay"] },
          interactions: [ix(0, "continue_relay", { id: uid(500) })],
        })}
      />,
    );
    expect(lineOf(uid(500))).toHaveFocus();
  });

  it("줄이 ack 보다 먼저 와도 옮긴다 — 서버는 message.updated 를 ack 앞에 낸다", async () => {
    const after = withButtons({
      componentState: { expiresAt: FUTURE, consumed: ["continue_relay"] },
      interactions: [ix(0, "continue_relay", { id: uid(500) })],
    });
    let rerender: (ui: ReactElement) => void = () => {};
    fake?.onAck("component.interact", async () => {
      await Promise.resolve();
      rerender(<Components message={after} />);
      return OK;
    });
    ({ rerender } = renderWithClient(<Components message={withButtons()} />));
    await userEvent.click(screen.getByRole("button", { name: "이어가기" }));
    await waitFor(() => expect(lineOf(uid(500))).toHaveFocus());
  });

  it("셀렉트도 「보내기」 뒤 그 결과 줄로", async () => {
    fake?.onAck("component.interact", () => OK);
    const { rerender } = renderWithClient(<Components message={withButtons({}, SELECT_CARD)} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "PDF" }));
    await userEvent.click(screen.getByRole("button", { name: "보내기" }));
    rerender(
      <Components
        message={withButtons(
          { interactions: [ix(0, "fmt", { id: uid(500), values: { values: ["pdf"] } })] },
          SELECT_CARD,
        )}
      />,
    );
    expect(lineOf(uid(500))).toHaveFocus();
  });

  it("다른 사람이 보낸 상호작용이 도착해도 초점을 뺏지 않는다", async () => {
    const { rerender } = renderWithClient(<Components message={withButtons()} />);
    const stop = screen.getByRole("button", { name: "✋ 그만" });
    stop.focus();
    rerender(
      <Components message={withButtons({ interactions: [ix(1, "continue_relay", { userId: OTHER })] })} />,
    );
    expect(lineOf(uid(701))).not.toBeNull();
    expect(stop).toHaveFocus();
  });

  it("내 줄로 옮긴 뒤 초점을 딴 데로 옮기면, 다음에 오는 줄(다른 사람 것)은 초점을 뺏지 않는다 — 표식은 한 번 쓰고 내린다", async () => {
    fake?.onAck("component.interact", () => OK);
    const message = (interactions: MessageInteraction[]) =>
      withButtons({ interactions }, undefined, { reusable: true });
    const { rerender } = renderWithClient(<Components message={message([])} />);
    await userEvent.click(screen.getByRole("button", { name: "이어가기" }));
    const mine = ix(0, "continue_relay", { id: uid(500) });
    rerender(<Components message={message([mine])} />);
    expect(lineOf(uid(500))).toHaveFocus();
    const stop = screen.getByRole("button", { name: "✋ 그만" });
    stop.focus();
    rerender(<Components message={message([mine, ix(1, "continue_relay", { userId: OTHER })])} />);
    expect(stop).toHaveFocus();
  });

  it("재사용 카드에서 다른 사람이 같은 버튼을 눌러도(같은 itemId) 그 줄로 가지 않는다 — 내 줄이 오면 그리로", async () => {
    let answer: (v: typeof OK) => void = () => {};
    fake?.onAck("component.interact", () => new Promise((r) => (answer = r)));
    const message = (interactions: MessageInteraction[]) =>
      withButtons({ interactions }, undefined, { reusable: true });
    // 내가 전에 누른 줄이 이미 있다 — 같은 itemId
    const old = ix(0, "continue_relay");
    const { rerender } = renderWithClient(<Components message={message([old])} />);
    const button = screen.getByRole("button", { name: "이어가기" });
    await userEvent.click(button);
    // 내 ack 이 오기 전에 다른 사람이 같은 버튼을 눌렀다
    const theirs = ix(1, "continue_relay", { userId: OTHER });
    rerender(<Components message={message([old, theirs])} />);
    await act(async () => answer(OK));
    expect(lineOf(theirs.id)).not.toHaveFocus();
    expect(lineOf(old.id)).not.toHaveFocus();
    rerender(<Components message={message([old, theirs, ix(2, "continue_relay", { id: uid(500) })])} />);
    expect(lineOf(uid(500))).toHaveFocus();
  });

  it("만료로 잠겨도 초점을 뺏지 않는다 — 전에 보낸 내 줄이 있어도", () => {
    const outside = document.createElement("input");
    document.body.append(outside);
    try {
      const mine = [ix(1, "stop")];
      const { rerender } = renderWithClient(<Components message={withButtons({ interactions: mine })} />);
      outside.focus();
      rerender(
        <Components
          message={withButtons({
            componentState: { expiresAt: "2000-01-01T00:00:00.000Z", consumed: [] },
            interactions: mine,
          })}
        />,
      );
      expect(screen.getByRole("button", { name: "이어가기" })).toBeDisabled();
      expect(outside).toHaveFocus();
    } finally {
      outside.remove();
    }
  });

  it("보내기가 실패하면 초점을 옮기지 않는다", async () => {
    vi.spyOn(toast, "error");
    fake?.onAck("component.interact", () => ({ ok: false, error: { code: "EXPIRED", message: "x" } }));
    const { rerender } = renderWithClient(<Components message={withButtons()} />);
    const button = screen.getByRole("button", { name: "이어가기" });
    await userEvent.click(button);
    rerender(
      <Components message={withButtons({ interactions: [ix(1, "continue_relay", { userId: OTHER })] })} />,
    );
    expect(lineOf(uid(701))).not.toHaveFocus();
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
    expect(button).toHaveAccessibleDescription("만료되었습니다");
    expect(screen.getByText("만료되었습니다")).toBeInTheDocument();
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

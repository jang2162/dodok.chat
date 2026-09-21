import { ComponentsV1, type SystemKind } from "@dodok/shared";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWireStatus } from "@/realtime/wire";
import { agentColorVar } from "@/theme/agentColor";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { AGENT, msg, uid, USER } from "../../../test/fixtures";
import { authorsClient, DEV, renderWithClient } from "../../../test/messages";
import { toBodyMd } from "@/features/composer/serialize";
import { MENTION_HREF_PREFIX } from "./mentionMarkdown";
import { MessageBody } from "./MessageBody";
import { MessageItem } from "./MessageItem";
import { PendingActionsContext } from "./pendingActions";
import { PendingItem } from "./PendingItem";
import { SystemCard } from "./SystemCard";
import type { PendingMessage } from "./timeline";

// 「이어가기」 회귀 테스트만 소켓을 쥔다 — 그 밖의 테스트는 소켓 없음(WireProvider 밖과 같다)
let fake: FakeSocket | undefined;
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: fake?.wire, subscriptions: undefined }),
}));
afterEach(() => {
  fake = undefined;
  useWireStatus.getState().setStatus("idle");
});

describe("MessageBody", () => {
  it("멘션 토큰은 칩 — 에이전트는 @핸들과 색 점, 모르는 id 는 「@알 수 없음」", () => {
    const { container } = renderWithClient(
      <MessageBody bodyMd={`<@a:${AGENT}> 봐 줘 <@u:${USER}> <@a:${uid(99)}>`} />,
    );
    const dev = screen.getByText("@dev").closest("[data-mention]");
    expect(dev).toHaveAttribute("data-mention", "a");
    const dot = dev?.querySelector("[data-agent-dot]");
    expect(dot).not.toBeNull();
    expect((dot as HTMLElement).style.backgroundColor).toBe(agentColorVar("dev"));
    expect(screen.getByText("@owner").closest("[data-mention]")).toHaveAttribute("data-mention", "u");
    const unknown = screen.getByText("@알 수 없음").closest("[data-mention]");
    expect(unknown?.querySelector("[data-agent-dot]")).toBeNull();
    // 칩으로 바뀌어 해시 링크 자체는 남지 않는다
    expect(container.querySelector('a[href^="#mention-"]')).toBeNull();
  });

  const FIN = { ...DEV, id: uid(12), providerAgentId: "fin", handle: "fin", name: "Fin" };

  it("칩은 진짜 멘션 토큰만 — 본문에 손으로 쓴 #mention- 해시 링크(어떤 표기든)는 칩이 아니다", () => {
    const { container } = renderWithClient(
      <MessageBody
        bodyMd={`[@dev](#mention-a-${FIN.id}) [@dev](<#mention-a-${FIN.id}>) [@dev](&#35;mention-a-${FIN.id}) <@a:${FIN.id}>`}
      />,
      authorsClient([DEV, FIN]),
    );
    const chips = container.querySelectorAll<HTMLElement>("[data-mention]");
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent("@fin");
    expect(chips[0]?.querySelector<HTMLElement>("[data-agent-dot]")?.style.backgroundColor).toBe(
      agentColorVar("fin"),
    );
  });

  it("칩 라벨은 링크 글자가 아니라 id 로 찾은 핸들", () => {
    const { container } = renderWithClient(
      <MessageBody bodyMd={`[@dev](${MENTION_HREF_PREFIX}a-${FIN.id})`} />,
      authorsClient([DEV, FIN]),
    );
    expect(container.querySelector("[data-mention]")).toHaveTextContent("@fin");
    expect(screen.queryByText("@dev")).toBeNull();
  });

  it("단일 개행은 줄바꿈 — 코드 블록 안 개행·빈 줄로 나눈 문단은 그대로", () => {
    const { container } = renderWithClient(
      <MessageBody bodyMd={"첫 줄\n둘째 줄\n\n새 문단\n\n```\na\nb\n```"} />,
    );
    const [first, second] = container.querySelectorAll("p");
    expect(first?.querySelectorAll("br")).toHaveLength(1);
    expect(first).toHaveTextContent("첫 줄 둘째 줄");
    expect(second).toHaveTextContent("새 문단");
    expect(second?.querySelector("br")).toBeNull();
    // 코드 블록은 줄마다 따로 그린다 — 두 줄 그대로, <br> 없음
    const lines = container.querySelectorAll("pre code > span");
    expect(Array.from(lines, (l) => l.textContent)).toEqual(["a", "b"]);
    expect(container.querySelector("pre br")).toBeNull();
  });

  /** Streamdown 은 굵은 글씨를 <strong> 이 아니라 data-streamdown="strong" 을 붙인 <span> 으로 그린다 */
  const strongs = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[data-streamdown="strong"]'), (e) => e.textContent);

  it("한국어 강조는 조사가 붙어도 굵게 — 닫는 ** 뒤에 한글이 바로 오는 경우(@streamdown/cjk)", () => {
    // CommonMark 의 좌우 플랭킹 규칙은 한글을 구두점도 공백도 아닌 글자로 보아 닫는 ** 를 닫는 표시로 치지 않는다.
    // 플러그인을 빼면 '**"인용"**은' 은 별표째 글자로 남는다
    const { container } = renderWithClient(
      <MessageBody bodyMd={'**"인용"**은 그대로, *강조*와 ~~지움~~도'} />,
    );
    expect(strongs(container)).toEqual(['"인용"']);
    expect(container.querySelector("em")).toHaveTextContent("강조");
    expect(container.querySelector("del")).toHaveTextContent("지움");
    expect(container).toHaveTextContent('"인용"은 그대로, 강조와 지움도');
    expect(container.textContent).not.toContain("*");
  });

  it("영문 강조·취소선·자동 링크는 그대로(회귀)", () => {
    const { container } = renderWithClient(
      <MessageBody bodyMd={"**중요**합니다, **bold** and *em*, ~~gone~~, https://example.com/ko 를 보라"} />,
    );
    expect(strongs(container)).toEqual(["중요", "bold"]);
    expect(container.querySelector("em")).toHaveTextContent("em");
    expect(container.querySelector("del")).toHaveTextContent("gone");
    expect(screen.getByRole("link", { name: "https://example.com/ko" })).toHaveAttribute(
      "href",
      "https://example.com/ko",
    );
  });

  it("코드 블록은 <pre>", () => {
    const { container } = renderWithClient(<MessageBody bodyMd={"```ts\nconst a = 1;\n```"} />);
    expect(container.querySelector("pre")).toHaveTextContent("const a = 1;");
  });

  it("원시 HTML 은 글자로만 남는다(실행·서식 요소 없음)", () => {
    const { container } = renderWithClient(
      <MessageBody bodyMd={'<script>alert(1)</script> <b>굵게</b> <img src="x" onerror="alert(1)">'} />,
    );
    expect(container).toHaveTextContent("<script>alert(1)</script>");
    expect(container).toHaveTextContent("<b>굵게</b>");
    expect(container.querySelector("script, b, img")).toBeNull();
  });

  it("외부 링크는 새 탭(noopener noreferrer), javascript:·data: 링크·이미지는 실행 가능한 주소로 남지 않는다", () => {
    const { container } = renderWithClient(
      <MessageBody
        bodyMd={
          "[문서](https://example.com/doc) [나쁜](javascript:alert(1)) " +
          "[데이터](data:text/html;base64,PHNjcmlwdD4=) ![점](data:image/png;base64,iVBORw0KGgo=)"
        }
      />,
    );
    expect(screen.queryByRole("link", { name: "데이터" })).toBeNull();
    expect(container.querySelector('[href^="data:"], [src^="data:"], img')).toBeNull();
    const link = screen.getByRole("link", { name: "문서" });
    expect(link).toHaveAttribute("href", "https://example.com/doc");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: "나쁜" })).toBeNull();
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^\s*javascript:/i);
    }
  });

  it("외부 이미지는 불러오지 않는다 — 새 탭 링크 「이미지: alt」, 링크 안 이미지는 글자만(링크 안 링크 없음)", () => {
    const { container } = renderWithClient(
      <MessageBody
        bodyMd={
          "![고양이](https://example.com/cat.png)\n\n[![배지](https://example.com/b.svg)](https://example.com/repo)"
        }
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    const image = screen.getByRole("link", { name: "이미지: 고양이" });
    expect(image).toHaveAttribute("href", "https://example.com/cat.png");
    expect(image).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "이미지: 배지" })).toHaveAttribute(
      "href",
      "https://example.com/repo",
    );
    expect(container.querySelector("a a")).toBeNull();
  });

  it("작성기에 친 블록 표시는 받은 쪽에서도 평문 — 직렬화 이스케이프 왕복", () => {
    const typed = ["# 제목", "> 인용", "- 항목", "1. 첫째"];
    const bodyMd = toBodyMd({
      type: "doc",
      content: typed.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
    });
    const { container } = renderWithClient(<MessageBody bodyMd={bodyMd} />);
    for (const text of typed) expect(screen.getByText(text)).toBeInTheDocument();
    expect(container.querySelector("h1, h2, h3, blockquote, ul, ol")).toBeNull();
  });
});

describe("SystemCard", () => {
  it.each([
    ["relay_limit", "주의"],
    ["relay_denied", "주의"],
    ["run_error", "오류"],
    ["info", "정보"],
  ] as const)("%s → 아이콘 「%s」 + 본문", (kind: SystemKind, label) => {
    const message = msg(1, {
      kind: "system",
      authorType: "system",
      authorId: undefined,
      bodyMd: `${kind} 알림`,
      systemMeta: { kind },
    });
    renderWithClient(<SystemCard message={message} />);
    const card = screen.getByRole("note");
    expect(within(card).getByRole("img", { name: label })).toBeInTheDocument();
    expect(card).toHaveTextContent(`${kind} 알림`);
  });

  // 서버(router/service 의 CONTINUE_RELAY_COMPONENTS)가 만드는 카드 모양 그대로 — 그 id 를 서버가 가로채 릴레이를 잇는다.
  // 렌더러를 갈아 끼우며 이것이 조용히 깨지면 사용자는 릴레이 상한을 못 뚫는다
  it("「이어가기」 시스템 카드의 버튼이 그대로 동작한다", async () => {
    fake = createFakeSocket();
    fake.onAck("component.interact", () => ({ ok: true, data: { interactionId: uid(500) } }));
    useWireStatus.getState().setStatus("connected");
    const message = msg(1, {
      kind: "system",
      authorType: "system",
      authorId: undefined,
      bodyMd: "릴레이 한도에 도달했습니다.",
      systemMeta: {
        kind: "relay_limit",
        relay: { fromAgentId: AGENT, toAgentId: uid(12), sourceRunId: uid(101), rootMessageId: uid(10_000) },
      },
      components: ComponentsV1.parse({
        id: "cmp_relay",
        blocks: [
          {
            type: "actions",
            items: [{ type: "button", id: "continue_relay", label: "이어가기", style: "primary" }],
          },
        ],
      }),
      componentState: { expiresAt: "2999-01-01T00:00:00.000Z", consumed: [] },
    });
    renderWithClient(<SystemCard message={message} />);
    const button = within(screen.getByRole("note")).getByRole("button", { name: "이어가기" });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(fake.sentOf("component.interact")).toEqual([
      { messageId: message.id, componentId: "cmp_relay", itemId: "continue_relay", values: {} },
    ]);
  });
});

describe("MessageItem", () => {
  it("에이전트: 이름·「AI」 배지·시각, 아바타 테두리는 에이전트 색", () => {
    const message = msg(1, { authorType: "agent", authorId: AGENT, bodyMd: "안녕하세요" });
    renderWithClient(<MessageItem message={message} head />);
    const row = screen.getByRole("article");
    expect(within(row).getByText("Dev")).toBeInTheDocument();
    expect(within(row).getByText("AI")).toBeInTheDocument();
    expect(within(row).getByText("안녕하세요")).toBeInTheDocument();
    expect(row.querySelector("time")).toHaveAttribute("datetime", message.createdAt);
    const avatar = row.querySelector("[data-slot=avatar]") as HTMLElement;
    expect(avatar.style.borderColor).toBe(agentColorVar("dev"));
  });

  it("사람: 이름, 배지·테두리 없음. 머리가 아니면 이름·아바타를 그리지 않는다", () => {
    renderWithClient(
      <>
        <MessageItem message={msg(1, { bodyMd: "첫째" })} head />
        <MessageItem message={msg(2, { bodyMd: "둘째" })} head={false} />
      </>,
    );
    const [first, second] = screen.getAllByRole("article") as [HTMLElement, HTMLElement];
    expect(within(first).getByText("주인")).toBeInTheDocument();
    expect(within(first).queryByText("AI")).toBeNull();
    expect(first.querySelector<HTMLElement>("[data-slot=avatar]")?.style.borderColor).toBe("");
    expect(within(second).queryByText("주인")).toBeNull();
    expect(second.querySelector("[data-slot=avatar]")).toBeNull();
    expect(second).toHaveTextContent("둘째");
    // 묶인 행의 시각도 스크린 리더가 읽는다 — 투명도로만 숨기고 visibility:hidden(invisible)은 쓰지 않는다
    const time = within(second).getByRole("time");
    expect(time).toHaveAttribute("title", expect.stringMatching(/\d/));
    expect(time).not.toHaveClass("invisible");
  });

  it("모르는 작성자(지워진 에이전트)는 「알 수 없음」", () => {
    renderWithClient(<MessageItem message={msg(1, { authorType: "agent", authorId: uid(77) })} head />);
    expect(within(screen.getByRole("article")).getByText("알 수 없음")).toBeInTheDocument();
  });
});

describe("PendingItem", () => {
  const pending = (state: PendingMessage["state"]): PendingMessage => ({
    clientMsgId: "c-1",
    channelId: "ch",
    bodyMd: "보낼 말",
    createdAt: "2027-01-15T08:00:00.000Z",
    state,
  });

  it("보내는 중: 흐린 본문 + 스피너, 버튼 없음", () => {
    renderWithClient(<PendingItem pending={pending("sending")} />);
    expect(screen.getByRole("status", { name: "보내는 중" })).toBeInTheDocument();
    expect(screen.getByText("보낼 말")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("실패: 「다시 보내기」·「삭제」가 컨텍스트의 retry·discard 를 clientMsgId 로 부른다", async () => {
    const actions = { retry: vi.fn(), discard: vi.fn() };
    renderWithClient(
      <PendingActionsContext.Provider value={actions}>
        <PendingItem pending={pending("failed")} />
      </PendingActionsContext.Provider>,
    );
    expect(screen.getByText("전송 실패")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "보내는 중" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "다시 보내기" }));
    await userEvent.click(screen.getByRole("button", { name: "삭제" }));
    expect(actions.retry).toHaveBeenCalledWith("c-1");
    expect(actions.discard).toHaveBeenCalledWith("c-1");
  });

  it("실패인데 컨텍스트가 없으면 버튼을 그리지 않는다", () => {
    renderWithClient(<PendingItem pending={pending("failed")} />);
    expect(screen.getByText("전송 실패")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

it("각주 같은 해시 링크는 새 탭이 아니라 이 메시지 안에서 그 자리로 옮긴다", async () => {
  const scrolled: Element[] = [];
  // jsdom 에는 scrollIntoView 가 없다
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this);
  };
  const { container } = renderWithClient(
    <article>
      <MessageBody bodyMd={"본문[^1] 입니다.\n\n[^1]: 각주 내용"} />
    </article>,
  );
  const ref = screen.getByRole("link", { name: "1" });
  expect(ref).toHaveAttribute("href", "#user-content-fn-1");
  expect(ref).not.toHaveAttribute("target");
  expect(ref).not.toHaveAttribute("rel");

  await userEvent.click(ref);
  expect(scrolled).toHaveLength(1);
  expect(scrolled[0]).toBe(container.querySelector("#user-content-fn-1"));
  // 바깥 링크는 그대로 새 탭
  expect(screen.queryAllByRole("link", { name: /↩/ })[0]).not.toHaveAttribute("target");
});

import { type Attachment, type Block, ComponentsV1, type Message } from "@dodok/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { msg } from "../../../../test/fixtures";
import { renderWithClient } from "../../../../test/messages";
import { Components } from "../Components";
import { ATTACHMENT_MISSING, LINK_BLOCKED } from "./artifact";

// 블록 렌더만 본다 — 소켓 없음(WireProvider 밖과 같다)
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: undefined, subscriptions: undefined }),
}));
afterEach(() => {
  vi.restoreAllMocks();
});

/** 에이전트가 보낸 카드 하나 — 블록은 shared 스키마를 통과시켜 계약과 맞춘다. `attachments` 는 그 메시지의 첨부 */
function card(blocks: unknown[], attachments: Attachment[] = []): Message {
  return msg(1, {
    attachments,
    components: ComponentsV1.parse({ id: "cmp_1", blocks }),
    componentState: { expiresAt: "2999-01-01T00:00:00.000Z", consumed: [] },
  });
}

function show(blocks: unknown[], attachments: Attachment[] = []) {
  return renderWithClient(<Components message={card(blocks, attachments)} />);
}

/** 카드 안 블록들의 data-slot, 배열 순서대로 */
const slots = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-slot=components] > *"), (e) => e.getAttribute("data-slot"));

const IMG = "https://example.com/cat.png";
/** 그 메시지의 첨부에 없는 이름 */
const ART = "artifact://files/abc";
const ID1 = "01a0cc16-22ee-7018-826c-e4783d25fa14";
const ID2 = "01a0cc16-22ee-7018-826c-e4783d25fa15";
const CHART: Attachment = {
  id: ID1,
  kind: "image",
  url: `artifact://${ID1}`,
  name: "chart.png",
  mime: "image/png",
  size: 10,
  width: 400,
  height: 300,
};
const DATA: Attachment = {
  id: ID2,
  kind: "file",
  url: `artifact://${ID2}`,
  name: "data.csv",
  mime: "text/csv",
  size: 20,
};

describe("Components — 다섯 종류가 모두 그려진다", () => {
  it("section·separator·media·file 이 배열 순서대로 — 빈 자리가 없다", () => {
    const { container } = show([
      { type: "section", text: "머리" },
      { type: "separator" },
      { type: "media", items: [{ url: IMG, alt: "고양이" }] },
      { type: "file", url: "https://example.com/a.pdf", name: "a.pdf" },
    ]);
    expect(slots(container)).toEqual(["section", "separator", "media", "file"]);
  });
});

describe("section", () => {
  /** Streamdown 은 굵은 글씨를 data-streamdown="strong" 을 붙인 <span> 으로 그린다(render.test 와 같은 규칙) */
  it("마크다운으로 그린다 — 메시지 본문과 같은 규칙(굵게는 strong, 원시 HTML 은 글자, 이미지는 링크)", () => {
    const { container } = show([
      { type: "section", text: "**굵게** <b>원시</b>\n\n![그림](https://example.com/p.png)" },
    ]);
    const section = container.querySelector("[data-slot=section]") as HTMLElement;
    expect(section.querySelector('[data-streamdown="strong"]')).toHaveTextContent("굵게");
    expect(section).toHaveTextContent("<b>원시</b>");
    expect(section.querySelector("b, img")).toBeNull();
    expect(within(section).getByRole("link", { name: "이미지: 그림" })).toHaveAttribute(
      "href",
      "https://example.com/p.png",
    );
  });
});

describe("separator", () => {
  it("구분선 하나", () => {
    show([{ type: "section", text: "위" }, { type: "separator" }, { type: "section", text: "아래" }]);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });
});

describe("media", () => {
  it("https 이미지는 불러오되 referrerPolicy=no-referrer·loading=lazy", () => {
    show([{ type: "media", items: [{ url: IMG, alt: "미리보기" }] }]);
    const img = screen.getByRole("img", { name: "미리보기" });
    expect(img).toHaveAttribute("src", IMG);
    expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(img).toHaveAttribute("loading", "lazy");
  });

  it("alt 가 없으면 장식으로 — 빈 alt, 접근 이름이 없다", () => {
    const { container } = show([{ type: "media", items: [{ url: IMG }] }]);
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("그 메시지의 첨부에 없는 artifact:// 는 이미지를 만들지 않고 「첨부를 찾을 수 없습니다」", () => {
    const { container } = show([{ type: "media", items: [{ url: ART, alt: "도표" }] }], [CHART]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(`[src="${ART}"], [href="${ART}"]`)).toBeNull();
    // 문구는 첨부 스펙 6.3 그대로
    expect(screen.getByText("첨부를 찾을 수 없습니다")).toBeInTheDocument();
  });

  it("artifact://<이름> 이 이미지 첨부로 풀리면 자기 서버 이미지 — 누르면 크게 보기·원본 내려받기", async () => {
    const user = userEvent.setup();
    const { container } = show(
      [
        {
          type: "media",
          items: [
            { url: "artifact://chart.png", alt: "월간 도표" },
            { url: IMG, alt: "고양이" },
          ],
        },
      ],
      [CHART],
    );
    const img = container.querySelector(`img[src="/api/v1/attachments/${ID1}"]`);
    expect(img).toHaveAttribute("alt", "월간 도표");
    expect(img).toHaveAttribute("width", "400");
    expect(container.querySelector(`[src="artifact://chart.png"]`)).toBeNull();
    await user.click(screen.getByRole("button", { name: "월간 도표 크게 보기" }));
    expect(screen.getByRole("dialog", { name: "월간 도표" })).toHaveAccessibleDescription("1 / 2");
    expect(screen.getByRole("link", { name: "원본 내려받기" })).toHaveAttribute(
      "href",
      `/api/v1/attachments/${ID1}?download=1`,
    );
    // 이 블록 안의 https 이미지로 넘어간다 — 내려받기 링크는 없다(결정 8)
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("dialog", { name: "고양이" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "원본 내려받기" })).toBeNull();
  });

  it("https 이미지도 크게 보기가 된다 — alt 가 없으면 「이미지」", async () => {
    const user = userEvent.setup();
    show([{ type: "media", items: [{ url: IMG }] }]);
    await user.click(screen.getByRole("button", { name: "이미지 크게 보기" }));
    expect(screen.getByRole("dialog", { name: "이미지" })).toBeInTheDocument();
  });

  it("artifact:// 가 파일 첨부로 풀리면 그 칸은 파일 카드", () => {
    const { container } = show([{ type: "media", items: [{ url: `artifact://${ID2}` }] }], [DATA]);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "data.csv 내려받기" })).toHaveAttribute(
      "href",
      `/api/v1/attachments/${ID2}`,
    );
  });

  it("항목별로 갈린다 — https 는 그리고 못 찾은 artifact 항목만 「첨부를 찾을 수 없습니다」", () => {
    const { container } = show([
      {
        type: "media",
        items: [
          { url: IMG, alt: "하나" },
          { url: ART, alt: "둘" },
          { url: "https://example.com/dog.png", alt: "셋" },
        ],
      },
    ]);
    expect(screen.getAllByRole("img").map((i) => i.getAttribute("alt"))).toEqual(["하나", "셋"]);
    expect(screen.getAllByText(ATTACHMENT_MISSING)).toHaveLength(1);
    // 못 찾은 칸도 격자 칸 하나를 차지한다 — 항목 순서 그대로
    const grid = container.querySelector("[data-slot=media]") as HTMLElement;
    expect(grid.children).toHaveLength(3);
    expect(grid.children[1]).toHaveTextContent(ATTACHMENT_MISSING);
  });

  it("격자는 항목 수에 따라 1~3열", () => {
    const one = show([{ type: "media", items: [{ url: IMG }] }]);
    expect(one.container.querySelector("[data-slot=media]")).toHaveClass("grid-cols-1");
    one.unmount();
    const two = show([{ type: "media", items: [{ url: IMG }, { url: IMG }] }]);
    expect(two.container.querySelector("[data-slot=media]")).toHaveClass("grid-cols-2");
    two.unmount();
    const four = show([{ type: "media", items: [{ url: IMG }, { url: IMG }, { url: IMG }, { url: IMG }] }]);
    expect(four.container.querySelector("[data-slot=media]")).toHaveClass("grid-cols-3");
  });

  it("불러오기에 실패하면 깨진 그림 대신 새 탭 링크 「이미지: alt」 — alt 가 없으면 주소", () => {
    const { container } = show([
      {
        type: "media",
        items: [{ url: IMG, alt: "고양이" }, { url: "https://example.com/x.png" }],
      },
    ]);
    for (const img of container.querySelectorAll("img")) fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    const cat = screen.getByRole("link", { name: "이미지: 고양이" });
    expect(cat).toHaveAttribute("href", IMG);
    expect(cat).toHaveAttribute("target", "_blank");
    expect(cat).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "이미지: https://example.com/x.png" })).toHaveAttribute(
      "href",
      "https://example.com/x.png",
    );
  });
});

describe("file", () => {
  it("https 는 이름·크기와 「열기」 링크 — target=_blank rel=noopener noreferrer", () => {
    const { container } = show([
      { type: "file", url: "https://example.com/report.pdf", name: "report.pdf", size: 1536 },
    ]);
    const row = container.querySelector("[data-slot=file]") as HTMLElement;
    expect(row).toHaveTextContent("report.pdf");
    expect(row).toHaveTextContent("1.5 KB");
    const open = within(row).getByRole("link", { name: "report.pdf 열기" });
    expect(open).toHaveTextContent("열기");
    expect(open).toHaveAttribute("href", "https://example.com/report.pdf");
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("그 메시지의 첨부에 없는 artifact:// 는 링크가 아니라 「첨부를 찾을 수 없습니다」 — 이름은 남는다", () => {
    const { container } = show([{ type: "file", url: ART, name: "data.csv", size: 10 }], [DATA]);
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector(`[href="${ART}"]`)).toBeNull();
    const row = container.querySelector("[data-slot=file]") as HTMLElement;
    expect(row).toHaveTextContent("data.csv");
    expect(within(row).getByText(ATTACHMENT_MISSING)).toBeInTheDocument();
  });

  it("artifact:// 가 첨부로 풀리면 파일 카드 — 표시 이름은 블록의 name, 크기·종류는 첨부, 내려받기는 자기 서버 경로", () => {
    const { container } = show(
      [{ type: "file", url: "artifact://data.csv", name: "3분기 자료", size: 999 }],
      [DATA],
    );
    const row = container.querySelector("[data-slot=file]") as HTMLElement;
    expect(row).toHaveTextContent("3분기 자료");
    expect(within(row).getByText("20 B")).toBeInTheDocument();
    expect(within(row).getByText("텍스트")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "3분기 자료 내려받기" })).toHaveAttribute(
      "href",
      `/api/v1/attachments/${ID2}`,
    );
  });

  it("size 가 없으면 크기를 적지 않는다", () => {
    const { container } = show([{ type: "file", url: "https://example.com/a.txt", name: "a.txt" }]);
    expect(container.querySelector("[data-slot=file-size]")).toBeNull();
    expect(container.querySelector("[data-slot=file]")).not.toHaveTextContent(/B\b|NaN|undefined/);
  });

  it("크기는 사람이 읽는 단위로 — B·KB·MB·GB, 음수는 적지 않는다", () => {
    const sizes = [0, 512, 1024, 10 * 1024 * 1024 + 300 * 1024, 3 * 1024 ** 3, -1];
    const { container } = show(
      sizes.map((size, i) => ({ type: "file", url: `https://example.com/${i}`, name: `f${i}`, size })),
    );
    const rows = Array.from(
      container.querySelectorAll("[data-slot=file]"),
      (r) => r.querySelector("[data-slot=file-size]")?.textContent ?? null,
    );
    expect(rows).toEqual(["0 B", "512 B", "1 KB", "10.3 MB", "3 GB", null]);
  });
});

describe("media·file — 계약 밖 주소", () => {
  it("https:// 로 시작해야만 img·링크가 된다 — javascript:·data:·http:·대문자 HTTPS://·가운데·앞 공백 https://·상대 주소 // 와 / 는 「열 수 없는 링크입니다」", () => {
    const OK_IMG = "https://example.com/ok.png";
    const OK_FILE = "https://example.com/ok.pdf";
    const BAD = [
      "javascript:alert(1)",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "http://example.com/x.png",
      "HTTPS://example.com/x.png",
      // https:// 를 가운데 품은 값 — 접두사 검사가 includes·indexOf 로 느슨해지는 것을 잡는다
      "http://evil.example/?next=https://ok.example",
      // 앞에 공백 — 검사 전에 trim 으로 느슨해지는 것을 잡는다(계약 SafeUrl 도 ^https:// 라 거절한다)
      " https://example.com/x.png",
      // 프로토콜 상대 주소 — 「상대 주소는 안전」으로 / 를 허용하는 것을 잡는다. //host 는 다른 출처다
      "//evil.example/x.png",
      // 같은 출처 경로 — // 만 막고 / 는 허용하는 것을 잡는다. img·링크가 쿠키 실린 같은 출처 GET 이 된다
      "/api/me",
      // artifact:// 를 닮았지만 아닌 값 — 첨부 문구가 아니라 「열 수 없음」이어야 한다(링크 버튼과 같다)
      "ARTIFACT://files/x",
      " artifact://files/x",
      "artifact:/files/x",
    ];
    // card() 의 ComponentsV1.parse 를 건너뛴다 — 계약이 먼저 거르면 렌더러의 허용목록이 안 잠긴다.
    // 서버는 쓸 때만 검증하므로 옛 행·느슨해진 계약의 값은 여기까지 온다(url 의 TS 타입은 string 이라 캐스트 없이 들어간다)
    const components: ComponentsV1 = {
      id: "cmp_1",
      reusable: false,
      ttlMs: 1_800_000,
      blocks: [
        { type: "media", items: [{ url: OK_IMG, alt: "통과" }, ...BAD.map((url) => ({ url, alt: url }))] },
        { type: "file", url: OK_FILE, name: "ok.pdf" },
        ...BAD.map((url): Block => ({ type: "file", url, name: url })),
      ],
    };
    const { container } = renderWithClient(<Components message={{ ...card([]), components }} />);
    const attrs = (sel: string, attr: string) =>
      Array.from(container.querySelectorAll(sel), (e) => e.getAttribute(attr));
    expect(attrs("img", "src")).toEqual([OK_IMG]);
    expect(attrs("a", "href")).toEqual([OK_FILE]);
    // 막힌 값은 media 칸·file 줄마다 문구 하나씩 — 링크 버튼과 같은 말(첨부 스펙 6.3, 이월 「media·file 문구 비대칭」)
    expect(screen.getAllByText(LINK_BLOCKED)).toHaveLength(BAD.length * 2);
    expect(screen.queryByText(ATTACHMENT_MISSING)).toBeNull();
  });
});

describe("긴 라벨 — 카드 안 버튼은 줄을 바꾼다", () => {
  // 계약은 버튼 라벨·triggerLabel 을 80자까지 받는다. 공용 ui/button 은 whitespace-nowrap·shrink-0 이라 390px 에서 카드 밖으로
  // 넘쳤다 — 카드 안 버튼만 줄바꿈과 줄 폭 상한을 받는다(jsdom 은 배치를 재지 못해 클래스로 본다, 실측은 브라우저)
  const LONG = "이 작업을 지금 바로 시작하고 끝나면 결과를 채널에 요약해서 올려 주세요 부탁합니다 정말로";
  const wraps = (el: HTMLElement) => {
    expect(el).toHaveClass("whitespace-normal", "max-w-full", "h-auto");
    expect(el).not.toHaveClass("whitespace-nowrap", "shrink-0", "h-8");
  };

  it("액션 버튼·링크 버튼·막힌 링크 버튼·모달 트리거", () => {
    renderWithClient(
      <Components
        message={msg(1, {
          components: ComponentsV1.parse({
            id: "cmp_1",
            blocks: [
              {
                type: "actions",
                items: [
                  { type: "button", id: "go", label: LONG },
                  {
                    type: "button",
                    id: "link",
                    label: `링크 ${LONG}`.slice(0, 80),
                    url: "https://example.com/",
                  },
                  { type: "button", id: "gone", label: `없음 ${LONG}`.slice(0, 80), url: ART },
                ],
              },
            ],
            modal: {
              id: "form",
              title: "새 작업",
              triggerLabel: `모달 ${LONG}`.slice(0, 80),
              fields: [{ type: "text", id: "title", label: "제목" }],
            },
          }),
          componentState: { expiresAt: "2999-01-01T00:00:00.000Z", consumed: [] },
        })}
      />,
    );
    wraps(screen.getByRole("button", { name: LONG }));
    wraps(screen.getByRole("link", { name: `링크 ${LONG}`.slice(0, 80) }));
    wraps(screen.getByRole("button", { name: `없음 ${LONG}`.slice(0, 80) }));
    wraps(screen.getByRole("button", { name: `모달 ${LONG}`.slice(0, 80) }));
  });
});

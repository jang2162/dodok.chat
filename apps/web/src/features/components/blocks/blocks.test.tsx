import { type Block, ComponentsV1, type Message } from "@dodok/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { msg } from "../../../../test/fixtures";
import { renderWithClient } from "../../../../test/messages";
import { Components } from "../Components";
import { ARTIFACT_PENDING } from "./artifact";

// 블록 렌더만 본다 — 소켓 없음(WireProvider 밖과 같다)
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: undefined, subscriptions: undefined }),
}));
afterEach(() => {
  vi.restoreAllMocks();
});

/** 에이전트가 보낸 카드 하나 — 블록은 shared 스키마를 통과시켜 계약과 맞춘다 */
function card(blocks: unknown[]): Message {
  return msg(1, {
    components: ComponentsV1.parse({ id: "cmp_1", blocks }),
    componentState: { expiresAt: "2999-01-01T00:00:00.000Z", consumed: [] },
  });
}

function show(blocks: unknown[]) {
  return renderWithClient(<Components message={card(blocks)} />);
}

/** 카드 안 블록들의 data-slot, 배열 순서대로 */
const slots = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-slot=components] > *"), (e) => e.getAttribute("data-slot"));

const IMG = "https://example.com/cat.png";
const ART = "artifact://files/abc";

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

  it("artifact:// 는 이미지를 만들지 않고 자리표시로", () => {
    const { container } = show([{ type: "media", items: [{ url: ART, alt: "도표" }] }]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(`[src="${ART}"], [href="${ART}"]`)).toBeNull();
    // 문구는 스펙 5.2 그대로
    expect(screen.getByText(/첨부는 곧 지원합니다/)).toBeInTheDocument();
  });

  it("항목별로 갈린다 — https 는 그리고 artifact 항목만 자리표시", () => {
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
    expect(screen.getAllByText(ARTIFACT_PENDING)).toHaveLength(1);
    // 자리표시도 격자 칸 하나를 차지한다 — 항목 순서 그대로
    const grid = container.querySelector("[data-slot=media]") as HTMLElement;
    expect(grid.children).toHaveLength(3);
    expect(grid.children[1]).toHaveTextContent(ARTIFACT_PENDING);
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

  it("artifact:// 는 링크가 아니라 자리표시 — 이름은 남는다", () => {
    const { container } = show([{ type: "file", url: ART, name: "data.csv", size: 10 }]);
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector(`[href="${ART}"]`)).toBeNull();
    const row = container.querySelector("[data-slot=file]") as HTMLElement;
    expect(row).toHaveTextContent("data.csv");
    expect(within(row).getByText(ARTIFACT_PENDING)).toBeInTheDocument();
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
  it("https:// 로 시작해야만 img·링크가 된다 — javascript:·data:·http:·대문자 HTTPS://·가운데·앞 공백 https://·상대 주소 // 와 / 는 자리표시로", () => {
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
    // 막힌 값은 media 칸·file 줄마다 자리표시 하나씩
    expect(screen.getAllByText(ARTIFACT_PENDING)).toHaveLength(BAD.length * 2);
  });
});

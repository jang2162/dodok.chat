import { type Attachment, ComponentsV1 } from "@dodok/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LINK_BLOCKED } from "@/features/components/blocks/artifact";
import { MessageItem } from "@/features/messages/MessageItem";
import { msg } from "../../../test/fixtures";
import { renderWithClient } from "../../../test/messages";
import { MessageAttachments } from "./MessageAttachments";

// MessageItem 의 components 카드 — 소켓 없음(WireProvider 밖과 같다)
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: undefined, subscriptions: undefined }),
}));

const ID1 = "01a0cc16-22ee-7018-826c-e4783d25fa14";
const ID2 = "01a0cc16-22ee-7018-826c-e4783d25fa15";
const ID3 = "01a0cc16-22ee-7018-826c-e4783d25fa16";

const image = (id: string, name: string, width: number, height: number): Attachment => ({
  id,
  kind: "image",
  url: `artifact://${id}`,
  name,
  mime: "image/png",
  size: 10,
  width,
  height,
});
const chart = image(ID1, "chart.png", 4, 3);
const report: Attachment = {
  id: ID2,
  kind: "file",
  url: `artifact://${ID2}`,
  name: "report.pdf",
  mime: "application/pdf",
  size: 20,
};

/** 이미지를 감싼 「크게 보기」 버튼 */
const opener = (name: string) => screen.getByRole("button", { name: `${name} 크게 보기` });

describe("MessageAttachments — 이미지(스펙 6.2)", () => {
  it("한 장: 같은 출처 경로·이름 alt·lazy·저장된 가로·세로, 감싼 버튼은 「<이름> 크게 보기」", () => {
    render(<MessageAttachments attachments={[chart]} />);
    const button = opener("chart.png");
    const img = button.querySelector("img") as HTMLImageElement;
    expect(img).toHaveAttribute("src", `/api/v1/attachments/${ID1}`);
    expect(img).toHaveAttribute("alt", "chart.png");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("width", "4");
    expect(img).toHaveAttribute("height", "3");
  });

  it("[Review Focus 5] 아주 긴(300×6000)·아주 넓은(6000×300) 한 장은 360×320 상자 안에 비율대로 — 자리는 저장값으로", () => {
    const tall = render(<MessageAttachments attachments={[image(ID1, "tall.png", 300, 6000)]} />);
    const t = opener("tall.png");
    expect(t.style.aspectRatio).toBe("300 / 6000");
    // 높이 320 에 맞춘 너비 — 300 × 320/6000 = 16
    expect(t.style.width).toBe("16px");
    expect(t).toHaveClass("max-w-[360px]", "max-h-80");
    tall.unmount();

    render(<MessageAttachments attachments={[image(ID1, "wide.png", 6000, 300)]} />);
    const w = opener("wide.png");
    expect(w.style.aspectRatio).toBe("6000 / 300");
    expect(w.style.width).toBe("360px");
    // 칸이 360 보다 좁으면(폰) 너비가 줄고 높이는 비율이 따라온다
    expect(w.style.maxWidth).toBe("100%");
    expect(w).toHaveClass("max-w-[360px]", "max-h-80");
  });

  it("작은 이미지는 키우지 않는다 — 원래 너비 그대로", () => {
    render(<MessageAttachments attachments={[chart]} />);
    expect(opener("chart.png").style.width).toBe("4px");
  });

  it("두 장 이상이면 2열 격자", () => {
    const { container } = render(<MessageAttachments attachments={[chart, image(ID3, "b.png", 10, 10)]} />);
    const grid = container.querySelector("[data-slot=attachment-grid]") as HTMLElement;
    expect(grid).toHaveClass("grid-cols-2");
    expect(grid.children).toHaveLength(2);
  });

  it("못 불러오면 그 칸이 파일 카드 꼴로 물러난다 — 이름·「이미지를 불러오지 못했습니다」·내려받기", () => {
    const { container } = render(<MessageAttachments attachments={[chart]} />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("button", { name: "chart.png 크게 보기" })).toBeNull();
    expect(screen.getByText("이미지를 불러오지 못했습니다")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "chart.png 내려받기" })).toHaveAttribute(
      "href",
      `/api/v1/attachments/${ID1}`,
    );
  });
});

describe("MessageAttachments — 파일", () => {
  it("이름·크기·종류와 내려받기 — 기본 경로(서버가 attachment 로 준다)", () => {
    const { container } = render(<MessageAttachments attachments={[report]} />);
    const card = container.querySelector("[data-slot=file-card]") as HTMLElement;
    expect(card).toHaveTextContent("report.pdf");
    expect(within(card).getByText("20 B")).toBeInTheDocument();
    expect(within(card).getByText("PDF")).toBeInTheDocument();
    const link = within(card).getByRole("link", { name: "report.pdf 내려받기" });
    expect(link).toHaveAttribute("href", `/api/v1/attachments/${ID2}`);
    expect(link).toHaveTextContent("내려받기");
  });

  it("종류는 MIME 으로 — 이미지·텍스트, 그 밖은 확장자 대문자", () => {
    const f = (id: string, name: string, mime: string): Attachment => ({
      ...report,
      id,
      url: `artifact://${id}`,
      name,
      mime,
    });
    const { container } = render(
      <MessageAttachments
        attachments={[
          f(ID1, "a.svg", "image/svg+xml"),
          f(ID2, "notes.txt", "text/plain"),
          f(ID3, "data.zip", "application/zip"),
        ]}
      />,
    );
    expect(Array.from(container.querySelectorAll("[data-slot=file-kind]"), (e) => e.textContent)).toEqual([
      "이미지",
      "텍스트",
      "ZIP",
    ]);
  });

  it("자기 서버 경로로 못 푸는 첨부(https url)는 내려받기 없이 「열 수 없는 링크입니다」", () => {
    const { container } = render(
      <MessageAttachments attachments={[{ ...report, url: "https://e.com/report.pdf" }]} />,
    );
    const card = container.querySelector("[data-slot=file-card]") as HTMLElement;
    expect(within(card).queryByRole("link")).toBeNull();
    expect(card).toHaveTextContent(LINK_BLOCKED);
  });

  it("exclude 에 든 id 는 그리지 않는다", () => {
    const { container } = render(
      <MessageAttachments attachments={[chart, report]} exclude={new Set([ID1])} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("report.pdf");
  });

  it("그릴 것이 없으면 아무것도 없다", () => {
    const { container } = render(<MessageAttachments attachments={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("MessageItem — 본문 아래 첨부", () => {
  it("카드가 가리킨 첨부는 카드 아래에 다시 그리지 않는다", () => {
    const message = msg(1, {
      attachments: [chart, report],
      components: ComponentsV1.parse({
        id: "cmp_1",
        blocks: [{ type: "media", items: [{ url: "artifact://chart.png" }] }],
      }),
      componentState: { expiresAt: "2999-01-01T00:00:00.000Z", consumed: [] },
    });
    const { container } = renderWithClient(<MessageItem message={message} head />);
    // 이미지는 카드 안에서 한 번만
    expect(container.querySelectorAll(`img[src="/api/v1/attachments/${ID1}"]`)).toHaveLength(1);
    expect(container.querySelector("[data-slot=components] img")).not.toBeNull();
    // 카드가 안 가리킨 파일은 본문 아래에
    expect(screen.getByRole("link", { name: "report.pdf 내려받기" })).toBeInTheDocument();
  });

  it("글 없는 이미지 메시지는 빈 본문 단락을 그리지 않는다", () => {
    const { container } = renderWithClient(
      <MessageItem message={msg(1, { bodyMd: "", attachments: [chart] })} head />,
    );
    // 내용 칸: 머리 줄 다음이 곧 첨부 — 사이에 빈 본문이 없다
    const column = container.querySelector("article")?.children[1] as HTMLElement;
    expect(column.children).toHaveLength(2);
    expect(column.children[1]).toHaveAttribute("data-slot", "attachments");
    expect(opener("chart.png")).toBeInTheDocument();
  });
});

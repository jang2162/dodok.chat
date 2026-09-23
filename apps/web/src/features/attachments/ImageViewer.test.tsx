import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useImageViewer, type ViewerImage } from "./ImageViewer";

const IMAGES: ViewerImage[] = [
  { src: "/api/v1/attachments/a", name: "하나.png", downloadHref: "/api/v1/attachments/a?download=1" },
  { src: "/api/v1/attachments/b", name: "둘.png", downloadHref: "/api/v1/attachments/b?download=1" },
  { src: "/api/v1/attachments/c", name: "셋.png", downloadHref: "/api/v1/attachments/c?download=1" },
];

/** 이미지마다 여는 버튼 하나 — 메시지 첨부·media 블록이 쓰는 방식 그대로 */
function Harness({ images }: { images: ViewerImage[] }) {
  const { open, viewer } = useImageViewer(images);
  return (
    <>
      {images.map((im, i) => (
        <button key={im.src} type="button" onClick={(e) => open(i, e.currentTarget)}>
          {im.name} 크게 보기
        </button>
      ))}
      {viewer}
    </>
  );
}

describe("ImageViewer — 크게 보기(스펙 6.4)", () => {
  it("열면 대화상자 이름이 그 이미지 이름, n / 전체, 원본 내려받기는 ?download=1", async () => {
    const user = userEvent.setup();
    render(<Harness images={IMAGES} />);
    await user.click(screen.getByRole("button", { name: "둘.png 크게 보기" }));
    const dialog = screen.getByRole("dialog", { name: "둘.png" });
    expect(dialog).toHaveAccessibleDescription("2 / 3");
    expect(screen.getByRole("img", { name: "둘.png" })).toHaveAttribute("src", "/api/v1/attachments/b");
    expect(screen.getByRole("link", { name: "원본 내려받기" })).toHaveAttribute(
      "href",
      "/api/v1/attachments/b?download=1",
    );
  });

  it("→·← 로 넘기고 끝에서 멈춘다 — 되돌지 않는다", async () => {
    const user = userEvent.setup();
    render(<Harness images={IMAGES} />);
    await user.click(screen.getByRole("button", { name: "둘.png 크게 보기" }));
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("dialog", { name: "셋.png" })).toHaveAccessibleDescription("3 / 3");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("dialog", { name: "셋.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다음 이미지" })).toBeDisabled();
    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("dialog", { name: "하나.png" })).toHaveAccessibleDescription("1 / 3");
    expect(screen.getByRole("button", { name: "이전 이미지" })).toBeDisabled();
    // 화살표 버튼도 같은 일을 한다
    await user.click(screen.getByRole("button", { name: "다음 이미지" }));
    expect(screen.getByRole("dialog", { name: "둘.png" })).toBeInTheDocument();
  });

  it("Esc 로 닫으면 초점이 연 버튼으로 돌아간다", async () => {
    const user = userEvent.setup();
    render(<Harness images={IMAGES} />);
    const trigger = screen.getByRole("button", { name: "셋.png 크게 보기" });
    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("닫기 버튼으로 닫아도 초점이 연 버튼으로", async () => {
    const user = userEvent.setup();
    render(<Harness images={IMAGES} />);
    const trigger = screen.getByRole("button", { name: "하나.png 크게 보기" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("https 이미지는 내려받기 링크가 없다 — 한 장이면 넘기기 버튼도 없다", async () => {
    const user = userEvent.setup();
    render(<Harness images={[{ src: "https://e.com/x.png", name: "바깥 그림" }]} />);
    await user.click(screen.getByRole("button", { name: "바깥 그림 크게 보기" }));
    const dialog = screen.getByRole("dialog", { name: "바깥 그림" });
    expect(dialog).toHaveAccessibleDescription("1 / 1");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: "다음 이미지" })).toBeNull();
    expect(screen.getByRole("img", { name: "바깥 그림" })).toHaveAttribute("referrerpolicy", "no-referrer");
  });
});

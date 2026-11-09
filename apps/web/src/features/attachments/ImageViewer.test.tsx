import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
    expect(screen.getByRole("button", { name: "다음 이미지" })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("dialog", { name: "하나.png" })).toHaveAccessibleDescription("1 / 3");
    expect(screen.getByRole("button", { name: "이전 이미지" })).toHaveAttribute("aria-disabled", "true");
    // 화살표 버튼도 같은 일을 한다
    await user.click(screen.getByRole("button", { name: "다음 이미지" }));
    expect(screen.getByRole("dialog", { name: "둘.png" })).toBeInTheDocument();
  });

  it("다음 버튼으로 끝에 닿아도 초점이 그 버튼에 남고 ← 가 먹는다 — disabled 가 아니라 aria-disabled", async () => {
    // disabled 가 되면 브라우저는 초점을 body 로 빼고 ←/→ 가 DialogContent 에 닿지 않는다(jsdom 은 blur 하지 않는다 —
    // 그래서 disabled 속성이 없다는 것도 따로 단언한다)
    const user = userEvent.setup();
    render(<Harness images={IMAGES} />);
    await user.click(screen.getByRole("button", { name: "하나.png 크게 보기" }));
    const next = screen.getByRole("button", { name: "다음 이미지" });
    await user.click(next);
    await user.click(next);
    expect(screen.getByRole("dialog", { name: "셋.png" })).toBeInTheDocument();
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(next).not.toHaveAttribute("disabled");
    expect(document.activeElement).toBe(next);
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("dialog", { name: "둘.png" })).toHaveAccessibleDescription("2 / 3");
  });

  it("끝에서 다음·처음에서 이전을 눌러도 장이 안 바뀐다", async () => {
    const user = userEvent.setup();
    render(<Harness images={IMAGES} />);
    await user.click(screen.getByRole("button", { name: "셋.png 크게 보기" }));
    await user.click(screen.getByRole("button", { name: "다음 이미지" }));
    expect(screen.getByRole("dialog", { name: "셋.png" })).toHaveAccessibleDescription("3 / 3");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    const prev = screen.getByRole("button", { name: "이전 이미지" });
    expect(prev).not.toHaveAttribute("disabled");
    await user.click(prev);
    expect(screen.getByRole("dialog", { name: "하나.png" })).toHaveAccessibleDescription("1 / 3");
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

  it("대화상자 제목의 이름은 <bdi> 로 격리한다 — 방향 제어 문자가 「n / 전체」 쪽으로 새지 않게", async () => {
    const user = userEvent.setup();
    const spoof = [{ ...IMAGES[0], name: "photo\u202Egnp.exe" } as ViewerImage];
    render(<Harness images={spoof} />);
    await user.click(screen.getByRole("button", { name: "photo\u202Egnp.exe 크게 보기" }));
    expect(screen.getByText("photo\u202Egnp.exe", { selector: "bdi" })).toBeInTheDocument();
  });

  it("onGoToMessage 가 있으면 「메시지로 가기」 — 누르면 닫고 부른다. 없으면 단추가 없다(메시지 본문의 격자)", async () => {
    const user = userEvent.setup();
    const go = vi.fn();
    const { unmount } = render(<Harness images={[{ ...(IMAGES[0] as ViewerImage), onGoToMessage: go }]} />);
    await user.click(screen.getByRole("button", { name: "하나.png 크게 보기" }));
    await user.click(screen.getByRole("button", { name: "메시지로 가기" }));
    expect(go).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    unmount();
    render(<Harness images={IMAGES} />);
    await user.click(screen.getByRole("button", { name: "하나.png 크게 보기" }));
    expect(screen.queryByRole("button", { name: "메시지로 가기" })).toBeNull();
  });
});

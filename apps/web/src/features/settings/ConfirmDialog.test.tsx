import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

/** 확인을 누르면 진행 중이 되고, `finish` 로 끝낸다(실패 — 대화상자는 열린 채) */
function Harness({ onConfirm, pends = true }: { onConfirm: () => void; pends?: boolean }) {
  const [pending, setPending] = useState(false);
  return (
    <>
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="토큰 삭제"
        description="되돌릴 수 없습니다"
        confirmLabel="삭제"
        pendingLabel="삭제하는 중…"
        pending={pending}
        destructive
        onConfirm={() => {
          onConfirm();
          if (pends) setPending(true);
        }}
      />
      <button type="button" onClick={() => setPending(false)}>
        finish
      </button>
    </>
  );
}

describe("ConfirmDialog", () => {
  it("확인을 같은 틱에 두 번 눌러도 한 번만 부른다 — 진행이 끝나면 다시 누를 수 있다", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const dialog = screen.getByRole("dialog", { name: "토큰 삭제" });
    const confirm = within(dialog).getByRole("button", { name: "삭제" });
    // 다시 그리기 전 같은 틱의 두 번 — 한 act 안이라 첫 누름의 setPending 이 아직 그려지지 않았다
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole("button", { name: "삭제하는 중…" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "finish", hidden: true }));
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it("진행 중이 되지 않은 확인(그려지기 전에 끝난 요청 등)은 한 틱 뒤 다시 누를 수 있다", async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} pends={false} />);
    const confirm = within(screen.getByRole("dialog", { name: "토큰 삭제" })).getByRole("button", {
      name: "삭제",
    });
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});

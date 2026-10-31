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

  it("실패로 진행이 끝나 대화상자가 열린 채면, 잠긴 동안 body 로 떨어진 초점을 확인 버튼으로 되돌린다", () => {
    render(<Harness onConfirm={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "토큰 삭제" });
    const confirm = within(dialog).getByRole("button", { name: "삭제" });
    fireEvent.click(confirm);
    expect(within(dialog).getByRole("button", { name: "삭제하는 중…" })).toBeDisabled();
    expect(confirm).not.toHaveFocus();
    // 브라우저는 잠긴 버튼의 초점을 body 로 치운다(실제 브라우저에서 잼). jsdom 에서는 대화상자의 초점 가둠이 blur 를 되돌리므로
    // 진행이 끝나는 순간의 activeElement 를 body 로 흉내 낸다
    const active = vi.spyOn(document, "activeElement", "get").mockReturnValue(document.body);
    fireEvent.click(screen.getByRole("button", { name: "finish", hidden: true }));
    active.mockRestore();
    expect(within(dialog).getByRole("button", { name: "삭제" })).toHaveFocus();
  });

  it("진행이 끝났을 때 초점이 다른 곳에 있으면 건드리지 않는다", () => {
    render(<Harness onConfirm={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "토큰 삭제" });
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
    const cancel = within(dialog).getByRole("button", { name: "취소" });
    act(() => cancel.focus());
    fireEvent.click(screen.getByRole("button", { name: "finish", hidden: true }));
    expect(cancel).toHaveFocus();
  });
});

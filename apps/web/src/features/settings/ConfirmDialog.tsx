import type { RefObject } from "react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";

/**
 * 확인 대화상자(제어형). 진행 중에는 닫히지 않는다 — 결과를 잃지 않게.
 * 여는 버튼이 트리거가 아니라(제어형) Radix 가 초점을 되돌릴 곳을 모른다 — `returnFocus` 로 받아 돌려준다.
 * 그 버튼이 사라졌으면(제거 성공) 아무것도 하지 않고, 부르는 쪽이 다른 자리로 옮긴다
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel,
  pending = false,
  destructive = false,
  returnFocus,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel?: string;
  pending?: boolean;
  destructive?: boolean;
  returnFocus?: RefObject<HTMLElement | null>;
  onConfirm: () => void;
}) {
  function change(next: boolean) {
    if (!next && pending) return;
    onOpenChange(next);
  }
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent
        onCloseAutoFocus={(e) => {
          if (!returnFocus?.current?.isConnected) return;
          e.preventDefault();
          returnFocus.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => change(false)}>
            취소
          </Button>
          <Button variant={destructive ? "destructive" : "default"} disabled={pending} onClick={onConfirm}>
            {pending && pendingLabel ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

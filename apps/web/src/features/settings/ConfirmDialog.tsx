import { type RefObject, useEffect, useRef, useState } from "react";
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
 * 그 버튼이 사라졌으면(제거 성공) 아무것도 하지 않고, 부르는 쪽이 다른 자리로 옮긴다.
 *
 * `escalated` 는 같은 대화상자에서 한 번 더 확인하는 단계다. 첫 확인의 두 번째 클릭(더블클릭)·두 번째 Enter·키 반복이 이 단계의
 * 확인으로 번지지 않게, 확인 버튼을 취소의 반대편(첫 확인 버튼이 있던 자리에는 취소)에 새 요소로 그리고 `ESCALATED_ARM_MS` 동안
 * 누를 수 없게 두며 초점은 취소로 옮긴다. 같은 요소에 라벨만 바꾸면 초점과 포인터가 그대로 남아 두 번째 입력이 곧장 확인이 된다
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
  escalated = false,
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
  escalated?: boolean;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  function change(next: boolean) {
    if (!next && pending) return;
    onOpenChange(next);
  }
  useEffect(() => {
    if (open && escalated) cancelRef.current?.focus();
  }, [open, escalated]);
  const cancel = (
    <Button ref={cancelRef} variant="outline" disabled={pending} onClick={() => change(false)}>
      취소
    </Button>
  );
  const confirm = (
    <ConfirmButton
      key={escalated ? "escalated" : "first"}
      armMs={escalated ? ESCALATED_ARM_MS : 0}
      destructive={destructive}
      pending={pending}
      open={open}
      label={pending && pendingLabel ? pendingLabel : confirmLabel}
      onConfirm={onConfirm}
    />
  );
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
        {/* 대화상자가 열린 채 제목이 바뀌면 스크린 리더가 다시 읽지 않는다 — 한 번 더 확인하는 단계의 제목을 여기서 알린다 */}
        <p aria-live="assertive" className="sr-only">
          {escalated ? title : ""}
        </p>
        <DialogFooter>
          {escalated ? (
            <>
              {confirm}
              {cancel}
            </>
          ) : (
            <>
              {cancel}
              {confirm}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 한 번 더 확인하는 단계의 확인 버튼이 나타난 뒤 누를 수 없는 시간 — 더블클릭 간격(OS 기본 500 ms 안팎)보다 길게 */
const ESCALATED_ARM_MS = 600;

function ConfirmButton({
  armMs,
  destructive,
  pending,
  open,
  label,
  onConfirm,
}: {
  armMs: number;
  destructive: boolean;
  pending: boolean;
  open: boolean;
  label: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(armMs === 0);
  useEffect(() => {
    if (armMs === 0) return;
    const timer = setTimeout(() => setArmed(true), armMs);
    return () => clearTimeout(timer);
  }, [armMs]);
  // 같은 틱의 두 번째 누름을 거른다 — `pending` 은 다시 그린 뒤에야 참이라 그 사이 누름이 요청을 한 번 더 보낸다(AgentRow 꼴).
  // 진행이 끝나면(`pending` 이 거짓으로) 다시 받는다. 누른 뒤 한 틱이 지나도 진행 중이 아니면(진행 없이 닫는 확인, 그려지기 전에
  // 이미 실패한 요청) 그때 푼다 — react-query 는 `mutate` 안에서 진행 알림 타이머를 먼저 걸므로 이 타이머보다 앞서 그려진다
  const sending = useRef(false);
  const pendingNow = useRef(pending);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const was = pendingNow.current;
    pendingNow.current = pending;
    if (pending) return;
    sending.current = false;
    // 진행이 끝났는데 대화상자가 열린 채면(실패) — 기다리는 동안 잠긴 이 버튼에서 브라우저가 초점을 body 로 버렸다. 다시 누를 수 있는
    // 이 버튼으로 되돌린다. 다른 곳에 초점이 있으면(사람이 옮겼다) 건드리지 않는다
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (was && open && lost) button.current?.focus();
  }, [pending, open]);
  return (
    <Button
      ref={button}
      variant={destructive ? "destructive" : "default"}
      disabled={pending || !armed}
      onClick={() => {
        if (sending.current) return;
        sending.current = true;
        onConfirm();
        setTimeout(() => {
          if (!pendingNow.current) sending.current = false;
        }, 0);
      }}
    >
      {label}
    </Button>
  );
}

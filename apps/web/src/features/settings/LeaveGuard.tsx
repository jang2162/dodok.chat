import { useBlocker } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { useDrafts } from "./draft";

/**
 * 저장 막대에 바뀐 것이 남은 채 떠나려 하면(다른 탭·다른 채널·패널 닫기·뒤로 가기) 묻는다(패널 재설계 스펙 목표 6).
 * 초안은 설정 탭 안에만 있어 떠나면 사라진다 — 탭 사이에 남기려면 상태를 라우트 밖으로 올려야 해서, 남기지 않고 떠나기 전에 묻는다.
 * 「저장」은 모두 저장됐을 때만 떠나고, 하나라도 실패하면 머문다(오류는 그 섹션 안). 같은 주소로의 이동(지금 탭을 다시 누름)은 묻지 않는다.
 * 새로고침·창 닫기는 브라우저가 묻는다(`beforeunload` — `useLeaveGuard` 와 같은 수법)
 */
export function LeaveGuard() {
  const { total, saving, saveAll, resetAll } = useDrafts();
  const active = total > 0;
  const leave = useBlocker({
    shouldBlockFn: ({ current, next }) => current.pathname !== next.pathname,
    disabled: !active,
    // 라우터의 beforeunload 는 브라우저 히스토리에만 붙는다 — 히스토리 종류와 무관하게 아래 효과가 직접 건다
    enableBeforeUnload: false,
    withResolver: true,
  });
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  // 막아 둔 채 이 화면이 사라지면(보관·역할 변경 등) 이어서 보낸다 — useBlocker 는 언마운트 때 대기를 풀지 않아 이동이 매달린다
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useEffect(
    () => () => {
      const last = leaveRef.current;
      if (last.status === "blocked") last.proceed();
    },
    [],
  );

  if (leave.status !== "blocked") return null;
  const busy = saving || deciding;

  async function saveAndLeave() {
    if (leave.status !== "blocked" || busy) return;
    setDeciding(true);
    const ok = await saveAll();
    setDeciding(false);
    if (ok) leave.proceed();
    else leave.reset();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) leave.reset();
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>저장하지 않은 변경 {total}개</DialogTitle>
          <DialogDescription>떠나면 고친 내용이 사라집니다.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => leave.reset()}>
            취소
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              resetAll();
              leave.proceed();
            }}
          >
            버리기
          </Button>
          <Button
            aria-disabled={busy || undefined}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={() => void saveAndLeave()}
          >
            {busy ? "저장 중…" : "저장"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

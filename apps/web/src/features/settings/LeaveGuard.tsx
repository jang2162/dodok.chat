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
 *
 * 대화상자는 트리거 없이 열려, 머물 때(「취소」·「저장」 실패) 닫히면 Radix 가 돌려줄 자리가 없어 초점이 `<body>` 로 떨어졌다.
 * 머물면 떠나려고 누른 자리(탭 링크·「설정 닫기」·채널 링크)로, 그 자리가 사라졌으면 막대의 「저장」으로 돌려준다.
 * 누른 자리는 `activeElement` 가 아니라 누르는 순간에 잰다 — 「설정 닫기」는 차단 전에 초점을 헤더로 옮긴다
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
  /** 마지막으로 누른(마우스·Enter·Space) 자리와 그 시각 — 차단이 그 누름에서 왔는지 시각으로 가른다 */
  const pressed = useRef<{ el: HTMLElement; at: number } | null>(null);
  /** 차단이 걸린 순간 떠나려던 자리 — 머물 때 초점을 돌려준다 */
  const origin = useRef<HTMLElement | null>(null);
  /** 「버리기」·「저장」 성공으로 떠나는 중 — 그때는 이동 뒤 초점 규칙(패널 닫기의 헤더 등)을 건드리지 않는다 */
  const leaving = useRef(false);

  useEffect(() => {
    if (!active) return;
    const press = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Enter" && e.key !== " ") return;
      const el =
        e.target instanceof Element
          ? e.target.closest<HTMLElement>("a[href],button,[tabindex]:not([tabindex='-1'])")
          : null;
      pressed.current = el ? { el, at: performance.now() } : null;
    };
    // 캡처 단계 — 누른 자리의 onClick(「설정 닫기」의 초점 옮기기)보다 먼저 잰다
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("keydown", press, true);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("keydown", press, true);
    };
  }, [active]);

  const blocked = leave.status === "blocked";
  useEffect(() => {
    if (!blocked) return;
    leaving.current = false;
    const p = pressed.current;
    // 누름 뒤 곧바로 걸린 차단만 그 누름에서 온 것으로 본다(뒤로 가기·코드 이동은 지금 초점 자리)
    origin.current =
      p && performance.now() - p.at < 1000
        ? p.el
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
  }, [blocked]);

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
    if (ok) {
      leaving.current = true;
      leave.proceed();
    } else leave.reset();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) leave.reset();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-sm"
        onCloseAutoFocus={(e) => {
          if (leaving.current) return;
          const back = origin.current;
          const target =
            back?.isConnected && back !== document.body
              ? back
              : document.querySelector<HTMLElement>("[data-save-bar-save]");
          if (!target) return;
          e.preventDefault();
          target.focus();
        }}
      >
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
              leaving.current = true;
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

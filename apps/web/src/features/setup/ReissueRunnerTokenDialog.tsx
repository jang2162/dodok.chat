import type { ReissueRunnerTokenResult, RunnerTokenRecord } from "@dodok/shared";
import { useEffect, useRef, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { useLeaveGuard } from "@/hooks/useLeaveGuard";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { RunnerTokenFile } from "./IssueRunnerTokenDialog";
import { IssuedToken } from "./IssueTokenDialog";
import { llmsHandoffLine } from "./llms";
import { useReissueRunnerToken } from "./mutations";

/**
 * 「다시 발급」(러너 일반화 계획 판정 PR7, owner) — 확인 → 새 원문을 한 번. 같은 러너(행)라 프로젝트·에이전트는 그대로 남고, 옛 원문의
 * 러너는 곧바로 끊긴다(그 러너의 열린 런은 「다시 실행」 카드). 원문이 보이는 동안의 규칙은 발급 대화상자와 같다(`IssuedToken`).
 * 확인 버튼은 요청이 나가 있는 동안 막는다 — 두 번 나가면 먼저 받은 원문은 이미 죽어 있다(`useReissueRunnerToken`)
 */
export function ReissueRunnerTokenDialog({
  token,
  connected,
}: {
  token: RunnerTokenRecord;
  /** 지금 이 토큰으로 러너가 붙어 있나 — 끊긴다고 알린다 */
  connected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [issued, setIssued] = useState<ReissueRunnerTokenResult>();
  const { reissue, isPending, error, reset } = useReissueRunnerToken(setIssued);
  // 409 는 전역 토스트에서 빠진다(폼 오류) — 폐기한 토큰이다(다른 탭이 먼저 폐기). 그 밖은 전역 토스트가 알린다
  const revokedMeanwhile = error instanceof ApiRequestError && error.code === "CONFLICT";
  const trigger = useRef<HTMLButtonElement>(null);
  const stayRef = useRef<HTMLButtonElement>(null);
  const leave = useLeaveGuard(issued !== undefined);

  useEffect(() => {
    if (leave.status === "blocked") stayRef.current?.focus();
  }, [leave.status]);

  function onOpenChange(next: boolean) {
    // 요청 중·원문이 보이는 동안은 닫지 않는다 — 원문은 「복사했습니다」로만 버린다
    if (!next && (isPending || issued)) return;
    setOpen(next);
    if (!next) {
      setIssued(undefined);
      reset();
    }
  }

  function done() {
    const proceed = leave.status === "blocked" ? leave.proceed : undefined;
    setOpen(false);
    setIssued(undefined);
    reset();
    proceed?.();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Button
        ref={trigger}
        type="button"
        size="sm"
        variant="outline"
        aria-label={`${token.label} 다시 발급`}
        onClick={() => setOpen(true)}
      >
        다시 발급
      </Button>
      <DialogContent
        showCloseButton={!issued}
        closeDisabled={isPending}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          trigger.current?.focus();
        }}
      >
        {issued ? (
          <IssuedToken
            issued={issued}
            title={`「${issued.record.label}」 토큰을 다시 발급했습니다`}
            handoff={(r) => llmsHandoffLine("runner-reissue", r.runnerConfig.serverUrl, r.token)}
            config={(r) => <RunnerTokenFile tokenFile={r.runnerConfig.tokenFile} />}
            leave={leave}
            stayRef={stayRef}
            onDone={done}
          />
        ) : (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>「{token.label}」 러너 토큰을 다시 발급할까요?</DialogTitle>
              <DialogDescription>
                {connected
                  ? "지금 이 토큰으로 러너가 붙어 있습니다. 다시 발급하면 옛 토큰은 곧바로 안 통하고 그 러너가 끊깁니다. "
                  : "다시 발급하면 옛 토큰은 곧바로 안 통합니다. "}
                프로젝트·에이전트는 그대로 남습니다. 러너 서비스를 먼저 멈추고 새 토큰을 넣은 뒤 다시
                띄우세요.
              </DialogDescription>
            </DialogHeader>
            {revokedMeanwhile && (
              <p role="alert" className="text-sm text-destructive">
                폐기한 토큰은 다시 발급할 수 없습니다 — 새 러너 토큰을 발급하세요.
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={isPending}
                onClick={() => onOpenChange(false)}
              >
                취소
              </Button>
              <Button type="button" disabled={isPending} onClick={() => reissue(token.id)}>
                {isPending ? "발급하는 중…" : "다시 발급"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

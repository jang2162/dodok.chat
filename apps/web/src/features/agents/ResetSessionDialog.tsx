import { useEffect } from "react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { resetErrorMessage, useResetSession } from "./resetSession";

/**
 * 「새 대화」 확인 대화상자(스펙 6.4·5.1 `/new`). 작성기와 채널 설정 패널(태스크 11)이 같이 쓴다 — 여는 버튼은 부르는 쪽 몫.
 * 성공하면 토스트 없이 닫는다(서버가 info 시스템 메시지를 채널에 보낸다). 실패는 대화상자 안에 알린다.
 * 시작하는 중에는 닫히지 않는다 — 결과를 잃지 않게
 */
export function ResetSessionDialog({
  channelId,
  agentId,
  handle,
  open,
  onOpenChange,
}: {
  channelId: string;
  agentId: string;
  handle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const reset = useResetSession(channelId);
  const { reset: clear } = reset;

  // 다시 열 때 지난 결과(오류 문구)를 지운다
  useEffect(() => {
    if (open) clear();
  }, [open, clear]);

  function change(next: boolean) {
    if (!next && reset.isPending) return;
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>새 대화</DialogTitle>
          <DialogDescription>
            @{handle} 와의 대화 기록을 새로 시작합니다. 진행 중인 실행은 중지됩니다
          </DialogDescription>
        </DialogHeader>
        {reset.isError && (
          <p role="alert" className="text-sm text-destructive">
            {resetErrorMessage(reset.error)}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={reset.isPending} onClick={() => change(false)}>
            취소
          </Button>
          <Button
            disabled={reset.isPending}
            onClick={() => reset.mutate(agentId, { onSuccess: () => onOpenChange(false) })}
          >
            {reset.isPending ? "시작하는 중…" : "새 대화 시작"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

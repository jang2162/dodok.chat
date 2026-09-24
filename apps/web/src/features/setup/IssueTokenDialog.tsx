import type { IssueBridgeTokenResult } from "@dodok/shared";
import { KeyRoundIcon } from "lucide-react";
import { useBlocker } from "@tanstack/react-router";
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { formError as serverFormError } from "@/api/formErrors";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { useIssueBridgeToken } from "./mutations";
import { CopyBlock } from "./sections";

/**
 * 「새 토큰 발급」(스펙 「연결 페이지」 교체 흐름 1) — 라벨 → 발급 → 원문과 플러그인 설정 조각을 한 번 보인다.
 * 원문이 보이는 동안은 「복사했습니다」로만 닫힌다(Esc·바깥 클릭·X 없음) — 복사하지 못한 채 닫히면 다시 볼 길이 없다.
 * 원문은 이 컴포넌트 상태에만 있고 닫으면 버린다 — 쿼리·뮤테이션 캐시에는 들어가지 않는다(`useIssueBridgeToken`).
 * 같은 까닭으로 원문이 보이는 동안 페이지를 떠나는 것도 막는다: 라우트 이동(뒤로 가기·주소 변경)은 대화상자 안에서 한 번 더 묻고,
 * 탭 닫기·새로고침은 브라우저가 묻게 한다(`beforeunload`). 「복사했습니다」를 누르면 둘 다 풀린다
 */
export function IssueTokenDialog({ triggerRef }: { triggerRef?: RefObject<HTMLButtonElement | null> }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string>();
  const [issued, setIssued] = useState<IssueBridgeTokenResult>();
  const issue = useIssueBridgeToken(setIssued);
  const labelId = useId();
  const errorId = useId();
  const trimmed = label.trim();
  const stayRef = useRef<HTMLButtonElement>(null);
  const leave = useBlocker({
    shouldBlockFn: () => true,
    disabled: !issued,
    // 라우터의 beforeunload 는 브라우저 히스토리에만 붙는다 — 히스토리 종류와 무관하게 아래 효과가 직접 건다
    enableBeforeUnload: false,
    withResolver: true,
  });

  useEffect(() => {
    if (!issued) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 옛 브라우저는 returnValue 가 있어야 묻는다
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [issued]);

  useEffect(() => {
    if (leave.status === "blocked") stayRef.current?.focus();
  }, [leave.status]);

  function reset() {
    setLabel("");
    setError(undefined);
    setIssued(undefined);
    issue.reset();
  }

  function onOpenChange(next: boolean) {
    // 발급 중·원문이 보이는 동안은 닫지 않는다 — 원문은 「복사했습니다」로만 버린다
    if (!next && (issue.isPending || issued)) return;
    setOpen(next);
    if (!next) reset();
  }

  /** 원문을 버리고 닫는다. 막아 둔 라우트 이동이 있으면 이어서 보낸다 — 떠나려던 사람이 복사를 마친 것이다 */
  function done() {
    const proceed = leave.status === "blocked" ? leave.proceed : undefined;
    setOpen(false);
    reset();
    proceed?.();
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!trimmed || issue.isPending) return;
    setError(undefined);
    issue.mutate(trimmed, { onError: (err) => setError(serverFormError(err)) });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button ref={triggerRef} type="button" size="sm">
          <KeyRoundIcon />새 토큰 발급
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!issued} closeDisabled={issue.isPending}>
        {issued ? (
          <div className="grid min-w-0 gap-4">
            <DialogHeader>
              <DialogTitle>「{issued.record.label}」 토큰을 발급했습니다</DialogTitle>
              <DialogDescription>
                원문은 지금 한 번만 보입니다. 닫으면 다시 볼 수 없으니 복사해 두세요.
              </DialogDescription>
            </DialogHeader>
            <div className="grid min-w-0 gap-1.5">
              <p className="text-sm font-medium">토큰</p>
              <CopyBlock text={issued.token} label="토큰 복사" />
            </div>
            <div className="grid min-w-0 gap-1.5">
              <p className="text-sm font-medium">플러그인 설정</p>
              <p className="text-xs text-muted-foreground">
                Gateway 호스트에서 이 조각을 파일로 저장해{" "}
                <code className="font-mono">openclaw config patch --file</code> 로 적용하고 저장한 파일은
                지우세요. 옛 토큰도 계속 통하므로 에이전트는 멈추지 않습니다.
              </p>
              <CopyBlock
                text={JSON.stringify(issued.pluginConfig, null, 2)}
                label="설정 복사"
                testId="plugin-config"
              />
            </div>
            {leave.status === "blocked" && (
              <div
                role="alert"
                className="flex flex-col gap-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm"
              >
                <p className="font-medium">이 페이지를 떠나면 토큰 원문을 다시 볼 수 없습니다.</p>
                <div className="flex flex-wrap gap-2">
                  <Button ref={stayRef} type="button" size="sm" variant="outline" onClick={leave.reset}>
                    머무르기
                  </Button>
                  <Button type="button" size="sm" variant="destructive" onClick={done}>
                    원문을 버리고 떠나기
                  </Button>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button type="button" onClick={done}>
                복사했습니다
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>새 브리지 토큰</DialogTitle>
              <DialogDescription>
                알아볼 라벨을 붙입니다(예: Gateway 호스트 이름). 원문은 발급 직후 한 번만 보입니다.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor={labelId}>라벨</Label>
              <Input
                id={labelId}
                value={label}
                maxLength={60}
                autoComplete="off"
                aria-invalid={error !== undefined || undefined}
                aria-describedby={error !== undefined ? errorId : undefined}
                onChange={(e) => {
                  setLabel(e.target.value);
                  setError(undefined);
                }}
              />
            </div>
            {error !== undefined && (
              <p id={errorId} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={!trimmed || issue.isPending}>
                {issue.isPending ? "발급하는 중…" : "발급"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

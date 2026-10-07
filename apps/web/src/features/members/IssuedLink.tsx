import { useEffect, useRef } from "react";
import { CopyBlock } from "@/features/setup/sections";
import { useLeaveGuard } from "@/hooks/useLeaveGuard";
import { Button } from "@/ui/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";

/**
 * 발급한 링크(초대·재설정)를 한 번 보이는 대화상자 본문 — 설정 마법사의 브리지 토큰 대화상자(`IssueTokenDialog`)와 같은 꼴.
 * 링크는 부르는 쪽 컴포넌트 상태에만 있고 「복사했습니다」(`onDone`)로 버린다. 390px 에서도 잘리지 않게 아무 글자 사이에서나
 * 줄을 바꾼다(`CopyBlock wrap`). 보이는 동안 페이지를 떠나면 한 번 더 묻는다(`useLeaveGuard`) — 이 본문이 사라지면 막아 둔
 * 이동을 이어서 보낸다. 자동화의 웹훅 주소도 같은 본문을 쓴다(`noun` 「주소」 — 자동화 `WebhookUrlOnce`)
 */
export function IssuedLink({
  title,
  url,
  hint,
  onDone,
  noun = "링크",
}: {
  title: string;
  url: string;
  hint: string;
  onDone: () => void;
  /** 원문을 부르는 말 — 「링크」·「주소」 둘 다 받침이 없어 뒤 조사(는·를)가 같다 */
  noun?: "링크" | "주소";
}) {
  const leave = useLeaveGuard(true);
  const stayRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (leave.status === "blocked") stayRef.current?.focus();
  }, [leave.status]);

  return (
    <div className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          이 {noun}는 다시 볼 수 없습니다. 닫기 전에 복사해 두세요. {hint}
        </DialogDescription>
      </DialogHeader>
      <CopyBlock text={url} label={`${noun} 복사`} wrap />
      {leave.status === "blocked" && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm"
        >
          <p className="font-medium">이 페이지를 떠나면 {noun}를 다시 볼 수 없습니다.</p>
          <p>복사를 마쳤다면 「복사했습니다」를 누르세요. 닫고 이어서 이동합니다.</p>
          <div className="flex flex-wrap gap-2">
            <Button ref={stayRef} type="button" size="sm" variant="outline" onClick={leave.reset}>
              머무르기
            </Button>
            <Button type="button" size="sm" variant="destructive" onClick={onDone}>
              {noun}를 버리고 떠나기
            </Button>
          </div>
        </div>
      )}
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          복사했습니다
        </Button>
      </DialogFooter>
    </div>
  );
}

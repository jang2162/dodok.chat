import { BellIcon } from "lucide-react";
import { useState } from "react";
import {
  type NotifyPermission,
  notifyPermission,
  requestNotifyPermission,
} from "@/features/approvals/notify";
import { Button } from "@/ui/button";

/**
 * 사이드바 하단 「알림 켜기」(설계 5.4). **아직 묻지 않은 상태(`default`)일 때만** 보인다 —
 * `granted` 면 할 일이 없어 사라지고, `denied`·미지원이면 다시 묻지 않는다(브라우저가 두 번째 물음을 무시한다).
 * 권한은 사용자가 누를 때만 요청한다 — 스스로 묻는 앱은 브라우저가 벌준다
 */
export function NotifyToggle() {
  const [permission, setPermission] = useState<NotifyPermission>(notifyPermission);
  const [asking, setAsking] = useState(false);
  if (permission !== "default") return null;

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={asking}
      onClick={() => {
        setAsking(true);
        void requestNotifyPermission().then((next) => {
          setPermission(next);
          setAsking(false);
        });
      }}
      className="w-full justify-start px-2 font-normal text-muted-foreground"
    >
      <BellIcon className="size-4 shrink-0 opacity-70" aria-hidden />
      알림 켜기
    </Button>
  );
}

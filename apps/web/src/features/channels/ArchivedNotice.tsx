import { useCanManage } from "@/api/queries";
import { Button } from "@/ui/button";
import { useUnarchiveChannel } from "./mutations";

/**
 * 보관한 채널의 작성기 자리(채널 보관 스펙 「웹」 절) — 「보관된 채널입니다.」, `unarchive` 면 admin 이상에게 「보관 해제」.
 * 해제하면 채널 캐시가 살아 있는 채널로 바뀌어 부르는 쪽이 작성기를 다시 그린다. 스레드 패널은 단추 없이 문구만 둔다 —
 * 같은 화면에 「보관 해제」가 둘이 되지 않게
 */
export function ArchivedNotice({ channelId, unarchive = false }: { channelId: string; unarchive?: boolean }) {
  const canManage = useCanManage();
  const action = useUnarchiveChannel(channelId);
  return (
    <div className="flex flex-wrap items-center justify-center gap-3 border-t bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
      <p>보관된 채널입니다.</p>
      {unarchive && canManage && (
        <Button variant="outline" size="sm" disabled={action.isPending} onClick={() => void action.run()}>
          보관 해제
        </Button>
      )}
    </div>
  );
}

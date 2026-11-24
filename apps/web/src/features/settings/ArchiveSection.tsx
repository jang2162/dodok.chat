import type { Channel } from "@dodok/shared";
import { ChevronDownIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useCanManage } from "@/api/queries";
import { useArchiveChannel } from "@/features/channels/mutations";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * 설정 패널 맨 아래 「채널 보관」(채널 보관 스펙 「웹」 절, admin 이상 — member 에게는 섹션이 없다). 드문·되돌리기 번거로운 동작이라
 * 접힌 줄로 둔다(패널 재설계 스펙 목표 6) — 펼치면 안내와 「이 채널 보관」. 확인 뒤 보관하면 채널 캐시가 보관된 채널로 바뀌어
 * 패널·작성기 자리가 읽기 전용 안내로 바뀐다(이 섹션도 함께 사라진다)
 */
export function ArchiveSection({ channel }: { channel: Channel }) {
  const canManage = useCanManage();
  const archive = useArchiveChannel(channel.id);
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const id = useId();
  if (!canManage) return null;
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3 px-4 py-3">
      <h3 id={`${id}-title`}>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`${id}-body`}
          className="flex w-full items-center justify-between gap-2 rounded-sm py-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={() => setExpanded((v) => !v)}
        >
          채널 보관
          <ChevronDownIcon
            aria-hidden="true"
            className={cn("size-4 transition-transform", expanded && "rotate-180")}
          />
        </button>
      </h3>
      {expanded && (
        <div id={`${id}-body`} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            보관하면 채널이 읽기 전용이 되고 사이드바에서 빠집니다. 「보관 해제」로 되돌릴 수 있습니다.
          </p>
          <Button
            ref={opener}
            variant="outline"
            size="sm"
            className="self-start border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setOpen(true)}
          >
            이 채널 보관
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="채널 보관"
        description={`#${channel.name} 을 보관합니다.`}
        confirmLabel="보관"
        pendingLabel="보관하는 중…"
        pending={archive.isPending}
        destructive
        returnFocus={opener}
        onConfirm={() => {
          void archive.run().then((done) => done && setOpen(false));
        }}
      />
    </section>
  );
}

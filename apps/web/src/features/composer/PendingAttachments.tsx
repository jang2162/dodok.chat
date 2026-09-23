import { XIcon } from "lucide-react";
import type { ComposerAttachment } from "@/features/attachments/useComposerAttachments";
import { Button } from "@/ui/button";

/**
 * 작성기 위 첨부 칩(스펙 6.1) — 로컬 미리보기·이름, 올리는 중이면 진행 막대, 오류면 빨간 이유, 빼기 버튼.
 * 비었으면 아무것도 그리지 않는다
 */
export function PendingAttachments({
  items,
  onRemove,
}: {
  items: readonly ComposerAttachment[];
  onRemove: (key: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul role="list" aria-label="첨부할 이미지" className="flex flex-wrap gap-2 pt-1 pb-1.5">
      {items.map((item) => (
        <li
          key={item.key}
          data-status={item.status}
          className="flex w-52 max-w-full items-center gap-2 rounded-md border border-input bg-background p-1.5"
        >
          <img src={item.previewUrl} alt="" className="size-10 shrink-0 rounded object-cover" />
          <div className="min-w-0 flex-1 text-xs">
            <p className="truncate" title={item.name}>
              {item.name}
            </p>
            {item.status === "uploading" && (
              <div
                role="progressbar"
                aria-valuenow={Math.round(item.progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${item.name} 올리는 중`}
                className="mt-1 h-1 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${item.progress * 100}%` }}
                />
              </div>
            )}
            {item.status === "error" && <p className="mt-0.5 text-destructive">{item.error}</p>}
          </div>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`${item.name} 빼기`}
            onClick={() => onRemove(item.key)}
          >
            <XIcon />
          </Button>
        </li>
      ))}
    </ul>
  );
}

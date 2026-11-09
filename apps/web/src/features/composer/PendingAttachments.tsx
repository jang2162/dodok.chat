import { displayAttachmentName } from "@dodok/shared";
import { FileIcon, XIcon } from "lucide-react";
import { useState, useRef } from "react";
import { formatSize } from "@/features/attachments/format";
import type { ComposerAttachment } from "@/features/attachments/useComposerAttachments";
import { Button } from "@/ui/button";

/** 칩을 뺀 뒤 초점을 둘 칩 — 다음 칩, 없으면 이전 칩, 남는 칩이 없으면 null */
export function focusAfterRemove(keys: readonly string[], removed: string): string | null {
  const i = keys.indexOf(removed);
  if (i < 0) return null;
  return keys[i + 1] ?? keys[i - 1] ?? null;
}

/**
 * 작성기 위 첨부 칩(스펙 6.1·파일함 스펙 6장) — 사진은 로컬 미리보기·이름, 그 밖은 파일 아이콘·이름·크기. 올리는 중이면 진행 막대,
 * 오류면 빨간 이유, 빼기 버튼. 형식만 사진인 파일(.png 이름의 HTML)은 미리보기가 깨지거나 서버가 file 로 판별하면 파일 칩으로 그린다.
 * 빼기 버튼으로 뺄 때만 초점을 옆 칩의 빼기 버튼으로, 칩이 다 빠지면 onEmptied 로 넘긴다 — 누른 버튼이 사라져도 body 로 떨어지지 않게.
 * 비었으면 아무것도 그리지 않는다
 */
export function PendingAttachments({
  items,
  onRemove,
  onEmptied,
}: {
  items: readonly ComposerAttachment[];
  onRemove: (key: string) => void;
  onEmptied: () => void;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // 미리보기가 깨진 칩 — 칩 키는 다시 쓰이지 않아 빠진 칩의 키가 남아도 해가 없다
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  if (items.length === 0) return null;
  const removeAndMoveFocus = (key: string) => {
    const next = focusAfterRemove(
      items.map((i) => i.key),
      key,
    );
    onRemove(key);
    if (next === null) onEmptied();
    else buttons.current.get(next)?.focus();
  };
  return (
    <ul role="list" aria-label="첨부할 파일" className="flex flex-wrap gap-2 pt-1 pb-1.5">
      {items.map((item) => {
        const name = displayAttachmentName(item.name);
        return (
          <li
            key={item.key}
            data-status={item.status}
            className="flex w-52 max-w-full items-center gap-2 rounded-md border border-input bg-background p-1.5"
          >
            <ChipThumb
              item={item}
              onBroken={() => setBroken((b) => new Set(b).add(item.key))}
              broken={broken.has(item.key)}
            />
            <div className="min-w-0 flex-1 text-xs">
              <p className="truncate" title={name}>
                {name}
              </p>
              {!showsPreview(item, broken.has(item.key)) && item.status !== "error" && (
                <p className="text-muted-foreground">{formatSize(item.size)}</p>
              )}
              {item.status === "uploading" && (
                <div
                  role="progressbar"
                  aria-valuenow={Math.round(item.progress * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${name} 올리는 중`}
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
              aria-label={`${name} 빼기`}
              ref={(el) => {
                if (el) buttons.current.set(item.key, el);
                else buttons.current.delete(item.key);
              }}
              onClick={() => removeAndMoveFocus(item.key)}
            >
              <XIcon />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** 미리보기를 그리는가 — 로컬 미리보기가 있고, 깨지지 않았고, 서버가 사진이 아니라고 하지 않았을 때 */
function showsPreview(item: ComposerAttachment, broken: boolean): boolean {
  return item.previewUrl !== undefined && !broken && (item.attachment?.kind ?? "image") === "image";
}

function ChipThumb({
  item,
  broken,
  onBroken,
}: {
  item: ComposerAttachment;
  broken: boolean;
  onBroken: () => void;
}) {
  if (showsPreview(item, broken))
    return (
      <img
        src={item.previewUrl}
        alt=""
        onError={onBroken}
        className="size-10 shrink-0 rounded object-cover"
      />
    );
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
      <FileIcon data-icon="file" aria-hidden className="size-5" />
    </span>
  );
}

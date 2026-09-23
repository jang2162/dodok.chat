import type { Attachment, Block } from "@dodok/shared";
import { FileIcon } from "lucide-react";
import { FileCard } from "@/features/attachments/FileCard";
import { formatSize } from "@/features/attachments/format";
import { resolveRef } from "@/features/attachments/resolve";
import { attachmentHref } from "@/features/attachments/url";
import { Button } from "@/ui/button";
import { ATTACHMENT_MISSING, LINK_BLOCKED, Unresolved } from "./artifact";

type Props = { block: Extract<Block, { type: "file" }>; attachments: readonly Attachment[] };

/**
 * file 블록 — `resolveRef`(첨부 스펙 6.3)로 갈린다. 그 메시지의 첨부로 풀리면 파일 카드(표시 이름은 블록의 `name`, 크기·종류는 첨부),
 * `https://` 면 이름·크기(있을 때만) + 새 탭 「열기」(`noopener noreferrer`), 못 찾으면 「첨부를 찾을 수 없습니다」,
 * 그 밖의 값은 「열 수 없는 링크입니다」
 */
export function FileBlock({ block, attachments }: Props) {
  const r = resolveRef(block.url, attachments);
  if (r.kind === "attachment")
    return (
      <FileCard
        slot="file"
        name={block.name}
        size={r.attachment.size}
        mime={r.attachment.mime}
        href={attachmentHref(r.attachment)}
      />
    );
  const size = block.size === undefined ? undefined : formatSize(block.size);
  return (
    <div data-slot="file" className="flex items-center gap-2 rounded-md border px-3 py-2">
      <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm" title={block.name}>
        {block.name}
      </span>
      {size && (
        <span data-slot="file-size" className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {size}
        </span>
      )}
      {r.kind === "https" ? (
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <a href={r.url} target="_blank" rel="noopener noreferrer" aria-label={`${block.name} 열기`}>
            열기
          </a>
        </Button>
      ) : (
        <Unresolved
          text={r.kind === "missing" ? ATTACHMENT_MISSING : LINK_BLOCKED}
          className="shrink-0 text-xs"
        />
      )}
    </div>
  );
}

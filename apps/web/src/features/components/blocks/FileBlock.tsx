import type { Block } from "@dodok/shared";
import { FileIcon } from "lucide-react";
import { Button } from "@/ui/button";
import { ArtifactPending } from "./MediaBlock";

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const NUM = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });

/** 바이트 → 사람이 읽는 단위(1024 배수, 소수 한 자리까지). 음수는 뜻이 없어 적지 않는다 */
function formatSize(bytes: number): string | undefined {
  if (bytes < 0) return undefined;
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${NUM.format(n)} ${UNITS[unit]}`;
}

/**
 * file 블록 — 이름·크기(있을 때만) + 「열기」. `https://` 면 새 탭 링크(`noopener noreferrer`),
 * `artifact://` 면 링크를 만들지 않고 자리표시(스펙 결정 1 — 해석은 Phase 2 ③)
 */
export function FileBlock({ block }: { block: Extract<Block, { type: "file" }> }) {
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
      {block.url.startsWith("https://") ? (
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <a href={block.url} target="_blank" rel="noopener noreferrer" aria-label={`${block.name} 열기`}>
            열기
          </a>
        </Button>
      ) : (
        <ArtifactPending className="shrink-0 text-xs" />
      )}
    </div>
  );
}

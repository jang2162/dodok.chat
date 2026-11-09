import { FileIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { LINK_BLOCKED } from "@/features/components/blocks/artifact";
import { Button } from "@/ui/button";
import { formatSize } from "./format";

/** MIME → 사람이 읽는 종류. 모르는 MIME 이면 이름의 확장자(대문자), 그것도 없으면 적지 않는다 */
function kindLabel(mime: string | undefined, name: string): string | undefined {
  if (mime === "application/pdf") return "PDF";
  if (mime?.startsWith("image/")) return "이미지";
  if (mime?.startsWith("text/")) return "텍스트";
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : undefined;
}

type Props = {
  name: string;
  size?: number;
  mime?: string;
  /**
   * 내려받기 주소 — `<a download>` 가 아니라 서버의 `Content-Disposition` 에 맡긴다(스펙 6.2). 없으면 버튼 대신 `note` 만,
   * `note` 도 없으면 「열 수 없는 링크입니다」(자기 서버 경로로 못 푸는 첨부 — 말없이 버튼만 빠지지 않게)
   */
  href?: string;
  /** 이름 아래 한 줄(「이미지를 불러오지 못했습니다」 등) */
  note?: string;
  /** 바깥에서 부를 이름 — components 의 file 블록은 `file` 로 부른다 */
  slot?: string;
  className?: string;
};

/** 파일 카드 — 아이콘·이름·크기·종류와 「내려받기」. 메시지 첨부·이미지 물러남·components 가 같이 쓴다 */
export function FileCard({ name, size, mime, href, note, slot = "file-card", className }: Props) {
  const sizeText = size === undefined ? undefined : formatSize(size);
  const kind = kindLabel(mime, name);
  const line = note ?? (href ? undefined : LINK_BLOCKED);
  return (
    <div data-slot={slot} className={cn("flex items-center gap-2 rounded-md border px-3 py-2", className)}>
      <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 이름은 남이 지은 글자다 — 방향 제어 문자(U+202E 등)가 둘레의 크기·종류 글자 순서를 뒤집지 못하게 격리한다 */}
        <span className="truncate text-sm" title={name}>
          <bdi>{name}</bdi>
        </span>
        {(sizeText || kind) && (
          <span className="flex gap-1.5 text-xs text-muted-foreground">
            {sizeText && (
              <span data-slot="file-size" className="tabular-nums">
                {sizeText}
              </span>
            )}
            {kind && <span data-slot="file-kind">{kind}</span>}
          </span>
        )}
        {line && <span className="text-xs text-muted-foreground">{line}</span>}
      </div>
      {href && (
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <a href={href} aria-label={`${name} 내려받기`}>
            내려받기
          </a>
        </Button>
      )}
    </div>
  );
}

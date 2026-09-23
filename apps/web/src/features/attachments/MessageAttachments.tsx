import type { Attachment } from "@dodok/shared";
import { AttachmentGrid } from "./AttachmentGrid";
import { FileCard } from "./FileCard";
import { useImageViewer } from "./ImageViewer";
import { attachmentHref } from "./url";

type Props = {
  attachments: readonly Attachment[];
  /** 그리지 않을 첨부 id — 카드(components)가 가리킨 것(스펙 6.3) */
  exclude?: ReadonlySet<string>;
};

/**
 * 메시지 본문 아래 첨부(스펙 6.2) — 이미지 격자(누르면 크게 보기) + 파일 카드 목록.
 * 자기 서버 경로로 풀리지 않는 이미지(계약상 `https://` 첨부)는 불러오지 않고 파일 카드로 둔다
 */
export function MessageAttachments({ attachments, exclude }: Props) {
  const shown = attachments.filter((a) => !exclude?.has(a.id));
  const images = shown.filter((a) => a.kind === "image" && attachmentHref(a));
  const files = shown.filter((a) => !images.includes(a));
  const { open, viewer } = useImageViewer(
    images.map((a) => ({
      src: attachmentHref(a) ?? "",
      name: a.name,
      downloadHref: attachmentHref(a, { download: true }),
    })),
  );
  if (shown.length === 0) return null;
  return (
    <div data-slot="attachments" className="mt-1 flex flex-col gap-2">
      {images.length > 0 && <AttachmentGrid images={images} onOpen={open} />}
      {files.map((a) => (
        <FileCard
          key={a.id}
          name={a.name}
          size={a.size}
          mime={a.mime}
          href={attachmentHref(a)}
          className="max-w-[360px]"
        />
      ))}
      {viewer}
    </div>
  );
}

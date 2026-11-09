import { type Attachment, displayAttachmentName } from "@dodok/shared";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { FileCard } from "./FileCard";
import { attachmentHref } from "./url";

/** 한 장일 때의 상자 상한(스펙 6.2) — 클래스 `max-w-[360px]`·`max-h-80` 과 같은 값 */
const MAX_W = 360;
const MAX_H = 320;

export const IMAGE_FAILED = "이미지를 불러오지 못했습니다";

/**
 * 한 장짜리 상자의 크기 — 저장된 가로·세로로 미리 잡는다(가상 목록에서 줄 높이가 튀지 않게).
 * 너비를 px 로 정하고 높이는 `aspect-ratio` 가 낸다. 비율만 주면 격자 칸 안에서 너비가 내용 크기로 풀려 상자가 무너진다.
 * 360×320 안에 비율대로 줄이고 키우지는 않는다 — 300×6000 은 16×320, 6000×300 은 360×18.
 * 칸이 360 보다 좁은 화면(390px 폰의 메시지 칸은 300px 남짓)에서는 `maxWidth` 가 너비를 줄이고 높이는 비율이 따라온다 —
 * 클래스 `max-w-full` 은 `max-w-[360px]` 와 겹쳐 tailwind-merge 가 지우므로 인라인으로 둔다
 */
function singleBox(a: Attachment) {
  if (!a.width || !a.height) return undefined;
  const scale = Math.min(1, MAX_W / a.width, MAX_H / a.height);
  return {
    width: `${Math.round(a.width * scale * 100) / 100}px`,
    maxWidth: "100%",
    aspectRatio: `${a.width} / ${a.height}`,
  };
}

type ImageProps = {
  attachment: Attachment;
  single: boolean;
  label?: string;
  /** 없으면 누를 것 없이 그림만(보내는 중 항목) */
  onOpen?: (el: HTMLElement) => void;
};

/**
 * 자기 서버 이미지 한 칸 — 누르면 크게 보기. 못 불러오면(권한·없음·깨짐) 파일 카드 꼴로 물러난다(스펙 6.2·7장).
 * `label` 은 표시 이름(기본은 첨부 이름) — media 블록의 alt 가 여기로 온다
 */
export function AttachmentImage({ attachment: a, single, label: rawLabel = a.name, onOpen }: ImageProps) {
  const label = displayAttachmentName(rawLabel);
  const [failed, setFailed] = useState(false);
  const src = attachmentHref(a);
  if (failed || !src)
    return <FileCard name={label} size={a.size} mime={a.mime} href={src} note={IMAGE_FAILED} />;
  const box = single ? singleBox(a) : undefined;
  const frame = cn(
    "block max-w-full overflow-hidden rounded-md bg-muted",
    single ? "max-h-80 max-w-[360px]" : "aspect-square w-full",
  );
  const img = (
    <img
      src={src}
      alt={label}
      loading="lazy"
      width={a.width}
      height={a.height}
      onError={() => setFailed(true)}
      className={cn("object-contain", box || !single ? "size-full" : "max-h-80 max-w-full")}
    />
  );
  if (!onOpen)
    return (
      <div className={frame} style={box}>
        {img}
      </div>
    );
  return (
    <button
      type="button"
      aria-label={`${label} 크게 보기`}
      onClick={(e) => onOpen(e.currentTarget)}
      className={cn(frame, "outline-none focus-visible:ring-2 focus-visible:ring-ring")}
      style={box}
    >
      {img}
    </button>
  );
}

/** 메시지 첨부 이미지 격자(스펙 6.2) — 한 장이면 원본 비율로 최대 360×320, 두 장 이상이면 2열. `onOpen` 이 없으면 크게 보기 없이 */
export function AttachmentGrid({
  images,
  onOpen,
}: {
  images: readonly Attachment[];
  onOpen?: (index: number, trigger: HTMLElement) => void;
}) {
  const single = images.length === 1;
  return (
    <div
      data-slot="attachment-grid"
      className={cn("grid gap-2", single ? "grid-cols-1 justify-items-start" : "max-w-[360px] grid-cols-2")}
    >
      {images.map((a, i) => (
        <AttachmentImage
          key={a.id}
          attachment={a}
          single={single}
          onOpen={onOpen && ((el) => onOpen(i, el))}
        />
      ))}
    </div>
  );
}

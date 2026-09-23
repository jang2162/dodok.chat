import type { Attachment, Block } from "@dodok/shared";
import { useState } from "react";
import { AttachmentImage } from "@/features/attachments/AttachmentGrid";
import { FileCard } from "@/features/attachments/FileCard";
import { useImageViewer, type ViewerImage } from "@/features/attachments/ImageViewer";
import { type Resolved, resolveRef } from "@/features/attachments/resolve";
import { attachmentHref } from "@/features/attachments/url";
import { cn } from "@/lib/utils";
import { ATTACHMENT_MISSING, LINK_BLOCKED, Unresolved } from "./artifact";

type Item = Extract<Block, { type: "media" }>["items"][number];

/** 항목 수 → 열 수(1~3) */
const COLS = ["grid-cols-1", "grid-cols-1", "grid-cols-2", "grid-cols-3"] as const;

/** https 이미지의 표시 이름 — alt 가 없으면 장식이라 이미지에는 빈 alt, 크게 보기 버튼·제목에는 이 말 */
const HTTPS_IMAGE = "이미지";

/**
 * https 이미지 한 장 — 누르면 크게 보기(내려받기 링크는 없다). 불러오기에 실패하면 깨진 그림 대신
 * 새 탭 링크 「이미지: <alt 또는 주소>」로 물러난다(components 스펙 6장 — 메시지 본문의 마크다운 이미지와 같은 문구)
 */
function MediaImage({
  item,
  single,
  onOpen,
}: {
  item: Item;
  single: boolean;
  onOpen: (el: HTMLElement) => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm break-all text-primary underline"
      >
        이미지: {item.alt || item.url}
      </a>
    );
  }
  return (
    <button
      type="button"
      aria-label={`${item.alt || HTTPS_IMAGE} 크게 보기`}
      onClick={(e) => onOpen(e.currentTarget)}
      className={cn(
        "block max-w-full overflow-hidden rounded-md bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring",
        single ? "justify-self-start" : "aspect-square w-full",
      )}
    >
      <img
        src={item.url}
        // alt 가 없으면 빈 문자열 — 보조 기술이 장식으로 건너뛴다(주소를 읽어 주지 않게)
        alt={item.alt ?? ""}
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn("object-contain", single ? "max-h-80 max-w-full" : "size-full")}
      />
    </button>
  );
}

/** 크게 보기로 넘길 이미지 — https 와 자기 서버 이미지 첨부만(파일·못 찾음·막힘은 아니다) */
function viewable(item: Item, r: Resolved): ViewerImage | undefined {
  if (r.kind === "https") return { src: r.url, name: item.alt || HTTPS_IMAGE };
  if (r.kind !== "attachment" || r.attachment.kind !== "image") return undefined;
  const src = attachmentHref(r.attachment);
  if (!src) return undefined;
  return {
    src,
    name: item.alt || r.attachment.name,
    downloadHref: attachmentHref(r.attachment, { download: true }),
  };
}

type Props = { block: Extract<Block, { type: "media" }>; attachments: readonly Attachment[] };

/**
 * media 블록 — 이미지 격자(≤10, 항목 수에 따라 1~3열). **항목별로** `resolveRef`(첨부 스펙 6.3)로 갈린다:
 * `https://` 는 불러오고, `artifact://<이름 또는 id>` 는 **그 메시지의** 첨부로 풀어 이미지면 자기 서버 이미지, 파일이면 파일 카드,
 * 없으면 「첨부를 찾을 수 없습니다」, 그 밖의 값은 「열 수 없는 링크입니다」(링크 버튼·file 블록과 같은 문구).
 * 이미지(https·자기 서버 모두)는 누르면 크게 보기 — 이 블록 안 이미지만 넘긴다.
 *
 * https 이미지는 **불러온다** — 무엇이 드러나는지의 정본은 스펙 결정 8(docs/superpowers/specs/2026-09-21-components-v1-design.md 0장)이다.
 * 메시지 본문의 마크다운 이미지는 추적 픽셀 때문에 불러오지 않고 링크로만 두지만, 「이미지를 보여 주는 블록」이 링크만 내면 블록의 뜻이 사라진다.
 * `referrerPolicy="no-referrer"` 가 실제로 가리는 것은 **출처**(보는 사람이 어느 dodok 서버를 쓰는가)다 — 이 속성이 없어도 브라우저 기본
 * 정책 `strict-origin-when-cross-origin` 이 교차 출처 HTTPS 요청에는 출처만 보내므로 채널 경로는 원래 안 샌다. `loading="lazy"` 는 화면에
 * 가까워지면(들어오기 조금 전) 부른다. **남는 대가는 IP 하나가 아니다** — `crossOrigin` 없는 `<img>` 라 이미지 호스트는 보는 사람의
 * ① IP ② 본 시각(사실상 읽음 확인) ③ User-Agent 같은 요청 헤더 ④ 그 호스트가 심어 둔 `SameSite=None` 쿠키를 받는다.
 * `crossOrigin="anonymous"` 는 쿠키를 빼 주지만 CORS 헤더를 안 주는 호스트의 이미지가 실패하므로 쓰지 않았다.
 * `artifact://` 첨부 이미지는 자기 서버 경유라 이 대가가 없다
 */
export function MediaBlock({ block, attachments }: Props) {
  const single = block.items.length === 1;
  const images: ViewerImage[] = [];
  const cells = block.items.map((item) => {
    const r = resolveRef(item.url, attachments);
    const view = viewable(item, r);
    // 크게 보기 안에서의 차례 — 파일·못 찾음·막힘 칸은 건너뛴다
    const at = view ? images.push(view) - 1 : -1;
    return { item, r, at };
  });
  const { open, viewer } = useImageViewer(images);

  return (
    <>
      <div data-slot="media" className={cn("grid gap-2", COLS[Math.min(block.items.length, 3)])}>
        {cells.map(({ item, r, at }, i) => {
          if (r.kind === "https")
            return <MediaImage key={i} item={item} single={single} onOpen={(el) => open(at, el)} />;
          if (r.kind === "attachment" && r.attachment.kind === "image")
            return (
              <AttachmentImage
                key={i}
                attachment={r.attachment}
                single={single}
                label={item.alt || r.attachment.name}
                onOpen={(el) => open(at, el)}
              />
            );
          if (r.kind === "attachment")
            return (
              <FileCard
                key={i}
                name={r.attachment.name}
                size={r.attachment.size}
                mime={r.attachment.mime}
                href={attachmentHref(r.attachment)}
              />
            );
          return (
            <div
              key={i}
              className={cn(
                "flex flex-col items-center justify-center gap-1 rounded-md border border-dashed p-3 text-center",
                !single && "aspect-square",
              )}
            >
              <Unresolved text={r.kind === "missing" ? ATTACHMENT_MISSING : LINK_BLOCKED} />
              {item.alt && <span className="text-xs break-all text-muted-foreground">{item.alt}</span>}
            </div>
          );
        })}
      </div>
      {viewer}
    </>
  );
}

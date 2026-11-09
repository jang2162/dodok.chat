import { displayAttachmentName } from "@dodok/shared";
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useCallback, useRef, useState } from "react";
import { Button } from "@/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";

export type ViewerImage = {
  src: string;
  name: string;
  /** 원본 내려받기(`?download=1`) — 자기 서버 첨부만. https 이미지는 없다 */
  downloadHref?: string;
  /** 있으면 「메시지로 가기」 단추 — 파일함 격자만 준다(메시지 본문의 격자는 이미 그 메시지 곁이다) */
  onGoToMessage?: () => void;
};

type Props = {
  images: readonly ViewerImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** 닫은 뒤 초점을 돌려줄 요소 — 연 이미지 버튼(스펙 6.4) */
  trigger?: HTMLElement | null;
};

/**
 * 크게 보기(스펙 6.4) — 어두운 배경에 화면에 맞춰 원본 비율로. 같은 메시지 안의 이미지만 ←/→·화살표 버튼으로 넘기고
 * 끝에서 멈춘다(되돌지 않는다). 끝의 넘기기 버튼은 `disabled` 가 아니라 `aria-disabled` + 무동작 — `disabled` 가 되면 브라우저가
 * 누른 버튼의 초점을 body 로 빼서 ←/→ 가 `DialogContent` 에 닿지 않는다. Esc·바깥 누르기·닫기로 닫고 초점은 연 버튼으로 돌아간다 —
 * `DialogTrigger` 없이 열기 때문에 Radix 기본 복귀가 갈 곳이 없어 `onCloseAutoFocus` 에서 직접 돌려준다
 */
export function ImageViewer({ images, index, onIndexChange, onClose, trigger }: Props) {
  const image = images[index];
  if (!image) return null;
  const name = displayAttachmentName(image.name);
  const many = images.length > 1;
  const go = (next: number) => {
    if (next >= 0 && next < images.length && next !== index) onIndexChange(next);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") go(index - 1);
    else if (e.key === "ArrowRight") go(index + 1);
    else return;
    e.preventDefault();
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        showCloseButton={false}
        onKeyDown={onKeyDown}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          trigger?.focus();
        }}
        className="flex h-[calc(100dvh-2rem)] flex-col gap-3 border-none bg-black/90 p-3 text-white sm:max-w-[calc(100%-2rem)]"
      >
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <DialogTitle className="truncate text-base" title={name}>
              {/* 남이 지은 이름 — 방향 제어 문자가 옆의 「n / 전체」 순서를 뒤집지 못하게 격리한다 */}
              <bdi>{name}</bdi>
            </DialogTitle>
            <DialogDescription className={many ? "shrink-0 text-white/70 tabular-nums" : "sr-only"}>
              {index + 1} / {images.length}
            </DialogDescription>
          </div>
          {image.downloadHref && (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/10 hover:text-white"
            >
              <a href={image.downloadHref}>
                <DownloadIcon aria-hidden />
                원본 내려받기
              </a>
            </Button>
          )}
          {image.onGoToMessage && (
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/10 hover:text-white"
              onClick={() => {
                const go = image.onGoToMessage;
                onClose();
                go?.();
              }}
            >
              <MessageSquareIcon aria-hidden />
              메시지로 가기
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="text-white hover:bg-white/10 hover:text-white">
              <XIcon aria-hidden />
              <span className="sr-only">닫기</span>
            </Button>
          </DialogClose>
        </div>
        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          <img
            key={image.src}
            src={image.src}
            alt={name}
            referrerPolicy="no-referrer"
            className="max-h-full max-w-full object-contain"
          />
          {many && (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="이전 이미지"
                aria-disabled={index === 0 || undefined}
                onClick={() => go(index - 1)}
                className="absolute top-1/2 left-1 -translate-y-1/2 bg-black/40 text-white hover:bg-black/60 hover:text-white aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-black/40"
              >
                <ChevronLeftIcon aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="다음 이미지"
                aria-disabled={index === images.length - 1 || undefined}
                onClick={() => go(index + 1)}
                className="absolute top-1/2 right-1 -translate-y-1/2 bg-black/40 text-white hover:bg-black/60 hover:text-white aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-black/40"
              >
                <ChevronRightIcon aria-hidden />
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 크게 보기 상태 — 연 버튼을 쥐고 있다가 닫을 때 돌려준다. 메시지 첨부·media 블록이 같이 쓴다 */
export function useImageViewer(images: readonly ViewerImage[]): {
  open: (index: number, trigger: HTMLElement) => void;
  viewer: ReactNode;
} {
  const [index, setIndex] = useState<number | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const open = useCallback((i: number, el: HTMLElement) => {
    trigger.current = el;
    setIndex(i);
  }, []);
  const viewer =
    index === null ? null : (
      <ImageViewer
        images={images}
        index={index}
        onIndexChange={setIndex}
        onClose={() => setIndex(null)}
        trigger={trigger.current}
      />
    );
  return { open, viewer };
}

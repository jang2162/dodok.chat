import { useEffect } from "react";
import { toast } from "sonner";

/** 첨부는 Phase 2(스펙 1장) — 작성기 붙여넣기·끌어 놓기와 같은 문구·토스트 id */
export const FILES_LATER = "이미지는 Phase 2 에서 지원합니다";
export const FILES_LATER_TOAST_ID = "files-later";

const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;

/**
 * 앱 어디에 파일을 끌어 놓아도 브라우저가 그 파일을 열어 앱을 떠나지 않게 한다(web-t9 리뷰 M5).
 * 창에서 받으므로 스스로 처리한 자리(작성기 — 막고 알린다)는 이미 defaultPrevented 라 건드리지 않는다.
 * 글 끌어 놓기(입력 칸)는 파일이 아니라 그대로 둔다
 */
export function usePreventFileDrop(): void {
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none"; // 놓을 수 없는 자리 표시
    };
    const onDrop = (e: DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e)) return;
      e.preventDefault();
      toast.info(FILES_LATER, { id: FILES_LATER_TOAST_ID });
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
}

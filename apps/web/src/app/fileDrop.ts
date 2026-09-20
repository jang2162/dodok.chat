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
    // 안내는 끌고 있는 동안 한다. `dropEffect = "none"` 이면 브라우저가 `drop` 을 아예 주지 않아
    // 놓아도 아무 일이 없어 보였다(브라우저 검증 결함 2). 커서는 그대로 「놓을 수 없음」을 가리키고,
    // `drop` 을 주는 쪽에서는 그쪽이 알린다 — 한 번 끌 때 토스트는 하나다
    let announced = false;
    const announce = () => {
      if (announced) return;
      announced = true;
      toast.info(FILES_LATER, { id: FILES_LATER_TOAST_ID });
    };
    const onDragOver = (e: DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none"; // 놓을 수 없는 자리 표시
      announce();
    };
    const onDrop = (e: DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e)) {
        announced = false;
        return;
      }
      e.preventDefault();
      announce();
      announced = false; // 끌기가 끝났다 — 다음에 끌어 오면 다시 알린다
    };
    /** 창 밖으로 나가면(relatedTarget 없음) 놓지 않고 끝난 것이다 */
    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) announced = false;
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragleave", onDragLeave);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragleave", onDragLeave);
    };
  }, []);
}

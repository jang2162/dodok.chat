import type { FileListItem } from "@dodok/shared";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { requestJump } from "@/features/messages/jumpTarget";

/** 열린 대화상자·시트가 다 내려가기를 기다리는 상한 — 닫힘 애니메이션보다 넉넉히 */
const DIALOGS_GONE_MAX_MS = 1_500;

const EDITABLE =
  'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])';

/** 누른 단추 등에 남은 초점을 내려놓는다 — 목록은 초점이 떨어졌을 때만 행으로 옮긴다. 사람이 옮겨 간 입력 칸은 두고 간다 */
function releaseFocus(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && !active.matches(EDITABLE)) active.blur();
}

/**
 * 대화상자·시트가 하나도 남지 않으면(닫힘 애니메이션까지 끝나면) 부른다 — 상한이 지나도 부른다. Radix 는 DOM 에서 뺀 뒤 `setTimeout` 으로
 * 닫힘 초점 복귀(`onCloseAutoFocus`)를 부르므로 그 뒤 매크로태스크에서 부른다(먼저 부르면 늦은 복귀가 행의 초점을 가져간다)
 */
function whenDialogsGone(done: () => void): void {
  const until = performance.now() + DIALOGS_GONE_MAX_MS;
  const tick = () => {
    if (!document.querySelector('[role="dialog"]') || performance.now() > until) setTimeout(done, 0);
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * 「메시지로 가기」(파일함 계획 판정 PF7) — ⌘K 결과로 가기(`SearchDialog` 의 `pick`)와 같은 길: 그 메시지를 목표로 넣고(도착한 행이 초점을
 * 받는다) 그 세션으로, 답글이면 그 스레드로. 세 종류 모두 채널 경로다. 패널(좁은 화면은 시트)은 주소가 세션으로 바뀌면서 닫힌다.
 * 크게 보기·좁은 화면 시트처럼 대화상자가 열려 있으면 초점 목표는 그것이 다 닫힌 뒤에 다시 건다 — 열린 동안에는 초점 가둠이 행에 간
 * 초점을 되돌려 목록이 초점을 포기한다(파일함 태스크 5 브라우저 검증)
 */
export function useGoToFile(): (item: FileListItem) => void {
  const navigate = useNavigate();
  return useCallback(
    (item: FileListItem) => {
      const inDialog = document.querySelector('[role="dialog"]') !== null;
      releaseFocus();
      // 목표는 옮기기 전에 넣는다 — 새로 열리는 목록이 맨 아래로 붙지 않고 그 메시지로 간다
      requestJump(item, { focus: !inDialog });
      if (inDialog)
        whenDialogsGone(() => {
          // 닫힌 시트가 돌려준 자리(머리의 「채널 설정」 등)에서 다시 내려놓아야 목록이 행으로 옮긴다
          releaseFocus();
          requestJump(item, { focus: true });
        });
      const params = { channelId: item.channelId, conversationId: item.conversationId };
      if (item.threadRootId === undefined) void navigate({ to: "/c/$channelId/s/$conversationId", params });
      else
        void navigate({
          to: "/c/$channelId/s/$conversationId/t/$rootId",
          params: { ...params, rootId: item.threadRootId },
        });
    },
    [navigate],
  );
}

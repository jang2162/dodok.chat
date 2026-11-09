import type { FileListItem } from "@dodok/shared";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { requestJump } from "@/features/messages/jumpTarget";

/**
 * 「메시지로 가기」(파일함 계획 판정 PF7) — ⌘K 결과로 가기(`SearchDialog` 의 `pick`)와 같은 길: 그 메시지를 목표로 넣고(도착한 행이 초점을
 * 받는다) 그 세션으로, 답글이면 그 스레드로. 세 종류 모두 채널 경로다. 패널(좁은 화면은 시트)은 주소가 세션으로 바뀌면서 닫힌다
 */
export function useGoToFile(): (item: FileListItem) => void {
  const navigate = useNavigate();
  return useCallback(
    (item: FileListItem) => {
      requestJump(item, { focus: true });
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

import { useState } from "react";
import { Button } from "@/ui/button";
import { useDrafts } from "./draft";

/**
 * 채널 설정 패널 아래의 저장 막대(패널 재설계 스펙 목표 6) — 바뀐 칸이 있을 때만 「바뀐 항목 N개 · 되돌리기 · 저장」. 스크롤 상자 아래에
 * 붙는다(`sticky`). 저장 중·보낼 것이 없을 때의 잠금은 `disabled` 가 아니라 `aria-disabled` — 키보드로 저장한 사람의 초점이 `<body>` 로
 * 떨어지지 않게. 같은 까닭으로 모두 저장해 바뀐 것이 0 이 돼도 초점이 막대 안에 있는 동안은 막대를 남기고, 초점이 떠나면 내린다
 */
export function SaveBar() {
  const { total, saving, saveAll, resetAll } = useDrafts();
  const [held, setHeld] = useState(false);
  if (total === 0 && !saving && !held) return null;
  const idle = total === 0 || saving;
  return (
    <div
      role="region"
      aria-label="저장하지 않은 변경"
      className="sticky bottom-0 z-10 flex items-center gap-2 border-t bg-background px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHeld(false);
      }}
    >
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        {saving ? "저장하는 중…" : total > 0 ? `바뀐 항목 ${total}개` : "모두 저장했습니다"}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-disabled={idle || undefined}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        onClick={() => {
          if (!idle) resetAll();
        }}
      >
        되돌리기
      </Button>
      <Button
        type="button"
        size="sm"
        aria-disabled={idle || undefined}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        onClick={() => {
          if (!idle) void saveAll();
        }}
      >
        {saving ? "저장 중…" : "저장"}
      </Button>
    </div>
  );
}

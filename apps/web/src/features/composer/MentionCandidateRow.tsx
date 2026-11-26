import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { IdentityAvatar } from "@/ui/identity-avatar";
import type { MentionCandidate } from "./mentions";

/** 두 후보 목록(@ 입력 목록·@ 단추 피커)의 줄 겉 — 바깥 요소(option·label)는 각 목록이 정한다 */
export const CANDIDATE_ROW_CLASS =
  "flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm";

/** @ 입력 목록의 체크 표시 — 줄(option)이 aria-checked 를 싣고 이것은 그림일 뿐이다(option 안에 조작 요소를 두지 않는다) */
export function CheckMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      data-checked={checked}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input",
        checked && "border-primary bg-primary text-primary-foreground",
      )}
    >
      {checked && <CheckIcon className="size-3" />}
    </span>
  );
}

/**
 * 후보 한 줄: [체크] [아바타 24px] [이름(굵게)] [@핸들(흐리게)] [Gateway·AI·초대됨·이미 넣음·꺼짐]. 한 줄을 넘기지 않는다 — 이름과
 * 핸들은 줄바꿈 없이 말줄임(핸들 안의 `-` 에서 꺾이지 않게), 이름이 먼저 줄고 핸들은 최소 폭을 지킨다. 잘려도 `title` 로 전체
 */
export function MentionCandidateRow({
  candidate: c,
  check,
  locked = false,
}: {
  candidate: MentionCandidate;
  check: ReactNode;
  /** 이미 초안에 든 후보 */
  locked?: boolean;
}) {
  return (
    <>
      {check}
      <IdentityAvatar
        aria-hidden
        kind={c.kind === "agent" ? "agent" : "person"}
        id={c.id.slice(2)}
        name={c.name}
        handle={c.label}
        avatarUrl={c.avatarUrl ?? null}
        size={24}
        className="shrink-0"
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5" title={`${c.name} · @${c.label}`}>
        <span className="min-w-0 shrink-[4] truncate font-medium whitespace-nowrap">{c.name}</span>
        <span className="min-w-12 shrink truncate whitespace-nowrap text-muted-foreground">@{c.label}</span>
      </span>
      {c.gateway !== undefined && (
        <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">{c.gateway}</span>
      )}
      {c.kind === "agent" && (
        <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
          AI
        </Badge>
      )}
      {c.invited && <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">초대됨</span>}
      {locked && <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">이미 넣음</span>}
      {!c.enabled && <span className="shrink-0 text-xs whitespace-nowrap">꺼짐</span>}
    </>
  );
}

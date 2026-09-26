import type { MemberRow, TeamRole } from "@dodok/shared";
import { useRef, useState } from "react";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { josa } from "@/lib/josa";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { IssuedLink } from "./IssuedLink";
import { useIssueResetLink, useRemoveMember } from "./mutations";

/**
 * 그 줄에 손댈 수 있는가(팀 스펙 2장·4장) — owner 는 owner 를 뺀 모두, admin 은 member 만. 서버가 같은 규칙으로 막는다
 */
export function canActOn(viewer: TeamRole, target: TeamRole): boolean {
  return viewer === "owner" ? target !== "owner" : viewer === "admin" && target === "member";
}

/** 멤버 줄의 「재설정 링크」·「내보내기」 — 손댈 수 없는 줄이면 아무것도 그리지 않는다 */
export function MemberRowActions({ member, viewerRole }: { member: MemberRow; viewerRole: TeamRole }) {
  const [removing, setRemoving] = useState(false);
  const remove = useRemoveMember();
  const removeRef = useRef<HTMLButtonElement>(null);
  if (!canActOn(viewerRole, member.role)) return null;
  const handle = `@${member.handle}`;
  return (
    <div className="flex justify-end gap-1">
      <ResetLinkDialog member={member} />
      <Button
        ref={removeRef}
        variant="ghost"
        size="xs"
        aria-label={`${handle} 내보내기`}
        onClick={() => setRemoving(true)}
      >
        내보내기
      </Button>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="멤버 내보내기"
        description={`${handle} ${josa(handle, "을", "를")} 워크스페이스에서 내보냅니다. 곧바로 로그아웃되고, 다시 들어오려면 새 초대가 필요합니다. 쓴 메시지는 남습니다`}
        confirmLabel="내보내기"
        pendingLabel="내보내는 중…"
        pending={remove.isPending}
        destructive
        returnFocus={removeRef}
        onConfirm={() => remove.mutate(member.id, { onSuccess: () => setRemoving(false) })}
      />
    </div>
  );
}

/**
 * 「재설정 링크」 — 확인 뒤 만든다(같은 사람의 앞 링크는 서버가 폐기한다) → 링크를 한 번만 보인다(초대와 같은 꼴).
 * 발급 중·링크가 보이는 동안은 닫지 않는다
 */
function ResetLinkDialog({ member }: { member: MemberRow }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string>();
  const issue = useIssueResetLink(member.id, setUrl);
  const handle = `@${member.handle}`;

  function close() {
    setOpen(false);
    setUrl(undefined);
    issue.reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else if (!issue.isPending && !url) close();
      }}
    >
      <Button variant="ghost" size="xs" aria-label={`${handle} 재설정 링크`} onClick={() => setOpen(true)}>
        재설정 링크
      </Button>
      <DialogContent showCloseButton={!url} closeDisabled={issue.isPending}>
        {url ? (
          <IssuedLink
            title="재설정 링크를 만들었습니다"
            url={url}
            hint={`${handle} 에게 건네세요. 24시간 안에 한 번 쓸 수 있습니다.`}
            onDone={close}
          />
        ) : (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>비밀번호 재설정 링크</DialogTitle>
              <DialogDescription>
                {handle} 의 비밀번호를 새로 정하는 링크를 만듭니다. 앞서 만든 재설정 링크는 쓸 수 없게 됩니다.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={issue.isPending} onClick={close}>
                취소
              </Button>
              <Button type="button" disabled={issue.isPending} onClick={() => issue.mutate(undefined)}>
                {issue.isPending ? "만드는 중…" : "링크 만들기"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

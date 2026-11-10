import type { TeamRole } from "@dodok/shared";
import { UserPlusIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { formError } from "@/api/formErrors";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/ui/dialog";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { IssuedLink } from "./IssuedLink";
import { useIssueInvite } from "./mutations";

/**
 * 「초대」(팀 스펙 6장) — 역할을 고르고(owner 만, admin 은 member 고정) 링크를 만든다 → 링크를 한 번만 보인다.
 * 발급 중·링크가 보이는 동안은 닫지 않는다(Esc·바깥 클릭·X 없음) — 링크는 「복사했습니다」로만 버린다
 */
export function InviteDialog({ viewerRole }: { viewerRole: TeamRole }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<"admin" | "member">("member");
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const issue = useIssueInvite(setUrl);
  const id = useId();
  const canPickRole = viewerRole === "owner";

  function reset() {
    setRole("member");
    setUrl(undefined);
    setError(undefined);
    issue.reset();
  }

  function onOpenChange(next: boolean) {
    if (!next && (issue.isPending || url)) return;
    setOpen(next);
    if (!next) reset();
  }

  function done() {
    setOpen(false);
    reset();
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (issue.isPending) return;
    setError(undefined);
    issue.mutate(canPickRole ? role : "member", { onError: (err) => setError(formError(err)) });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" size="sm">
          <UserPlusIcon />
          초대
        </Button>
      </DialogTrigger>
      <DialogContent
        // 발급 화면은 IssuedLink 의 DialogDescription 을 Radix 가 잇는다 — 설명이 없는 입력 화면에서만 끊는다
        {...(url ? {} : { "aria-describedby": undefined })}
        showCloseButton={!url}
        closeDisabled={issue.isPending}
      >
        {url ? (
          <IssuedLink
            title="초대 링크를 만들었습니다"
            url={url}
            hint="7일 안에 한 번 쓸 수 있습니다."
            onDone={done}
          />
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>멤버 초대</DialogTitle>
            </DialogHeader>
            {canPickRole ? (
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">역할</legend>
                <RadioGroup value={role} onValueChange={(v) => setRole(v as "admin" | "member")}>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id={`${id}-member`} value="member" />
                    <Label htmlFor={`${id}-member`} className="font-normal">
                      멤버
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id={`${id}-admin`} value="admin" />
                    <Label htmlFor={`${id}-admin`} className="font-normal">
                      관리자
                    </Label>
                  </div>
                </RadioGroup>
              </fieldset>
            ) : (
              <p className="text-sm text-muted-foreground">
                멤버로 초대합니다. 관리자 초대는 owner 만 할 수 있습니다.
              </p>
            )}
            {error !== undefined && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={issue.isPending}>
                {issue.isPending ? "만드는 중…" : "링크 만들기"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

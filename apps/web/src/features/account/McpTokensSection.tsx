import {
  PERSONAL_TOKENS_MAX,
  PersonalTokenCreate,
  type PersonalTokenIssued,
  type PersonalTokenSummary,
} from "@dodok/shared";
import { KeyRoundIcon } from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { qk } from "@/api/queries";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { useIssueToken } from "@/features/setup/mutations";
import { CopyBlock } from "@/features/setup/sections";
import { when } from "@/features/setup/TokenList";
import { useLeaveGuard } from "@/hooks/useLeaveGuard";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { mcpAddCommand, usePersonalTokens, useRevokePersonalToken } from "./tokens";

/** 이름 칸 상한 — 서버가 받는 규칙(shared `PersonalTokenCreate`)에서 읽는다 */
const LABEL_MAX = PersonalTokenCreate.shape.label.maxLength ?? 40;
export const TOKENS_FULL = `토큰은 ${PERSONAL_TOKENS_MAX}개까지 발급할 수 있습니다 — 쓰지 않는 토큰을 폐기하세요`;

/**
 * 「내 계정」의 「MCP 토큰」 절(제어 MCP 스펙 「웹」 장) — 발급·목록·폐기. 누구나 자기 것만 본다.
 * 토큰은 그 사람의 지금 역할로 판정되므로(member 면 member 일만) 화면은 역할을 가르지 않는다.
 * 살아 있는 토큰이 상한이면 발급 버튼을 잠근다 — 서버도 CONFLICT 로 막는다(그때는 대화상자가 같은 문구를 보인다)
 */
export function McpTokensSection() {
  const tokens = usePersonalTokens();
  const issueButton = useRef<HTMLButtonElement>(null);
  const list = tokens.data;
  const full = list !== undefined && list.length >= PERSONAL_TOKENS_MAX;

  return (
    <section aria-labelledby="mcp-tokens-title" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="mcp-tokens-title" className="text-sm font-medium">
          MCP 토큰
        </h2>
        <p className="text-sm text-muted-foreground">
          Claude Code 같은 바깥 MCP 클라이언트가 내 권한으로 채널·에이전트를 읽고 바꿀 때 씁니다. 토큰을 가진
          사람은 나와 같은 일을 할 수 있으니 비밀번호처럼 다루세요.
        </p>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <IssueMcpTokenDialog triggerRef={issueButton} disabled={list === undefined || full} />
        {full && <p className="text-xs text-muted-foreground">{TOKENS_FULL}</p>}
      </div>
      {tokens.isError ? (
        <p role="alert" className="text-sm text-destructive">
          토큰 목록을 불러오지 못했습니다.
        </p>
      ) : list === undefined ? (
        <p className="text-sm text-muted-foreground">불러오는 중…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">발급한 토큰이 없습니다.</p>
      ) : (
        <McpTokenList tokens={list} issueButton={issueButton} />
      )}
    </section>
  );
}

/**
 * 목록 — 이름·`dpt_` + 앞 6자·만든 때·마지막 사용. 폐기는 확인을 거친다. 폐기한 줄은 목록에서 빠져 초점을 돌려줄 자리가
 * 사라진다 — 아래 줄의 「폐기」, 없으면 위 줄, 그것도 없으면 「새 토큰 발급」으로 옮긴다
 */
function McpTokenList({
  tokens,
  issueButton,
}: {
  tokens: PersonalTokenSummary[];
  issueButton: RefObject<HTMLButtonElement | null>;
}) {
  const revoke = useRevokePersonalToken();
  const [target, setTarget] = useState<PersonalTokenSummary>();
  const returnFocus = useRef<HTMLElement | null>(null);
  const revokeButtons = useRef(new Map<string, HTMLButtonElement>());

  function confirm() {
    if (!target) return;
    const at = tokens.findIndex((t) => t.id === target.id);
    const neighbour = tokens[at + 1] ?? tokens[at - 1];
    revoke.mutate(target.id, {
      onSuccess: () => {
        returnFocus.current = (neighbour && revokeButtons.current.get(neighbour.id)) ?? issueButton.current;
      },
      onSettled: () => setTarget(undefined),
    });
  }

  return (
    <>
      <ul className="flex flex-col divide-y rounded-md border">
        {tokens.map((token) => (
          <li
            key={token.id}
            aria-label={token.label}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-2.5 text-sm"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium break-all">{token.label}</span>
                <span className="font-mono text-xs text-muted-foreground">{`dpt_${token.prefix}…`}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                만든 때 {when(token.createdAt)} · 마지막 사용{" "}
                {token.lastUsedAt ? when(token.lastUsedAt) : "없음"}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={`${token.label} 폐기`}
              disabled={revoke.isPending}
              ref={(el) => {
                if (el) revokeButtons.current.set(token.id, el);
                else revokeButtons.current.delete(token.id);
              }}
              onClick={(e) => {
                returnFocus.current = e.currentTarget;
                setTarget(token);
              }}
            >
              폐기
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={target !== undefined}
        onOpenChange={(open) => {
          if (!open) setTarget(undefined);
        }}
        title={`「${target?.label ?? ""}」 토큰을 폐기할까요?`}
        description="이 토큰을 쓰는 MCP 클라이언트는 곧바로 거절됩니다. 되돌릴 수 없습니다."
        confirmLabel="폐기"
        pendingLabel="폐기하는 중…"
        pending={revoke.isPending}
        destructive
        returnFocus={returnFocus}
        onConfirm={confirm}
      />
    </>
  );
}

/** 발급 실패 중 대화상자가 그리는 것 — 서버 문구 대신 고정 문구. 그 밖(네트워크·5xx)은 undefined — 전역 토스트가 알린다 */
function issueError(e: unknown): string | undefined {
  if (!(e instanceof ApiRequestError)) return undefined;
  if (e.code === "VALIDATION") return `이름은 1~${LABEL_MAX}자로 적어 주세요.`;
  if (e.code === "CONFLICT") return TOKENS_FULL;
  return undefined;
}

/**
 * 발급 — 이름 → 원문과 `claude mcp add` 예시를 한 번 보인다. 원문을 다루는 규칙은 연결 페이지의 발급 대화상자와 같다
 * (setup/IssueTokenDialog 의 `IssueDialog`): 원문은 이 컴포넌트 상태에만 있고(`useIssueToken` 이 뮤테이션 캐시에 남기지 않는다)
 * 「복사했습니다」로만 닫으며 그때 버린다, 원문이 보이는 동안 페이지를 떠나는 것도 막는다(`useLeaveGuard`).
 * `IssueDialog` 를 쓰지 않는 까닭: 발급 응답 꼴(`{ token: 요약, raw }`)·이름 상한(40)·상한 초과 문구가 달라서 그쪽에 갈래를 늘리게 된다
 */
function IssueMcpTokenDialog({
  triggerRef,
  disabled,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string>();
  const [issued, setIssued] = useState<PersonalTokenIssued>();
  const issue = useIssueToken<PersonalTokenIssued>("/me/tokens", qk.personalTokens, setIssued);
  const labelId = useId();
  const errorId = useId();
  const trimmed = label.trim();
  const stayRef = useRef<HTMLButtonElement>(null);
  const leave = useLeaveGuard(issued !== undefined);
  useEffect(() => {
    if (leave.status === "blocked") stayRef.current?.focus();
  }, [leave.status]);

  function reset() {
    setLabel("");
    setError(undefined);
    setIssued(undefined);
    issue.reset();
  }

  function onOpenChange(next: boolean) {
    // 발급 중·원문이 보이는 동안은 닫지 않는다 — 원문은 「복사했습니다」로만 버린다
    if (!next && (issue.isPending || issued)) return;
    setOpen(next);
    if (!next) reset();
  }

  /** 원문을 버리고 닫는다. 막아 둔 라우트 이동이 있으면 이어서 보낸다 — 떠나려던 사람이 복사를 마친 것이다 */
  function done() {
    const proceed = leave.status === "blocked" ? leave.proceed : undefined;
    setOpen(false);
    reset();
    proceed?.();
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!trimmed || issue.isPending) return;
    setError(undefined);
    issue.mutate(trimmed, { onError: (err) => setError(issueError(err)) });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button ref={triggerRef} type="button" size="sm" disabled={disabled}>
          <KeyRoundIcon />새 토큰 발급
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!issued} closeDisabled={issue.isPending}>
        {issued ? (
          <div className="grid min-w-0 gap-4">
            <DialogHeader>
              <DialogTitle>「{issued.token.label}」 토큰을 발급했습니다</DialogTitle>
              <DialogDescription>이 토큰은 다시 볼 수 없습니다. 닫기 전에 복사해 두세요.</DialogDescription>
            </DialogHeader>
            <div className="grid min-w-0 gap-1.5">
              <p className="text-sm font-medium">토큰</p>
              <CopyBlock text={issued.raw} label="토큰 복사" wrap />
            </div>
            <div className="grid min-w-0 gap-1.5">
              <p className="text-sm font-medium">Claude Code 에 붙이기</p>
              <p className="text-xs text-muted-foreground">
                터미널에서 이 명령을 실행하면 Claude Code 가 dodok 도구를 씁니다. 토큰이 들어 있으니 원문처럼
                다루세요.
              </p>
              <CopyBlock
                text={mcpAddCommand(window.location.origin, issued.raw)}
                label="명령 복사"
                testId="mcp-add-command"
              />
            </div>
            {leave.status === "blocked" && (
              <div
                role="alert"
                className="flex flex-col gap-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm"
              >
                <p className="font-medium">이 페이지를 떠나면 토큰 원문을 다시 볼 수 없습니다.</p>
                <p>복사를 마쳤다면 「복사했습니다」를 누르세요. 닫고 이어서 이동합니다.</p>
                <div className="flex flex-wrap gap-2">
                  <Button ref={stayRef} type="button" size="sm" variant="outline" onClick={leave.reset}>
                    머무르기
                  </Button>
                  <Button type="button" size="sm" variant="destructive" onClick={done}>
                    원문을 버리고 떠나기
                  </Button>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button type="button" onClick={done}>
                복사했습니다
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>새 MCP 토큰</DialogTitle>
              <DialogDescription>
                알아볼 이름을 붙입니다(예: 노트북 Claude Code). 원문은 발급 직후 한 번만 보입니다.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor={labelId}>이름</Label>
              <Input
                id={labelId}
                value={label}
                maxLength={LABEL_MAX}
                autoComplete="off"
                aria-invalid={error !== undefined || undefined}
                aria-describedby={error !== undefined ? errorId : undefined}
                onChange={(e) => {
                  setLabel(e.target.value);
                  setError(undefined);
                }}
              />
            </div>
            {error !== undefined && (
              <p id={errorId} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={!trimmed || issue.isPending}>
                {issue.isPending ? "발급하는 중…" : "발급"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

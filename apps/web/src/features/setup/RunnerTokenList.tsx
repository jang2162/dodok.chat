import type { RunnerConnection, RunnerTokenRecord, SetupStatus } from "@dodok/shared";
import { type RefObject, useRef, useState } from "react";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { useRevokeRunnerToken } from "./mutations";
import { ReissueRunnerTokenDialog } from "./ReissueRunnerTokenDialog";
import { when } from "./TokenList";

/**
 * 지금 러너가 붙어 있는 토큰 id — 실시간 상태(`setup.status`)가 있으면 그것을, 없으면 목록 응답의 `connected` 를 본다.
 * 러너는 여러 대가 함께 붙는다(토큰 하나 = 러너 연결 하나, 러너 스펙 5장)
 */
export function connectedRunnerTokenIds(
  tokens: readonly RunnerTokenRecord[],
  status: SetupStatus | undefined,
): ReadonlySet<string> {
  if (status) return new Set(status.runners.list.map((r) => r.tokenId));
  return new Set(tokens.filter((t) => t.connected).map((t) => t.id));
}

/**
 * 붙은 러너가 서버가 품은 러너 파일과 같은 빌드인가(러너 스펙 5장 「같은 빌드」) — hello 의 bundleSha256 으로 가른다. 붙어 있지 않으면 없다
 */
function RunnerBuild({
  runner,
  file,
}: {
  runner: RunnerConnection;
  file: SetupStatus["runners"]["runnerFile"];
}) {
  if (runner.bundleSha256 === null || !file.available) return null;
  if (runner.bundleSha256 === file.bundleSha256)
    return <p className="text-xs text-muted-foreground">서버와 같은 빌드입니다</p>;
  return (
    <p role="alert" className="text-xs font-medium text-destructive">
      다른 빌드입니다 — 러너를 받아서 다시 설치하세요
    </p>
  );
}

/**
 * 러너 토큰 목록(러너 스펙 5장) — 라벨·`drn_` + 앞 6자·만든 때·마지막 사용·「지금 접속 중」(붙어 있으면 같은 빌드인지)·폐기됨과
 * 「다시 발급」·「폐기」. 러너의 연결 상태·프로젝트는 「러너」 탭이 맡는다(러너 일반화 스펙 7장). 폐기는 확인을 거친다 — 붙어 있으면
 * 그 러너가 곧바로 끊긴다고 알린다. 러너는 서로 대신하지 않으므로 브리지 토큰의 「마지막 활성 토큰」 한 번 더 묻기는 없다.
 * 폐기한 줄에는 「폐기」 버튼이 없어 초점을 돌려줄 자리가 사라진다 — 아래 줄의 「폐기」, 없으면 `issueButton` 으로 옮긴다
 */
export function RunnerTokenList({
  tokens,
  status,
  issueButton,
}: {
  tokens: RunnerTokenRecord[];
  status: SetupStatus | undefined;
  issueButton?: RefObject<HTMLButtonElement | null>;
}) {
  const revoke = useRevokeRunnerToken();
  const [target, setTarget] = useState<RunnerTokenRecord>();
  const returnFocus = useRef<HTMLElement | null>(null);
  const revokeButtons = useRef(new Map<string, HTMLButtonElement>());
  const connectedIds = connectedRunnerTokenIds(tokens, status);

  function start(token: RunnerTokenRecord, button: HTMLButtonElement) {
    returnFocus.current = button;
    setTarget(token);
  }

  function confirm() {
    if (!target) return;
    const id = target.id;
    revoke.mutate(id, {
      onSuccess: () => {
        returnFocus.current = focusAfterRevoke(id);
      },
      onSettled: () => setTarget(undefined),
    });
  }

  function focusAfterRevoke(id: string): HTMLElement | null {
    const after = tokens.slice(tokens.findIndex((t) => t.id === id) + 1);
    const next = after.find((t) => t.revokedAt === null);
    return (next && revokeButtons.current.get(next.id)) ?? issueButton?.current ?? null;
  }

  return (
    <>
      <ul className="flex flex-col divide-y rounded-md border">
        {tokens.map((token) => {
          const revoked = token.revokedAt !== null;
          const live = status?.runners.list.find((r) => r.tokenId === token.id);
          return (
            <li
              key={token.id}
              aria-label={token.label}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-2.5 text-sm"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={revoked ? "font-medium text-muted-foreground line-through" : "font-medium"}
                  >
                    {token.label}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">drn_{token.prefix}…</span>
                  {connectedIds.has(token.id) && <Badge>지금 접속 중</Badge>}
                  {revoked && <Badge variant="outline">폐기됨</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  만든 때 {when(token.createdAt)} · 마지막 사용{" "}
                  {token.lastUsedAt ? when(token.lastUsedAt) : "없음"}
                </p>
                {live && status && <RunnerBuild runner={live} file={status.runners.runnerFile} />}
              </div>
              {!revoked && (
                <div className="flex flex-wrap gap-1.5">
                  <ReissueRunnerTokenDialog token={token} connected={connectedIds.has(token.id)} />
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
                    onClick={(e) => start(token, e.currentTarget)}
                  >
                    폐기
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={target !== undefined}
        onOpenChange={(open) => {
          if (!open) setTarget(undefined);
        }}
        title={`「${target?.label ?? ""}」 러너 토큰을 폐기할까요?`}
        description={
          target && connectedIds.has(target.id)
            ? "지금 이 토큰으로 러너가 붙어 있습니다. 폐기하면 곧바로 끊기고 그 러너의 에이전트가 멈춥니다. 되돌릴 수 없습니다."
            : "폐기한 토큰으로는 다시 접속할 수 없습니다. 되돌릴 수 없습니다."
        }
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

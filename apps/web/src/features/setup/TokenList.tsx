import type { BridgeTokenRecord, GatewaySetup } from "@dodok/shared";
import { type RefObject, useRef, useState } from "react";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { useRevokeBridgeToken } from "./mutations";

const WHEN = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });
export const when = (iso: string) => WHEN.format(new Date(iso));

/**
 * 지금 접속 중인 토큰 id — 그 Gateway 의 실시간 상태(`setup.status`)가 있으면 그것을, 없으면 목록 응답의 `connected` 를 본다.
 * 상태는 wire 로 바로 오고 목록은 다시 받아야 하므로 상태가 먼저 옳다
 */
export function connectedTokenId(tokens: readonly BridgeTokenRecord[], gateway: GatewaySetup | undefined) {
  if (gateway) return gateway.bridge.plugin?.tokenId ?? null;
  return tokens.find((t) => t.connected)?.id ?? null;
}

/**
 * 「이제 폐기해도 됩니다」(스펙 「연결 페이지」 교체 흐름 3) — 플러그인이 더 새 토큰으로 붙어 있으면 그보다 먼저 만든 활성 토큰은 쓰이지
 * 않는다. 새 토큰을 막 발급했을 뿐(아직 옛 토큰으로 접속)이면 어느 줄에도 뜨지 않는다
 */
function replaced(token: BridgeTokenRecord, current: BridgeTokenRecord | undefined): boolean {
  return (
    current !== undefined &&
    token.revokedAt === null &&
    token.id !== current.id &&
    Date.parse(token.createdAt) < Date.parse(current.createdAt)
  );
}

type Step = "confirm" | "last";

/**
 * 그 Gateway 의 토큰 목록(스펙 「연결 페이지」) — 라벨·`dbt_` + 앞 6자·만든 때·마지막 사용·「지금 접속 중」·폐기됨.
 * 폐기는 확인을 거친다: 접속 중이면 에이전트가 멈춘다고, 활성 토큰이 0개가 되면 한 번 더(`ConfirmDialog` 의 `escalated`).
 * 폐기한 줄에는 「폐기」 버튼이 없어 초점을 돌려줄 자리가 사라진다 — 아래 줄의 「폐기」, 없으면 `issueButton`(「새 토큰 발급」)으로 옮긴다
 */
export function TokenList({
  gatewayId,
  tokens,
  gateway,
  issueButton,
}: {
  gatewayId: string;
  tokens: BridgeTokenRecord[];
  /** 그 Gateway 의 실시간 상태 — 없으면(상태를 아직 못 받음) 목록의 connected 를 본다 */
  gateway: GatewaySetup | undefined;
  issueButton?: RefObject<HTMLButtonElement | null>;
}) {
  const revoke = useRevokeBridgeToken(gatewayId);
  const [target, setTarget] = useState<{ token: BridgeTokenRecord; step: Step }>();
  const returnFocus = useRef<HTMLElement | null>(null);
  const revokeButtons = useRef(new Map<string, HTMLButtonElement>());
  const connectedId = connectedTokenId(tokens, gateway);
  const current = tokens.find((t) => t.id === connectedId);
  const active = tokens.filter((t) => t.revokedAt === null);

  function start(token: BridgeTokenRecord, button: HTMLButtonElement) {
    returnFocus.current = button;
    setTarget({ token, step: "confirm" });
  }

  function confirm() {
    if (!target) return;
    const last = active.length === 1 && active[0]?.id === target.token.id;
    if (target.step === "confirm" && last) {
      setTarget({ token: target.token, step: "last" });
      return;
    }
    const id = target.token.id;
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

  const connected = target?.token.id === connectedId;
  const dialog =
    target?.step === "last"
      ? {
          title: "활성 토큰이 하나도 남지 않습니다",
          description: "모든 브리지 접속이 거절되고 에이전트가 답하지 못합니다.",
          confirmLabel: "그래도 폐기",
        }
      : {
          title: `「${target?.token.label ?? ""}」 토큰을 폐기할까요?`,
          description: connected
            ? "지금 접속한 플러그인이 곧바로 끊기고 에이전트가 멈춥니다."
            : "되돌릴 수 없습니다.",
          confirmLabel: "폐기",
        };

  return (
    <>
      <ul className="flex flex-col divide-y rounded-md border">
        {tokens.map((token) => {
          const revoked = token.revokedAt !== null;
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
                  <span className="font-mono text-xs text-muted-foreground">{`dbt_${token.prefix}…`}</span>
                  {token.id === connectedId && <Badge>지금 접속 중</Badge>}
                  {revoked && <Badge variant="outline">폐기됨</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">
                  만든 때 {when(token.createdAt)} · 마지막 사용{" "}
                  {token.lastUsedAt ? when(token.lastUsedAt) : "없음"}
                </p>
                {replaced(token, current) && (
                  <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                    이제 폐기해도 됩니다 — 플러그인이 새 토큰으로 접속해 있습니다
                  </p>
                )}
              </div>
              {!revoked && (
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
        title={dialog.title}
        description={dialog.description}
        confirmLabel={dialog.confirmLabel}
        pendingLabel="폐기하는 중…"
        pending={revoke.isPending}
        destructive
        returnFocus={returnFocus}
        escalated={target?.step === "last"}
        onConfirm={confirm}
      />
    </>
  );
}

import type { ApprovalDecision, ApprovalReason, ApprovalSeverity, ApprovalStatus } from "@dodok/shared";
import { InfoIcon, type LucideIcon, ShieldAlertIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAuthors } from "@/features/messages/useAuthors";
import { cn } from "@/lib/utils";
import { emitAck, useWireStatus, WireAckError } from "@/realtime/wire";
import { useWire } from "@/realtime/WireProvider";
import { Button } from "@/ui/button";
import { useApprovalStore } from "./approvalStore";
import { EXPIRED_LABEL, useRemaining } from "./countdown";

/** 버튼 차례와 글. `allowedDecisions` 에 있는 것만 그린다 — 목록 밖 값은 Gateway 가 조용히 거절로 확정한다(스파이크 4.4) */
const DECISIONS = [
  { decision: "allow-once", label: "이번만 허용", variant: "default" },
  { decision: "allow-always", label: "항상 허용", variant: "secondary" },
  { decision: "deny", label: "거절", variant: "outline" },
] as const;

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  "allow-once": "이번만 허용",
  "allow-always": "항상 허용",
  deny: "거절",
};

/** 확정된 카드의 결과 한 줄. **`status` 가 정본**이다 — 같은 만료라도 `decision` 은 경로마다 다르다(p2-t6 보고서 2) */
const OUTCOME: Record<Exclude<ApprovalStatus, "pending">, string> = {
  allowed: "허용됨",
  denied: "거절됨",
  expired: "만료됨",
  cancelled: "취소됨",
};

/**
 * 결과 한 줄에 덧붙이는 까닭 — 「왜 내 답이 아닌 것으로 닫혔나」가 안 보이는 것만(설계 6장 「만료됨(연결 끊김)」).
 * `user`(내가 눌렀다)·`timeout`(카운트다운이 다 됐다)은 이미 화면에 있으므로 적지 않는다
 */
const REASON_NOTE: Partial<Record<ApprovalReason, string>> = {
  "no-route": "연결 끊김",
  "gateway-restart": "Gateway 재시작",
  "run-aborted": "실행 중지",
  "malformed-verdict": "받지 않는 선택",
  "storage-corrupt": "Gateway 저장소 오류",
};

const LOOK: Record<ApprovalSeverity, { Icon: LucideIcon; label: string; tone: string; bar: string }> = {
  info: { Icon: InfoIcon, label: "정보", tone: "text-muted-foreground", bar: "bg-border" },
  warning: { Icon: TriangleAlertIcon, label: "주의", tone: "text-warning", bar: "bg-warning" },
  critical: { Icon: ShieldAlertIcon, label: "위험", tone: "text-destructive", bar: "bg-destructive" },
};

/** Gateway 가 긴 인자를 자를 때 남기는 표시(설계 3.1) */
const TRUNCATED = /\[\+\d+ chars hidden\]/;

/**
 * `approval.resolve` ack 실패 문구(설계 4.4 표·5.3). wire 오류는 REST 전역 토스트 밖이라 부르는 쪽이 토스트한다.
 * `CONFLICT`·`ADAPTER_UNAVAILABLE` 뒤에도 행은 `pending` 으로 남아 다시 누를 수 있다(p2-t5 보고서 1)
 */
export function resolveErrorMessage(e: unknown): string {
  if (!(e instanceof WireAckError)) return "승인을 처리하지 못했습니다";
  switch (e.code) {
    case "CONFLICT":
      return "이미 처리되었거나 만료되었습니다";
    case "VALIDATION":
      return "이 승인이 받지 않는 선택입니다";
    case "FORBIDDEN":
      return "권한이 없습니다";
    case "ADAPTER_UNAVAILABLE":
      return "Gateway 에 연결되지 않았습니다";
    case "NOT_FOUND":
      return "없는 승인입니다";
    case "TIMEOUT":
      return "서버 응답이 없어 승인을 처리하지 못했습니다";
    default:
      return `승인을 처리하지 못했습니다 (${e.code})`;
  }
}

/**
 * 승인 카드(설계 5.3). 자리 둘 — 채널 메시지 흐름(시간 순서)과 활동 탭 맨 위 — 이 같은 스토어를 본다.
 * 미해결이면 남은 시간과 버튼, 확정되면 **사라지지 않고** 결과 한 줄로 바뀐다(기록).
 * 클라이언트 시계로 0 이 되면 「만료됨」으로 보이되 서버 사실이 오면 그쪽이 이긴다(설계 5.5)
 */
export function ApprovalCard({
  approvalId,
  channelId,
}: {
  approvalId: string;
  channelId: string;
}): ReactElement | null {
  const view = useApprovalStore((s) => s.byChannel[channelId]?.[approvalId]);
  const { author } = useAuthors();
  const pending = view?.approval.status === "pending";
  const { label: remaining, expired } = useRemaining(view?.approval.expiresAt ?? "", pending);
  /**
   * 결정을 누르면 버튼 줄이 통째로 사라진다(확정된 카드에는 누를 것이 없다) — 누른 버튼이 언마운트되면서
   * 초점이 `<body>`·시트 루트로 떨어져 키보드·스크린 리더 사용자가 자리를 잃었다(브라우저 검증 D13, D3 와 같은 부류).
   * **같은 카드 안에서 결과를 말하는 자리**(「허용됨」 줄)로 옮긴다 — 결말을 곧바로 듣고 Tab 이 카드 안에서 이어진다.
   * 확정 안내(`선택: …`)는 이미 `aria-live` 라 거기 초점을 주면 같은 말이 두 번 읽힌다 — 그래서 그 줄이 아니다.
   *
   * **이 카드에서 누른 때만** 옮긴다(`acted`): 카드는 메시지 흐름과 활동 탭 두 자리에 서는데 `sending` 은 스토어가
   * 함께 쥐므로, 그것만 보면 안 누른 쪽 카드가 초점을 빼앗아 간다. 카운트다운이 다 된 때도 옮기지 않는다 —
   * 사용자가 한 일이 아닌데 초점을 뺏는 셈이다
   */
  const outcomeRef = useRef<HTMLSpanElement>(null);
  const acted = useRef(false);
  const answerable = pending && !expired;
  useEffect(() => {
    if (answerable || !acted.current) return;
    acted.current = false;
    outcomeRef.current?.focus();
  }, [answerable]);
  if (!view) return null;

  const { approval, sending } = view;
  const { Icon, label: severityLabel, tone, bar } = LOOK[approval.severity];
  const agent = author({ authorType: "agent", authorId: approval.agentId });
  const note = approval.reason && REASON_NOTE[approval.reason];
  const outcome =
    approval.status === "pending" ? undefined : OUTCOME[approval.status] + (note ? ` (${note})` : "");
  const args = approval.detail ?? approval.description;

  return (
    <div className="flex justify-center px-4 py-1.5">
      <div
        data-slot="approval-card"
        data-approval-id={approval.id}
        data-status={approval.status}
        role="group"
        aria-label={`승인 요청 — ${approval.title}`}
        className="relative w-full max-w-[min(100%,40rem)] overflow-hidden rounded-md border bg-background text-sm"
      >
        <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", bar)} />
        <div className="space-y-2 py-2.5 pr-3 pl-4">
          <div className="flex items-start gap-2">
            <Icon
              role="img"
              aria-label={severityLabel}
              aria-hidden={false}
              className={cn("mt-0.5 size-4 shrink-0", tone)}
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium break-words">{approval.title}</p>
              <p className="text-xs text-muted-foreground">
                {agent.handle ? `@${agent.handle}` : agent.name}
                {approval.toolName ? ` · ${approval.toolName}` : ""}
              </p>
            </div>
            {/*
              카운트다운은 1초마다 바뀐다 — 라이브 영역으로 두면 스크린 리더가 매초 읽는다.
              결정 뒤 초점이 오는 자리라 `tabIndex={-1}`(탭 차례에는 안 든다) — 테두리는 `:focus-visible` 에서만
              떠서 마우스로 누른 사람에게는 안 보인다(D13)
            */}
            <span
              ref={outcomeRef}
              tabIndex={-1}
              data-slot="approval-outcome"
              className="shrink-0 rounded-xs pt-0.5 text-xs text-muted-foreground tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {outcome ?? (expired ? EXPIRED_LABEL : remaining && `${remaining} 남음`)}
            </span>
          </div>

          {args && <Arguments args={args} />}

          {answerable && (
            <div className="flex flex-wrap gap-2">
              {DECISIONS.filter((d) => approval.allowedDecisions.includes(d.decision)).map((d) => (
                <DecisionButton
                  key={d.decision}
                  approvalId={approval.id}
                  decision={d.decision}
                  label={d.label}
                  variant={d.variant}
                  sending={sending}
                  onActed={(yes) => {
                    acted.current = yes;
                  }}
                />
              ))}
            </div>
          )}
          {/*
            「누가 무엇을 골랐는가」는 사람이 고른 경로에서만 — 만료의 decision 은 Gateway 가 채운 것이다(Ruling).
            승인은 시간 제한이 있는 요청이다. 확정·만료 안내는 한 번만 바뀌므로 라이브로 둬 스크린 리더가
            카드를 다시 찾아가지 않아도 결말을 듣게 한다(카운트다운 span 은 매초 바뀌어 라이브가 아니다)
          */}
          {(approval.status === "allowed" || approval.status === "denied") && approval.decision && (
            <p aria-live="polite" className="text-xs text-muted-foreground">
              선택: {DECISION_LABEL[approval.decision]}
            </p>
          )}
          {pending && expired && (
            <p aria-live="polite" className="text-xs text-muted-foreground">
              시간이 지나 답할 수 없습니다.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** 툴 인자는 접힘이 기본(설계 5.2·5.3). Gateway 가 자른 표시가 있으면 잘렸다고 알린다 */
function Arguments({ args }: { args: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button variant="ghost" size="xs" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "인자 접기" : "인자 보기"}
      </Button>
      {open && (
        <>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted px-2 py-1.5 text-xs whitespace-pre-wrap">
            {args}
          </pre>
          {TRUNCATED.test(args) && <p className="mt-1 text-xs text-muted-foreground">잘렸습니다.</p>}
        </>
      )}
    </div>
  );
}

/**
 * 누르면 잠그고 ack 을 기다린다(설계 5.3). 성공해도 스스로 풀지 않는다 — 서버가 보낸 확정 사실이
 * 카드를 결과 한 줄로 바꾸며 푼다. 실패하면 코드별 문구를 토스트하고 다시 연다.
 * 소켓이 없거나 wire 가 connected 가 아니면 비활성(버블의 중지 버튼과 같은 규칙)
 */
function DecisionButton({
  approvalId,
  decision,
  label,
  variant,
  sending,
  onActed,
}: {
  approvalId: string;
  decision: ApprovalDecision;
  label: string;
  variant: "default" | "secondary" | "outline";
  sending?: ApprovalDecision;
  /** 이 카드에서 눌렀는가 — 확정이 오면 카드가 초점을 결과 줄로 옮긴다(D13). 실패해 버튼이 다시 열리면 거짓 */
  onActed: (acted: boolean) => void;
}) {
  const { socket } = useWire();
  const connected = useWireStatus((s) => s.status === "connected");

  function resolve() {
    if (!socket || sending) return;
    const { setSending } = useApprovalStore.getState();
    setSending(approvalId, decision);
    onActed(true);
    emitAck(socket, "approval.resolve", { approvalId, decision }).catch((e: unknown) => {
      const message = resolveErrorMessage(e);
      toast.error(message, { id: `approval-resolve:${message}` });
      setSending(approvalId, undefined);
      onActed(false);
    });
  }

  return (
    <Button
      variant={variant}
      size="sm"
      disabled={!socket || !connected || sending !== undefined}
      aria-busy={sending === decision || undefined}
      onClick={resolve}
    >
      {label}
    </Button>
  );
}

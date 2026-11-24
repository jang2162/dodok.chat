import type { Message } from "@dodok/shared";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { runStatusLabel } from "@/features/activity/timeline";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { cn } from "@/lib/utils";
import { IdentityAvatar } from "@/ui/identity-avatar";
import { useBundleExpansion } from "./bundleExpansion";
import type { Bundle, BundleLane } from "./bundles";
import { MessageItem } from "./MessageItem";
import { SystemCard } from "./SystemCard";
import { useAuthors } from "./useAuthors";

export type ReplyBundleProps = {
  bundle: Bundle;
  messagesById: ReadonlyMap<string, Message>;
  /** 지금 보일 스트리밍 버블의 런(`useChannelBubbles`) — 펼친 줄 안에서 그 런의 버블을 그린다 */
  bubbleRunIds?: ReadonlySet<string>;
  bubbles?: (runId: string) => ReactNode;
  /** 줄의 「승인 대기」를 눌렀다 — 목록 맨 아래 그 승인 카드로 간다 */
  onApproval?: (approvalId: string) => void;
  /** 결과로 가기가 도착한 메시지 — 묶음 안이면 그 메시지를 강조한다 */
  highlighted?: string;
};

/**
 * 메시지에 지금 누를 수 있는 components 카드가 있는가 — 만료 전이고, 소비되지 않은 버튼·셀렉트·모달이 하나라도 있다(재사용 카드는
 * 소비를 보지 않는다). 이런 줄은 접혀 있으면 사람이 눌러야 할 것을 놓치므로 펼친 채 그린다(답 묶음 설계)
 */
export function hasLiveCard(m: Message, now: number): boolean {
  const c = m.components;
  if (!c) return false;
  const expiresAt = m.componentState?.expiresAt;
  if (expiresAt !== undefined && Date.parse(expiresAt) <= now) return false;
  const ids = c.blocks.flatMap((b) => (b.type === "actions" ? b.items.map((i) => i.id) : []));
  if (c.modal) ids.push(c.modal.id);
  if (ids.length === 0) return false;
  if (c.reusable) return true;
  const consumed = new Set(m.componentState?.consumed ?? []);
  return ids.some((id) => !consumed.has(id));
}

/** 접힌 줄의 미리보기 — 마크다운 표시를 걷은 첫 줄. 멘션 토큰은 @핸들로 */
function previewOf(bodyMd: string, mention: (kind: "a" | "u", id: string) => string | undefined): string {
  const line = bodyMd.split("\n").find((l) => l.trim() !== "") ?? "";
  return line
    .replace(/<@([au]):([0-9a-f-]+)>/gi, (_, kind: "a" | "u", id: string) => `@${mention(kind, id) ?? "?"}`)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, "")
    .replace(/[*_`~]/g, "")
    .trim();
}

/** 묶음의 이름 — 「@dev·@fin 답」, 셋 이상이면 「@dev 외 2 답」(서로 다른 에이전트 수) */
function groupName(handles: string[]): string {
  const distinct = [...new Set(handles)];
  if (distinct.length <= 2) return `${distinct.map((h) => `@${h}`).join("·")} 답`;
  return `@${distinct[0]} 외 ${distinct.length - 1} 답`;
}

/**
 * 여러 에이전트 답 묶음(답 묶음 설계) — 루트 글 아래 런마다 한 줄. 줄을 누르면 그 자리에서 그 답을 펼친다. 처음엔 접혀 있고, 누를 수
 * 있는 카드가 든 줄만 펼친 채(사람이 손으로 펼치거나 접은 것은 그대로). 도구 승인 카드는 목록 맨 아래 제자리 — 줄에는 「승인 대기」
 * 배지를 두고 누르면 그 카드로 간다. 그 체인의 relay_limit·relay_denied 는 묶음 맨 아래
 */
export function ReplyBundle({
  bundle,
  messagesById,
  bubbleRunIds,
  bubbles,
  onApproval,
  highlighted,
}: ReplyBundleProps) {
  const { author } = useAuthors();
  const handles = bundle.lanes.map((l) => author({ authorType: "agent", authorId: l.agentId }).handle ?? "?");
  const tail = bundle.tailSystemIds.flatMap((id) => messagesById.get(id) ?? []);
  return (
    <div
      role="group"
      aria-label={groupName(handles)}
      data-slot="reply-bundle"
      className="mx-4 my-1 ml-16 flex flex-col overflow-hidden rounded-md border bg-muted/20"
    >
      {bundle.lanes.map((lane) => (
        <Lane
          key={lane.runId}
          lane={lane}
          messagesById={messagesById}
          bubble={bubbleRunIds?.has(lane.runId) ? bubbles?.(lane.runId) : undefined}
          onApproval={onApproval}
          highlighted={highlighted}
        />
      ))}
      {tail.map((m) => (
        <div key={m.id} className="border-t">
          <SystemCard message={m} />
        </div>
      ))}
    </div>
  );
}

function Lane({
  lane,
  messagesById,
  bubble,
  onApproval,
  highlighted,
}: {
  lane: BundleLane;
  messagesById: ReadonlyMap<string, Message>;
  bubble: ReactNode;
  onApproval: ((approvalId: string) => void) | undefined;
  highlighted: string | undefined;
}) {
  const { author, mention } = useAuthors();
  const me = author({ authorType: "agent", authorId: lane.agentId });
  const from = lane.fromAgentId ? author({ authorType: "agent", authorId: lane.fromAgentId }) : undefined;
  const messages = lane.messageIds.flatMap((id) => messagesById.get(id) ?? []);
  const systems = lane.systemIds.flatMap((id) => messagesById.get(id) ?? []);
  const manual = useBundleExpansion((s) => s.open[lane.runId]);
  const setOpen = useBundleExpansion((s) => s.set);
  const auto = messages.some((m) => hasLiveCard(m, Date.now()));
  const open = manual ?? auto;
  const approvalId = useApprovalStore(
    useShallow((s) => {
      for (const channel of Object.values(s.byChannel))
        for (const v of Object.values(channel))
          if (v.approval.runId === lane.runId && v.approval.status === "pending") return v.approval.id;
      return undefined;
    }),
  );
  const running = lane.status !== "done" && lane.status !== "error" && lane.status !== "aborted";
  const first = messages[0];
  const preview = first ? previewOf(first.bodyMd, mention) : "";
  const handle = me.handle ?? "?";
  return (
    <div data-run-id={lane.runId} className="border-b last:border-b-0">
      <div className="flex items-center gap-2 pr-2">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`@${handle} 답 · ${lane.status === "done" ? "완료" : runStatusLabel(lane.status)}${from ? ` · @${from.handle ?? "?"} 이 부름` : ""}`}
          onClick={() => setOpen(lane.runId, !open)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <IdentityAvatar
            kind="agent"
            id={lane.agentId}
            name={me.name}
            handle={me.handle}
            avatarUrl={me.avatarUrl}
            size={24}
            className="size-5 shrink-0"
          />
          <span className="shrink-0 font-medium">@{handle}</span>
          {from && (
            <span className="shrink-0 text-xs text-muted-foreground">
              @{from.handle ?? "?"} → @{handle}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{preview}</span>
          <LaneStatus status={lane.status} running={running} />
        </button>
        {approvalId !== undefined && (
          <button
            type="button"
            aria-label={`@${handle} 승인 대기 — 승인 카드로`}
            onClick={() => onApproval?.(approvalId)}
            className="shrink-0 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-foreground hover:bg-warning/20 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            승인 대기
          </button>
        )}
      </div>
      {open && (
        <LaneBody>
          {messages.map((m, i) => (
            <div
              key={m.id}
              data-message-id={m.id}
              data-highlighted={m.id === highlighted || undefined}
              className={cn(
                "transition-colors duration-700 motion-reduce:transition-none",
                m.id === highlighted && "bg-yellow-100/70 dark:bg-yellow-500/15",
              )}
            >
              <MessageItem message={m} head={false} activity={i === 0} />
            </div>
          ))}
          {bubble}
          {systems.map((m) => (
            <div key={m.id} data-message-id={m.id} data-highlighted={m.id === highlighted || undefined}>
              <SystemCard message={m} />
            </div>
          ))}
        </LaneBody>
      )}
    </div>
  );
}

/** 상태 — 진행 중이면 상태 문구, 끝나면 ✓, 실패 「실패」, 중지 「중지됨」 */
function LaneStatus({ status, running }: { status: BundleLane["status"]; running: boolean }) {
  if (status === "done")
    return (
      <span className="shrink-0 text-success" aria-label="완료">
        <CheckIcon aria-hidden className="size-4" />
      </span>
    );
  return (
    <span
      className={cn(
        "shrink-0 text-xs",
        status === "error" ? "text-destructive" : "text-muted-foreground",
        running && "text-primary",
      )}
    >
      {runStatusLabel(status)}
    </span>
  );
}

/** 펼친 답 — 높이 상한(`max-h-96`)을 넘치면 「전체 보기」로 푼다 */
function LaneBody({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    const win = el?.ownerDocument.defaultView;
    if (!el || !win || full) return;
    const measure = () => setOverflow(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new win.ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [full]);
  return (
    <div className="border-t bg-background">
      <div ref={ref} className={cn("relative py-1", !full && "max-h-96 overflow-hidden")}>
        {children}
      </div>
      {overflow && !full && (
        <button
          type="button"
          onClick={() => setFull(true)}
          className="w-full border-t px-3 py-1 text-xs font-medium text-primary hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          전체 보기
        </button>
      )}
    </div>
  );
}

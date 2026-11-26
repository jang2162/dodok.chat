import type { Message } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { CheckIcon, ChevronRightIcon, MessageSquareReplyIcon } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { runStatusLabel } from "@/features/activity/timeline";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { useNoteThreadOpener, useThreadOpenSearch } from "@/features/threads/threadOpener";
import { cn } from "@/lib/utils";
import { IdentityAvatar } from "@/ui/identity-avatar";
import { useBundleExpansion } from "./bundleExpansion";
import { type Bundle, type BundleLane, laneKey, previewOf } from "./bundles";
import { MessageItem } from "./MessageItem";
import { SystemCard } from "./SystemCard";
import { useAuthors } from "./useAuthors";

export type ReplyBundleProps = {
  bundle: Bundle;
  /**
   * 모든 깊이의 묶음(`computeBundles`) — 펼친 줄 안 글이 하위 묶음 루트면 그 글 아래에 하위 묶음을 그린다. 없으면 하위 묶음을 그리지
   * 않는다
   */
  bundles?: ReadonlyMap<string, Bundle>;
  messagesById: ReadonlyMap<string, Message>;
  /** 지금 보일 스트리밍 버블의 런(`useChannelBubbles`) — 펼친 줄 안에서 그 런의 버블을 그린다 */
  bubbleRunIds?: ReadonlySet<string>;
  bubbles?: (runId: string) => ReactNode;
  /** 줄의 「승인 대기」를 눌렀다 — 목록 맨 아래 그 승인 카드로 간다 */
  onApproval?: (approvalId: string) => void;
  /** 결과로 가기가 도착한 메시지 — 묶음 안이면 그 메시지를 강조한다 */
  highlighted?: string;
  /** 스레드 패널의 묶음 — 펼침 상태를 메인과 따로 두고(`laneKey`) 「스레드에서 보기」를 두지 않는다 */
  inThread?: boolean;
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

/** 끝나지 않은 런인가 — 줄 상태 문구(`runStatusLabel`)를 진행 중으로 보이는 상태 */
const isRunning = (status: BundleLane["status"]): boolean =>
  status !== "done" && status !== "error" && status !== "aborted";

/** 하위 묶음 깊이 상한 — computeBundles 가 순환을 걷어 내지만 깨진 맵에서도 끝나게 */
const MAX_NEST = 32;

/**
 * 줄 안 글이 루트인 하위 묶음들의 줄(재귀, 모든 깊이) — 바깥 줄이 접혀 있으면 그 안의 누를 카드·승인 대기가 화면에 없으므로 바깥 줄의
 * 자동 펼침·「승인 대기」 배지가 이 줄들까지 본다
 */
function lanesUnder(
  bundles: ReadonlyMap<string, Bundle> | undefined,
  lane: BundleLane,
  depth = 0,
): BundleLane[] {
  if (!bundles || depth >= MAX_NEST) return [];
  return lane.messageIds.flatMap((id) =>
    (bundles.get(id)?.lanes ?? []).flatMap((l) => [l, ...lanesUnder(bundles, l, depth + 1)]),
  );
}

/** setTimeout 최대 지연(약 24.8일) — 그보다 먼 만료는 그때 다시 잰다 */
const MAX_TIMER_MS = 2_147_483_647;

/** 묶음의 이름 — 「@dev·@fin 답」, 셋 이상이면 「@dev 외 2 답」(서로 다른 에이전트 수) */
function groupName(handles: string[]): string {
  const distinct = [...new Set(handles)];
  if (distinct.length <= 2) return `${distinct.map((h) => `@${h}`).join("·")} 답`;
  return `@${distinct[0]} 외 ${distinct.length - 1} 답`;
}

/**
 * 여러 에이전트 답 묶음(답 묶음 설계) — 루트 글 아래 런마다 한 줄. 줄을 누르면 그 자리에서 그 답을 펼친다. 처음엔 접혀 있고, 누를 수
 * 있는 카드가 든 줄만 펼친 채(사람이 손으로 펼치거나 접은 것은 그대로). 도구 승인 카드는 목록 맨 아래 제자리 — 줄에는 「승인 대기」
 * 배지를 두고 누르면 그 카드로 간다. 그 체인의 relay_limit·relay_denied 는 묶음 맨 아래.
 * 루트가 스레드 답글이면(`bundle.threadRootId`) 답은 그 스레드에 있다 — 메인에서도 보통 묶음처럼 그 자리에서 펼치고(줄의 내용은 목록이 받은
 * 그 스레드 타임라인), 묶음 맨 아래에 「스레드에서 보기」를 둔다(부른 글 기준 설계 2026-11-26 덧붙임 — 같은 답이 메인과 스레드 양쪽에 보인다).
 * 줄 안 글이 다시 여럿을 불렀으면(`bundle.parent` 가 있는 하위 묶음) 그 줄을 펼쳤을 때 그 글 바로 아래에 같은 컴포넌트로 작게 그린다
 * (부른 글 기준 설계 2026-11-26)
 */
export function ReplyBundle(props: ReplyBundleProps) {
  const { bundle, messagesById, bubbleRunIds, bubbles } = props;
  const { author } = useAuthors();
  const handles = bundle.lanes.map((l) => author({ authorType: "agent", authorId: l.agentId }).handle ?? "?");
  const tail = bundle.tailSystemIds.flatMap((id) => messagesById.get(id) ?? []);
  const root = messagesById.get(bundle.rootId);
  const nested = bundle.parent !== undefined;
  return (
    <div
      role="group"
      aria-label={groupName(handles)}
      data-slot="reply-bundle"
      className={cn(
        "my-1 flex flex-col overflow-hidden rounded-md border bg-muted/20",
        // 하위 묶음은 줄 안 글(머리 없는 MessageItem)의 본문 자리에 맞춘다
        nested ? "mr-2 ml-14" : "mx-4 ml-16",
      )}
    >
      {bundle.lanes.map((lane) => (
        <Lane
          key={lane.runId}
          lane={lane}
          parent={props}
          // 그 런과 이 줄 안 글을 따라온 1명 런의 버블 — 런 id 순
          bubble={[lane.runId, ...lane.followRunIds].map((runId) =>
            bubbleRunIds?.has(runId) ? <Fragment key={runId}>{bubbles?.(runId)}</Fragment> : null,
          )}
        />
      ))}
      {tail.map((m) => (
        <div key={m.id} className="border-t">
          <SystemCard message={m} />
        </div>
      ))}
      {!props.inThread && !nested && bundle.threadRootId !== undefined && root && (
        <ThreadLink
          channelId={root.channelId}
          conversationId={root.conversationId}
          threadRootId={bundle.threadRootId}
        />
      )}
    </div>
  );
}

function Lane({ lane, parent, bubble }: { lane: BundleLane; parent: ReplyBundleProps; bubble: ReactNode }) {
  const { bundles, messagesById, onApproval, highlighted } = parent;
  const { author, mention } = useAuthors();
  const me = author({ authorType: "agent", authorId: lane.agentId });
  const from = lane.fromAgentId ? author({ authorType: "agent", authorId: lane.fromAgentId }) : undefined;
  const messages = lane.messageIds.flatMap((id) => messagesById.get(id) ?? []);
  const systems = lane.systemIds.flatMap((id) => messagesById.get(id) ?? []);
  const key = laneKey(lane.runId, parent.inThread);
  const manual = useBundleExpansion((s) => s.open[key]);
  const setOpen = useBundleExpansion((s) => s.set);
  // 스레드 답글이 루트인 묶음의 줄 안 글은 스레드 글이다 — 메인에서 그려도 스레드 안처럼(칩·「스레드에서 답하기」 없음)
  const threadMessages = parent.inThread === true || parent.bundle.threadRootId !== undefined;
  const under = lanesUnder(bundles, lane);
  const now = Date.now();
  const live = [
    ...messages,
    ...under.flatMap((l) => l.messageIds.flatMap((id) => messagesById.get(id) ?? [])),
  ].filter((m) => hasLiveCard(m, now));
  const auto = live.length > 0;
  const open = manual ?? auto;
  // 자동으로 펼친 줄은 카드가 만료되는 순간 접힌 기본으로 돌아간다 — 그 시각에 한 번 다시 그린다
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const expiry =
    manual === undefined
      ? Math.min(...live.map((m) => Date.parse(m.componentState?.expiresAt ?? "")).filter(Number.isFinite))
      : Number.POSITIVE_INFINITY;
  useEffect(() => {
    if (!Number.isFinite(expiry)) return;
    const timer = setTimeout(redraw, Math.min(Math.max(0, expiry - Date.now()) + 50, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [expiry]);
  // 그 런·따라온 런·하위 묶음 줄(과 그 따라온 런)의 승인 — 접힌 줄 안에 있어도 바깥 줄에서 보인다
  const approvalRuns = new Set([
    lane.runId,
    ...lane.followRunIds,
    ...under.flatMap((l) => [l.runId, ...l.followRunIds]),
  ]);
  const approvalId = useApprovalStore(
    useShallow((s) => {
      for (const channel of Object.values(s.byChannel))
        for (const v of Object.values(channel))
          if (
            v.approval.runId !== undefined &&
            approvalRuns.has(v.approval.runId) &&
            v.approval.status === "pending"
          )
            return v.approval.id;
      return undefined;
    }),
  );
  const running = isRunning(lane.status);
  const first = messages[0];
  const preview = first ? previewOf(first.bodyMd, mention) : "";
  const handle = me.handle ?? "?";
  // 접힌 줄 안 따라온 런 — 버블은 펼친 줄 안에만 있으므로 진행 중(가장 최근 하나), 없으면 실패를 머리에 보인다
  const follow = open
    ? undefined
    : (lane.followRuns.filter((f) => isRunning(f.status)).at(-1) ??
      lane.followRuns.filter((f) => f.status === "error").at(-1));
  const followText =
    follow && !(follow.status === "awaiting_approval" && approvalId !== undefined)
      ? `@${author({ authorType: "agent", authorId: follow.agentId }).handle ?? "?"} ${runStatusLabel(follow.status)}`
      : undefined;
  return (
    <div data-run-id={lane.runId} className="border-b last:border-b-0">
      <div className="flex items-center gap-2 pr-2">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`@${handle} 답 · ${lane.status === "done" ? "완료" : runStatusLabel(lane.status)}${from ? ` · @${from.handle ?? "?"} 이 부름` : ""}${followText ? ` · ${followText}` : ""}`}
          onClick={() => setOpen(key, !open)}
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
          {followText !== undefined && follow && (
            <span
              className={cn(
                "shrink-0 text-xs",
                follow.status === "error" ? "text-destructive" : "text-primary",
              )}
            >
              {followText}
            </span>
          )}
          {/* 승인 배지가 있으면 같은 말(「승인 대기」)을 두 번 쓰지 않는다 */}
          {approvalId === undefined && <LaneStatus status={lane.status} running={running} />}
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
          {messages.map((m, i) => {
            // 이 글이 다시 여럿을 불렀다 — 그 답은 이 글 아래 하위 묶음
            const sub = bundles?.get(m.id);
            return (
              <Fragment key={m.id}>
                <div
                  data-message-id={m.id}
                  data-highlighted={m.id === highlighted || undefined}
                  className={cn(
                    "transition-colors duration-700 motion-reduce:transition-none",
                    m.id === highlighted && "bg-yellow-100/70 dark:bg-yellow-500/15",
                  )}
                >
                  <MessageItem message={m} head={false} inThread={threadMessages} activity={i === 0} />
                </div>
                {sub && <ReplyBundle {...parent} bundle={sub} />}
              </Fragment>
            );
          })}
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

/** 메인의 스레드 답글 묶음 맨 아래 — 그 스레드(마지막으로 쓴 보기)를 연다 */
function ThreadLink({
  channelId,
  conversationId,
  threadRootId,
}: {
  channelId: string;
  conversationId: string;
  threadRootId: string;
}) {
  const noteOpener = useNoteThreadOpener(threadRootId);
  const search = useThreadOpenSearch();
  return (
    <Link
      to="/c/$channelId/s/$conversationId/t/$rootId"
      params={{ channelId, conversationId, rootId: threadRootId }}
      search={search}
      onClick={noteOpener}
      className="flex items-center justify-end gap-1 border-t px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <MessageSquareReplyIcon aria-hidden className="size-3.5" />
      스레드에서 보기
    </Link>
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

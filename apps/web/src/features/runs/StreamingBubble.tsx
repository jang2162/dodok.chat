import { SquareIcon } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MessageBody } from "@/features/messages/MessageBody";
import { MessageErrorBoundary } from "@/features/messages/MessageErrorBoundary";
import { AuthorAvatar, AuthorLine } from "@/features/messages/MessageItem";
import { useAuthors } from "@/features/messages/useAuthors";
import { emitAck, useWireStatus } from "@/realtime/wire";
import { useWire } from "@/realtime/WireProvider";
import { Button } from "@/ui/button";
import { abortErrorMessage } from "./abortError";
import { bubblePhase } from "./bubblePhase";
import { TERMINAL, useRunStore } from "./runStore";

/**
 * 진행 중인 런 하나의 버블(스펙 4.6·7.2): 에이전트 머리 · 에이전트 색 왼쪽 막대 · 누적 텍스트(스트리밍 렌더) · 상태 문구 · 중지.
 * 자기 런만 런 스토어에서 읽는다 — 델타마다 이 버블만 다시 그린다. 보일지는 `useChannelBubbles` 가 정한다.
 * 본문 렌더 예외는 이 안의 경계가 받고 델타(이벤트 seq)나 상태가 바뀌면 다시 그려 본다 — 중지 버튼은 경계 밖이라 남는다
 */
export const StreamingBubble = memo(function StreamingBubble({ runId }: { runId: string }) {
  const view = useRunStore((s) => s.runs[runId]);
  const { author } = useAuthors();
  if (!view) return null;
  const { status } = view.state;
  // 같은 runId 메시지로 숨기는 것은 목록 쪽(useChannelBubbles) 몫 — 여기서는 모양만
  const phase = bubblePhase(view, { hasMessage: false, now: Date.now() });
  if (!phase.visible) return null;
  const agent = author({ authorType: "agent", authorId: view.state.agentId });
  const streaming = status === "streaming";

  return (
    <div data-run-id={runId} className="relative py-0.5">
      <span
        data-agent-bar
        aria-hidden
        className="absolute inset-y-1 left-1.5 w-[3px] rounded-full bg-border"
        style={agent.colorVar ? { backgroundColor: agent.colorVar } : undefined}
      />
      <MessageErrorBoundary resetKey={`${status}:${view.lastEventSeq}`}>
        <article className="flex gap-3 px-4">
          <div className="w-9 shrink-0 pt-1">
            <AuthorAvatar author={agent} />
          </div>
          <div className="min-w-0 flex-1 pt-1">
            {/* 오른쪽 위 중지 버튼 자리 — 머리 줄만 비켜 준다(본문 줄바꿈은 확정 메시지와 같게) */}
            <div className={phase.stoppable ? "pr-20" : undefined}>
              <AuthorLine author={agent}>
                {/* 상태 문구만 라이브 영역이다 — 영역을 먼저 두고 안을 바꾼다. 델타(본문)는 밖이라 읽히지 않는다 */}
                <span role="status">
                  {phase.label && <StatusLabel label={phase.label} queued={status === "queued"} />}
                </span>
              </AuthorLine>
            </div>
            {phase.textVisible && (
              <div data-cursor={streaming || undefined} aria-busy={!TERMINAL.has(status)}>
                {view.text ? (
                  <MessageBody bodyMd={view.text} caret={streaming} streaming />
                ) : (
                  streaming && <Cursor />
                )}
              </div>
            )}
          </div>
        </article>
      </MessageErrorBoundary>
      {phase.stoppable && <StopButton runId={runId} />}
    </div>
  );
});

/** 대기 중이면 점 셋(모션 허용일 때만 움직임) */
function StatusLabel({ label, queued }: { label: string; queued: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      {label}
      {queued && (
        <span aria-hidden className="inline-flex gap-0.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1 rounded-full bg-current motion-safe:animate-pulse"
              style={{ animationDelay: `${i * 200}ms` }}
            />
          ))}
        </span>
      )}
    </span>
  );
}

/** 글이 아직 없을 때의 커서(모션 허용일 때만 깜빡임) */
function Cursor() {
  return (
    <span
      data-cursor
      aria-hidden
      className="inline-block h-4 w-1.5 translate-y-0.5 rounded-[1px] bg-foreground/50 motion-safe:animate-pulse"
    />
  );
}

/**
 * `run.abort`(스펙 4.6). 누른 뒤에는 「중지 중」으로 잠그고, 런이 끝나 버튼이 내려갈 때까지 그대로 둔다.
 * 잠금은 `disabled` 가 아니라 `aria-disabled` + 누름 무시다 — 키보드로 눌렀을 때 초점을 잃지 않게.
 * 런이 끝나 버튼이 내려갈 때 초점이 이 버튼에 있었으면 메시지 목록으로 옮긴다(body 로 떨어지지 않게).
 * ack 실패는 작성기 `/stop` 과 같은 문구로 토스트(wire 오류는 REST 전역 토스트 밖, 스펙 8장)하고 다시 연다.
 * 소켓이 없거나 wire 가 connected 가 아니면 비활성
 */
function StopButton({ runId }: { runId: string }) {
  const { socket } = useWire();
  const connected = useWireStatus((s) => s.status === "connected");
  const [stopping, setStopping] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const button = ref.current;
    return () => {
      if (document.activeElement !== button) return;
      const list = button?.closest("[data-scroller]");
      if (list instanceof HTMLElement) list.focus({ preventScroll: true });
    };
  }, []);

  function stop() {
    if (!socket || stopping) return;
    setStopping(true);
    emitAck(socket, "run.abort", { runId }).catch((e: unknown) => {
      const message = abortErrorMessage(e);
      toast.error(message, { id: `run-abort:${message}` });
      setStopping(false);
    });
  }

  return (
    <div className="absolute top-1.5 right-4">
      <Button
        ref={ref}
        variant="outline"
        size="xs"
        disabled={!socket || !connected}
        aria-disabled={stopping || undefined}
        aria-label={stopping ? "실행 중지 중" : "실행 중지"}
        onClick={stop}
      >
        <SquareIcon aria-hidden />
        {stopping ? "중지 중…" : "중지"}
      </Button>
    </div>
  );
}

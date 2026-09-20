import { type RunView, TERMINAL } from "./runStore";

export type BubblePhase = {
  visible: boolean;
  label: string | null;
  stoppable: boolean;
  textVisible: boolean;
};

/** done 인데 같은 runId 메시지가 아직 없으면 이만큼 기다린다(빈 답이면 그 뒤 내림) */
const DONE_WAIT_MS = 5_000;
/** error·aborted 한 줄 상태를 보이는 시간 */
const END_LABEL_MS = 3_000;
const hidden: BubblePhase = { visible: false, label: null, stoppable: false, textVisible: false };

/**
 * 런 상태 → 버블 모양(스펙 4.6 표). 순수 — 시각은 부르는 쪽이 준다.
 * `hasMessage`: 타임라인에 같은 runId 의 메시지가 있는가(done 이면 곧바로 내린다). 종료 런의 경과는 terminalAt 기준
 */
export function bubblePhase(view: RunView, ctx: { hasMessage: boolean; now: number }): BubblePhase {
  const since = ctx.now - (view.terminalAt ?? ctx.now);
  switch (view.state.status) {
    case "queued":
      return { visible: true, label: "대기 중", stoppable: true, textVisible: false };
    case "streaming":
      return { visible: true, label: null, stoppable: true, textVisible: true };
    case "tool":
      return { visible: true, label: "도구 사용 중", stoppable: true, textVisible: true };
    case "awaiting_approval":
      return { visible: true, label: "승인 대기 중", stoppable: true, textVisible: true };
    case "finalizing":
      return { visible: true, label: null, stoppable: false, textVisible: true };
    case "done":
      return ctx.hasMessage || since >= DONE_WAIT_MS
        ? hidden
        : { visible: true, label: null, stoppable: false, textVisible: true };
    case "error":
      return since >= END_LABEL_MS
        ? hidden
        : {
            visible: true,
            label: `실행 실패: ${view.state.error?.code ?? "?"}`,
            stoppable: false,
            textVisible: false,
          };
    case "aborted":
      return since >= END_LABEL_MS
        ? hidden
        : { visible: true, label: "중지됨", stoppable: false, textVisible: false };
  }
}

/** 종료 런이 시간으로 숨겨지는 시각(정리 타이머용). 진행 중인 런이면 undefined */
export function hiddenAt(view: RunView): number | undefined {
  if (view.terminalAt === undefined) return undefined;
  switch (view.state.status) {
    case "done":
      return view.terminalAt + DONE_WAIT_MS;
    case "error":
    case "aborted":
      return view.terminalAt + END_LABEL_MS;
    default:
      return undefined;
  }
}

export type BubblePlan = {
  /** 보일 버블의 runId(런 순서 그대로) */
  visible: string[];
  /** 숨겨진 종료 런 — 런 스토어에서 지운다(스펙 4.5 「버블을 정리한 뒤 항목 삭제」) */
  stale: string[];
  /** 보이는 종료 런 중 가장 먼저 숨겨질 시각 — 그때 다시 계산한다 */
  nextAt: number | undefined;
};

/**
 * 한 채널의 런들 → 버블 계획. `withMessage` 는 타임라인에 메시지가 있는 runId.
 * 진행 중인 런은 늘 보이고 지우지 않는다(메시지가 있어도 — 에이전트가 런 도중 메시지 툴로 보낸 것일 수 있다)
 */
export function planBubbles(
  views: readonly RunView[],
  withMessage: ReadonlySet<string>,
  now: number,
): BubblePlan {
  const plan: BubblePlan = { visible: [], stale: [], nextAt: undefined };
  for (const view of views) {
    const id = view.state.id;
    if (bubblePhase(view, { hasMessage: withMessage.has(id), now }).visible) {
      plan.visible.push(id);
      const at = hiddenAt(view);
      if (at !== undefined && (plan.nextAt === undefined || at < plan.nextAt)) plan.nextAt = at;
    } else if (TERMINAL.has(view.state.status)) {
      plan.stale.push(id);
    }
  }
  return plan;
}

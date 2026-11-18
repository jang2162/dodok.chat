import type { Agent, ConversationAgentSettings } from "@dodok/shared";
import { type ReactNode, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { agentColorVar } from "@/theme/agentColor";
import { ChevronDownIcon } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/ui/sheet";
import { modelLabelOf } from "./AgentSettingChips";
import { GaugeRing } from "./ContextGauge";

/** 알약이 이보다 많으면 앞의 둘 + 「+N」(세션 설정 스펙 S3 의 접는 기준 — 작성기 도구 줄 스펙 T4) */
export const FOLD_OVER = 3;
const SHOWN_WHEN_FOLDED = 2;
/** 초안이 부르는 에이전트의 알약 접근 이름 꼬리(T6) */
export const MENTIONED_TAIL = " — 이 글에서 부름";
export const HINT_SAVED = "바꾸면 이 세션에 바로 저장됩니다";
export const HINT_NEW = "첫 메시지와 함께 저장됩니다";

export type PillItem = { agent: Agent; row: ConversationAgentSettings; invited: boolean };

const percentText = (percent: number | null) => (percent === null ? "—" : `${percent}%`);

/** 알약·「+N」의 겉 — 멘션이면 강조 테두리(T6) */
const PILL =
  "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-input bg-background px-2 text-xs text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50";
const HIGHLIGHT = "border-primary ring-1 ring-primary";

/**
 * 러너 에이전트 2명 이상의 에이전트 칸(작성기 도구 줄 스펙 T3·T4·T6) — 에이전트마다 알약 `● @핸들 모델 ◔ 31%`, 넷 이상이면 앞의 둘 +
 * 「+N」. 누르면 설정 패널(넓은 화면 팝오버)이 열리고 에이전트마다 한 줄(`renderLine` — 저장·잠금·오류는 그 줄이 한다). 누른 알약의
 * 줄(「+N」이면 첫 줄)의 첫 칩으로 초점이 가고, 닫으면 연 버튼으로 돌아온다. 좁은 화면·스레드 작성기(`compact`)는 알약을 하나로
 * 모으고(`●●● 에이전트 N ◔ 가장 높은 %` — T5), 좁은 화면(`sheet`)이면 패널 대신 아래 시트. 순서는 부르는 쪽이 정한다(`items` 그대로 — 멘션으로 바꾸지
 * 않는다)
 */
export function AgentPills({
  items,
  mentioned,
  compact,
  sheet = false,
  isNew,
  renderLine,
}: {
  items: readonly PillItem[];
  mentioned: ReadonlySet<string>;
  /** 좁은 화면·스레드 작성기 — 알약을 하나로 모은다(T5) */
  compact: boolean;
  /** 좁은 화면 — 패널 대신 아래 시트(T5) */
  sheet?: boolean;
  isNew: boolean;
  renderLine: (item: PillItem) => ReactNode;
}) {
  const [opener, setOpener] = useState<string | null>(null);
  const openerEl = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const open = opener !== null;

  const folded = items.length > FOLD_OVER;
  const shown = folded ? items.slice(0, SHOWN_WHEN_FOLDED) : items;
  const hidden = folded ? items.slice(SHOWN_WHEN_FOLDED) : [];
  const hiddenMentioned = hidden.some((i) => mentioned.has(i.agent.id));
  const anyMentioned = items.some((i) => mentioned.has(i.agent.id));
  const percents = items.flatMap((i) => (i.row.contextPercent === null ? [] : [i.row.contextPercent]));
  const top = percents.length === 0 ? null : Math.max(...percents);

  const openFrom = (key: string, el: HTMLElement) => {
    openerEl.current = el;
    setOpener(key);
  };
  /** 누른 알약의 줄 — 「+N」이면 첫 줄. 그 줄의 첫 버튼(모델 칩)에 초점 */
  const focusLine = () => {
    const target = items.find((i) => i.agent.id === opener) ?? items[0];
    if (!target) return;
    const line = panel.current?.querySelector<HTMLElement>(
      `[data-testid="agent-settings-${CSS.escape(target.agent.handle)}"]`,
    );
    (line?.querySelector<HTMLElement>("button") ?? line)?.focus();
  };

  const pillButtons = compact ? (
    <button
      type="button"
      className={cn(PILL, anyMentioned && HIGHLIGHT)}
      data-testid="agent-pill-summary"
      aria-label={`러너 에이전트 ${items.length} 설정${anyMentioned ? MENTIONED_TAIL : ""}`}
      aria-haspopup="dialog"
      aria-expanded={opener === SUMMARY}
      onClick={(e) => openFrom(SUMMARY, e.currentTarget)}
    >
      <span className="flex shrink-0 -space-x-0.5" aria-hidden>
        {items.slice(0, 3).map((i) => (
          <span
            key={i.agent.id}
            className="size-2 rounded-full ring-1 ring-background"
            style={{ backgroundColor: agentColorVar(i.agent.handle) }}
          />
        ))}
      </span>
      <span className="font-medium whitespace-nowrap">에이전트 {items.length}</span>
      <GaugeRing percent={top} className="size-3.5" />
      <span className="tabular-nums">{percentText(top)}</span>
      <ChevronDownIcon className="size-3 opacity-60" aria-hidden />
    </button>
  ) : (
    <>
      {shown.map((item) => {
        const { agent, row } = item;
        const called = mentioned.has(agent.id);
        const model = modelLabelOf(row, row.models);
        return (
          <button
            key={agent.id}
            type="button"
            className={cn(PILL, called && HIGHLIGHT)}
            data-testid={`agent-pill-${agent.handle}`}
            aria-label={`@${agent.handle} 설정 — 모델 ${model}, 컨텍스트 ${percentText(row.contextPercent)}${called ? MENTIONED_TAIL : ""}`}
            aria-haspopup="dialog"
            aria-expanded={opener === agent.id}
            onClick={(e) => openFrom(agent.id, e.currentTarget)}
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: agentColorVar(agent.handle) }}
              aria-hidden
            />
            <span className="max-w-32 truncate font-medium">@{agent.handle}</span>
            <span className="max-w-24 truncate text-muted-foreground">{model}</span>
            <GaugeRing percent={row.contextPercent} className="size-3.5" />
            <span className="tabular-nums">{percentText(row.contextPercent)}</span>
          </button>
        );
      })}
      {folded && (
        <button
          type="button"
          className={cn(PILL, hiddenMentioned && HIGHLIGHT)}
          data-testid="agent-pill-more"
          aria-label={`에이전트 ${hidden.length}명 더${hiddenMentioned ? MENTIONED_TAIL : ""}`}
          aria-haspopup="dialog"
          aria-expanded={opener === MORE}
          onClick={(e) => openFrom(MORE, e.currentTarget)}
        >
          +{hidden.length}
        </button>
      )}
    </>
  );
  const pillRow = <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{pillButtons}</div>;
  const lines = items.map((item) => <div key={item.agent.id}>{renderLine(item)}</div>);
  const autoFocus = (e: Event) => {
    e.preventDefault();
    focusLine();
  };
  const returnFocus = (e: Event) => {
    e.preventDefault();
    openerEl.current?.focus();
  };

  // 좁은 화면 — 아래에서 올라오는 시트, 줄 높이 44px 이상(T5)
  if (sheet)
    return (
      <>
        {pillRow}
        <Sheet open={open} onOpenChange={(next) => !next && setOpener(null)}>
          <SheetContent
            ref={panel}
            side="bottom"
            className="max-h-[85dvh] gap-3 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-xs"
            onOpenAutoFocus={autoFocus}
            onCloseAutoFocus={returnFocus}
          >
            <div className="flex flex-col gap-0.5 pr-8">
              <SheetTitle className="text-sm font-medium">러너 에이전트 {items.length}</SheetTitle>
              <SheetDescription className="text-xs">{isNew ? HINT_NEW : HINT_SAVED}</SheetDescription>
            </div>
            <div className="flex flex-col text-muted-foreground [&>div]:flex [&>div]:min-h-11 [&>div]:items-center">
              {lines}
            </div>
          </SheetContent>
        </Sheet>
      </>
    );

  return (
    <Popover open={open} onOpenChange={(next) => !next && setOpener(null)}>
      <PopoverAnchor asChild>{pillRow}</PopoverAnchor>
      <PopoverContent
        ref={panel}
        side="top"
        align="start"
        aria-labelledby={titleId}
        className="flex w-auto max-w-[min(40rem,calc(100vw-2rem))] flex-col gap-2 p-3 text-xs"
        onOpenAutoFocus={autoFocus}
        onCloseAutoFocus={returnFocus}
      >
        <PanelBody titleId={titleId} count={items.length} isNew={isNew}>
          {lines}
        </PanelBody>
      </PopoverContent>
    </Popover>
  );
}

const MORE = "+more";
const SUMMARY = "+summary";

function PanelBody({
  titleId,
  count,
  isNew,
  children,
}: {
  titleId: string;
  count: number;
  isNew: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <div className="flex flex-col gap-0.5">
        <h2 id={titleId} className="text-sm font-medium text-foreground">
          러너 에이전트 {count}
        </h2>
        <p className="text-muted-foreground">{isNew ? HINT_NEW : HINT_SAVED}</p>
      </div>
      <div className="flex flex-col gap-1.5 text-muted-foreground">{children}</div>
    </>
  );
}

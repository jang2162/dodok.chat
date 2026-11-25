import type { Agent, ConversationAgentSettings } from "@dodok/shared";
import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { agentColorVar } from "@/theme/agentColor";
import { ChevronDownIcon, SettingsIcon } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/ui/sheet";
import { modelLabelOf } from "./AgentSettingChips";
import { CONTEXT_WARN_PERCENT, GaugeRing } from "./ContextGauge";
import { Input } from "@/ui/input";

/** 이 수 이상이면 설정 패널 위에 검색 칸(핸들·이름) */
export const SEARCH_FROM = 5;
/** 초안이 부르는 에이전트의 알약 접근 이름 꼬리(T6) */
export const MENTIONED_TAIL = " — 이 글에서 부름";
export const HINT_SAVED = "바꾸면 이 세션에 바로 저장됩니다";
export const HINT_NEW = "첫 메시지와 함께 저장됩니다";

export type PillItem = { agent: Agent; row: ConversationAgentSettings; invited: boolean };

/**
 * 설정 패널(팝오버)의 열 — 핸들·모델·노력·권한·컨텍스트(채널 UI·권한 모드 스펙 2장). 줄들이 한 grid 의 칸이라 칩 하나가 길면 그 열이
 * 넓어지고, 패널이 최대폭에 닿으면 앞 넷이 줄어 칸 안에서 줄임표 — 게이지 열은 줄지 않는다. `renderLine` 은 칸 다섯을 내는 `contents`
 * 줄이어야 한다(AgentSettingsBar SettingsLine)
 */
export const PANEL_COLUMNS = "repeat(4, minmax(0, auto)) auto";
/**
 * 시트(좁은 화면)의 열 — 줄지 않는다. 390px 에서 칩 셋이 한 줄에 다 들어가지 않아 줄이면 「모델 기…」처럼 값이 안 보인다(2026-11-24 화면
 * 확인) — 그래서 표만 가로로 스크롤하고 페이지·시트는 넘치지 않는다
 */
export const SHEET_COLUMNS = "repeat(5, auto)";
/** 시트(좁은 화면)의 줄 높이 — 손가락 44px 이상(T5) */
const SHEET_ROWS = "minmax(2.75rem, auto)";

const percentText = (percent: number | null) => (percent === null ? "—" : `${percent}%`);

/** 컨텍스트가 주의 구간(70%) 이상인가 — 도구 줄에 알약으로 남는 까닭 하나(다른 하나는 초안의 멘션) */
export const contextWarn = (row: ConversationAgentSettings): boolean =>
  row.contextPercent !== null && row.contextPercent >= CONTEXT_WARN_PERCENT;

/** 설정 패널의 제목 — 단추 「⚙ 에이전트 N」이 여는 전원 목록 */
export const panelTitle = (count: number) => `에이전트 설정 · 이 세션 ${count}명`;
/** 「⚙ 에이전트 N」 단추의 접근 이름 */
export const settingsLabel = (count: number) => `에이전트 ${count} 설정`;

/** 알약·설정 단추의 겉 — 멘션이면 강조 테두리(T6) */
const PILL =
  "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-input bg-background px-2 text-xs text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50";
const HIGHLIGHT = "border-primary ring-1 ring-primary";

const matches = (item: PillItem, q: string) =>
  q === "" || [item.agent.handle, item.agent.name].some((s) => s.toLowerCase().includes(q));

/**
 * 러너 에이전트 2명 이상의 에이전트 칸(작성기 도구 줄 스펙 T3·T4·T6, UI 시안 01) — 맨 앞에 「⚙ 에이전트 N」 단추를 고정하고, 누르면
 * 설정 패널(넓은 화면 팝오버)을 전원 목록으로 연다(에이전트마다 한 줄 `renderLine` — 저장·잠금·오류는 그 줄이 한다). 5명 이상이면 패널 위에
 * 검색 칸. 도구 줄 알약은 주의가 필요한 것만 — 컨텍스트 70% 이상(`contextWarn`)과 초안이 멘션한 에이전트. 알약을 누르면 그 줄, 단추면
 * 첫 줄의 첫 칩으로 초점이 가고, 닫으면 연 버튼으로 돌아온다. 좁은 화면·스레드 작성기(`compact`)는 알약 없이 같은 단추 하나(가장 높은 %
 * 를 곁들여 — T5), 좁은 화면(`sheet`)이면 패널 대신 아래 시트. 순서는 부르는 쪽이 정한다(`items` 그대로 — 멘션으로 바꾸지 않는다).
 * `subscribe` 를 주면 바깥(참여자 목록의 ⚙)이 그 에이전트 줄에 초점을 두고 패널을 열 수 있다
 */
export function AgentPills({
  items,
  mentioned,
  compact,
  sheet = false,
  isNew,
  renderLine,
  subscribe,
}: {
  items: readonly PillItem[];
  mentioned: ReadonlySet<string>;
  /** 좁은 화면·스레드 작성기 — 알약 없이 설정 단추 하나(T5) */
  compact: boolean;
  /** 좁은 화면 — 패널 대신 아래 시트(T5) */
  sheet?: boolean;
  isNew: boolean;
  renderLine: (item: PillItem) => ReactNode;
  subscribe?: (open: (agentId: string) => void) => () => void;
}) {
  const [opener, setOpener] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const openerEl = useRef<HTMLElement | null>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const open = opener !== null;

  const anyMentioned = items.some((i) => mentioned.has(i.agent.id));
  const percents = items.flatMap((i) => (i.row.contextPercent === null ? [] : [i.row.contextPercent]));
  const top = percents.length === 0 ? null : Math.max(...percents);
  const attention = compact ? [] : items.filter((i) => contextWarn(i.row) || mentioned.has(i.agent.id));

  const openFrom = (key: string, el: HTMLElement | null) => {
    openerEl.current = el;
    setQuery("");
    setOpener(key);
  };
  const openRef = useRef(openFrom);
  openRef.current = openFrom;
  useEffect(() => subscribe?.((agentId) => openRef.current(agentId, settingsButton.current)), [subscribe]);
  const close = () => {
    setOpener(null);
    setQuery("");
  };
  /** 누른 알약의 줄 — 설정 단추면 첫 줄. 그 줄의 첫 버튼(모델 칩)에 초점 */
  const focusLine = () => {
    const target = items.find((i) => i.agent.id === opener) ?? items[0];
    if (!target) return;
    const line = panel.current?.querySelector<HTMLElement>(
      `[data-testid="agent-settings-${CSS.escape(target.agent.handle)}"]`,
    );
    (line?.querySelector<HTMLElement>("button") ?? line)?.focus();
  };

  const settings = (
    <button
      ref={settingsButton}
      type="button"
      className={cn(PILL, compact && anyMentioned && HIGHLIGHT)}
      data-testid="agent-pill-summary"
      aria-label={`${settingsLabel(items.length)}${compact && anyMentioned ? MENTIONED_TAIL : ""}`}
      aria-haspopup="dialog"
      aria-expanded={opener === SUMMARY}
      onClick={(e) => openFrom(SUMMARY, e.currentTarget)}
    >
      <SettingsIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
      <span className="font-medium whitespace-nowrap">에이전트 {items.length}</span>
      {compact && (
        <>
          <GaugeRing percent={top} className="size-3.5" />
          <span className="tabular-nums">{percentText(top)}</span>
        </>
      )}
      <ChevronDownIcon className="size-3 opacity-60" aria-hidden />
    </button>
  );
  const pills = attention.map((item) => {
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
  });
  const pillRow = (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {settings}
      {pills}
    </div>
  );
  const q = query.trim().toLowerCase();
  const shown = items.filter((i) => matches(i, q));
  const lines = shown.map((item) => <Fragment key={item.agent.id}>{renderLine(item)}</Fragment>);
  const search = items.length >= SEARCH_FROM && (
    <Input
      type="search"
      aria-label="에이전트 찾기"
      placeholder="핸들·이름 찾기"
      value={query}
      onChange={(e) => setQuery(e.currentTarget.value)}
      className="h-8 text-xs md:text-xs"
    />
  );
  const empty = shown.length === 0 && <p className="text-muted-foreground">맞는 에이전트가 없습니다</p>;
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
        <Sheet open={open} onOpenChange={(next) => !next && close()}>
          <SheetContent
            ref={panel}
            side="bottom"
            className="max-h-[85dvh] gap-3 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-xs"
            onOpenAutoFocus={autoFocus}
            onCloseAutoFocus={returnFocus}
          >
            <div className="flex flex-col gap-0.5 pr-8">
              <SheetTitle className="text-sm font-medium">{panelTitle(items.length)}</SheetTitle>
              <SheetDescription className="text-xs">{isNew ? HINT_NEW : HINT_SAVED}</SheetDescription>
            </div>
            {search}
            {empty}
            <div className="-mx-4 overflow-x-auto px-4" data-testid="agent-panel-scroll">
              <div
                className="grid w-max min-w-full items-center gap-x-1.5 text-muted-foreground"
                style={{ gridTemplateColumns: SHEET_COLUMNS, gridAutoRows: SHEET_ROWS }}
                data-testid="agent-panel-grid"
              >
                {lines}
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </>
    );

  return (
    <Popover open={open} onOpenChange={(next) => !next && close()}>
      <PopoverAnchor asChild>{pillRow}</PopoverAnchor>
      <PopoverContent
        ref={panel}
        side="top"
        align="start"
        aria-labelledby={titleId}
        className="flex max-h-[min(32rem,70dvh)] w-auto max-w-[min(40rem,calc(100vw-2rem))] flex-col gap-2 overflow-y-auto p-3 text-xs"
        onOpenAutoFocus={autoFocus}
        onCloseAutoFocus={returnFocus}
      >
        <div className="flex flex-col gap-0.5">
          <h2 id={titleId} className="text-sm font-medium text-foreground">
            {panelTitle(items.length)}
          </h2>
          <p className="text-muted-foreground">{isNew ? HINT_NEW : HINT_SAVED}</p>
        </div>
        {search}
        {empty}
        <div
          className="grid items-center gap-x-1.5 gap-y-1.5 text-muted-foreground"
          style={{ gridTemplateColumns: PANEL_COLUMNS }}
          data-testid="agent-panel-grid"
        >
          {lines}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const SUMMARY = "+summary";

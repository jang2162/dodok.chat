import { Fragment, type ReactNode, useEffect, useRef } from "react";
import { StatusChip } from "./DetailCard";
import { useConnections } from "./context";
import type { StateTone } from "./tree";

/**
 * 상세 화면(Gateway·러너·프로젝트·에이전트)과 연결 추가의 머리(연결 재설계 스펙 목표 2) — 종류 아이콘 · 제목(h1) · 상태 칩 한 줄,
 * 그 아래 핵심 값 줄(판·주인·주소·루트 — 가운뎃점으로 잇는다). 오른쪽에 자주 쓰는 동작 하나(`primary`)와 「⋯」 메뉴(`menu`).
 * 좁은 화면의 「← 연결」은 설정 셸의 머리가 「← 설정」 자리에 단다(뒤로 가기 단추가 둘이 되지 않게 — SettingsLayout `BackLink`).
 * 트리 줄을 눌러 왔으면 제목이 초점을 받는다 — 좁은 화면에서 트리가 사라져 초점이 body 로 떨어지지 않게
 */
export function DetailHeader({
  icon,
  leading,
  title,
  state,
  facts,
  primary,
  menu,
  children,
  headingRef,
  badge,
  actions,
  meta,
}: {
  icon?: ReactNode;
  /** 머리 왼쪽 큰 칸(에이전트의 큰 아바타) — 주면 제목·값 줄·덧붙인 줄이 그 오른쪽에 쌓인다 */
  leading?: ReactNode;
  title: string;
  state?: { tone: StateTone; label: string };
  facts?: ReactNode[];
  primary?: ReactNode;
  menu?: ReactNode;
  /** 머리 아래 덧붙이는 줄(아바타 옆 칩 줄 등) */
  children?: ReactNode;
  headingRef?: React.RefObject<HTMLHeadingElement | null>;
  /** 옛 꼴(프로젝트 상세·연결 추가) — 제목 옆 배지, 오른쪽 동작들, 아래 한 줄 메타 */
  badge?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  const { focusDetail } = useConnections();
  const own = useRef<HTMLHeadingElement>(null);
  const heading = headingRef ?? own;
  useEffect(() => {
    if (!focusDetail.current) return;
    focusDetail.current = false;
    heading.current?.focus();
  }, [focusDetail, heading, title]);
  const shown = (facts ?? []).filter((f) => f !== null && f !== undefined && f !== false && f !== "");
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {icon && (
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground [&_svg]:size-4"
          >
            {icon}
          </span>
        )}
        <h1 ref={heading} tabIndex={-1} className="min-w-0 text-xl font-semibold break-all outline-none">
          {title}
        </h1>
        {state && <StatusChip tone={state.tone} label={state.label} />}
        {badge}
        {(primary || menu || actions) && (
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {actions}
            {primary}
            {menu}
          </div>
        )}
      </div>
      {shown.length > 0 && (
        <p className="text-sm break-words text-muted-foreground">
          {shown.map((fact, i) => (
            <Fragment key={i}>
              {i > 0 && " · "}
              {fact}
            </Fragment>
          ))}
        </p>
      )}
      {meta && <div className="text-sm text-muted-foreground">{meta}</div>}
      {children}
    </>
  );
  if (!leading) return <header className="flex flex-col gap-1.5">{body}</header>;
  return (
    <header className="flex items-start gap-4">
      <div className="shrink-0">{leading}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{body}</div>
    </header>
  );
}

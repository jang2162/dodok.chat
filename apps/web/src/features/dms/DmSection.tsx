import type { DmSummary } from "@dodok/shared";
import { useRouterState } from "@tanstack/react-router";
import { DmAgentAvatar, DirectRow, DmRowLink } from "@/features/directs/DirectRow";
import { NewMessageDialog } from "@/features/directs/NewMessageDialog";
import {
  dmEntryChannelId,
  dmEntryLastMessageAt,
  mergeDmEntries,
  useDirects,
} from "@/features/directs/queries";
import { directTitle } from "@/features/directs/queries";
import { sectionedIds } from "@/features/sidebar/layout";
import { ItemsContext, useBaseZone } from "@/features/sidebar/dnd";
import { SidebarRow } from "@/features/sidebar/MoveToSectionMenu";
import { useSidebarLayout } from "@/features/sidebar/queries";
import { Button } from "@/ui/button";
import { useDms } from "./queries";

export { DmAgentAvatar };

/** 지금 보고 있는 채널(`/c/<id>` 와 그 아래) — 사이드바는 채널 라우트 밖이라 주소 모양으로 본다(app/router `channelIdOf` 와 같은 꼴) */
const useCurrentChannelId = () =>
  useRouterState({ select: (s) => /^\/c\/([^/]+)/.exec(s.location.pathname)?.[1] });

/**
 * 사이드바 「다이렉트 메시지」 절(에이전트 DM 스펙 3.1·사람 간 DM 스펙 결정 9). 에이전트 DM(`GET /dms`)과 사람 DM·그룹 DM(`GET /directs`)을
 * 한 목록에 섞어 최근 활동순(마지막 글 시각, 없으면 연 시각 — `mergeDmEntries`. 새 글은 realtime 이 시각을 올린다)으로 그린다. 글이 있는 것과
 * 지금 연 것만 보인다 — 두 목록은 글 없는 것도 준다(에이전트 DM 계획 판정 PD1: 열 때 만든 빈 대화가 사이드바를 채우지 않게).
 * 굵게·배지는 채널 줄과 같은 읽지 않음 값(`useChannelUnread`)을 그대로 쓴다 — DM 의 글을 「나를 멘션한 글」로 세는 것은 서버다(PD10·PH14).
 * 「+」 는 「새 메시지」 대화상자다. 한 목록이라도 못 받았으면 받은 것은 그리고 아래에 「다시 시도」 한 줄. `onNavigate` 는 이동할 때마다
 * (좁은 화면 시트 닫기). 개인 섹션에 든 것은 여기서 빠진다(사이드바 섹션 스펙 B3)
 */
export function DmSection({ onNavigate }: { onNavigate?: () => void }) {
  const dms = useDms();
  const directs = useDirects();
  const current = useCurrentChannelId();
  const layout = useSidebarLayout().data;
  const sectioned = layout ? sectionedIds(layout) : new Set<string>();
  const shown = mergeDmEntries(dms.data, directs.data).filter(
    (e) =>
      !sectioned.has(dmEntryChannelId(e)) &&
      (dmEntryLastMessageAt(e) !== null || dmEntryChannelId(e) === current),
  );
  const failed = [dms, directs].filter((q) => q.isError && !q.data);
  // 머리 — 섹션의 항목을 여기에 놓으면 섹션에서 빠진다
  const zone = useBaseZone("다이렉트 메시지");
  return (
    <nav aria-label="다이렉트 메시지" className="flex flex-col gap-1">
      <div
        ref={zone.ref}
        {...zone.props}
        className="flex items-center justify-between gap-2 rounded-md pt-2 pr-1 pl-2 data-over:bg-sidebar-accent data-over:ring-1 data-over:ring-sidebar-ring"
      >
        <p className="text-xs font-medium text-muted-foreground">다이렉트 메시지</p>
        <NewMessageDialog onNavigate={onNavigate} />
      </div>
      {shown.length > 0 && (
        <ItemsContext ids={shown.map(dmEntryChannelId)} sectionId={null}>
          <ul className="flex flex-col gap-0.5">
            {shown.map((e) => (
              <li key={dmEntryChannelId(e)}>
                <SidebarRow
                  itemId={dmEntryChannelId(e)}
                  label={e.kind === "dm" ? e.dm.agent.name : directTitle(e.direct)}
                  container={null}
                >
                  {e.kind === "dm" ? (
                    <DmLink dm={e.dm} onNavigate={onNavigate} />
                  ) : (
                    <DirectRow direct={e.direct} onNavigate={onNavigate} />
                  )}
                </SidebarRow>
              </li>
            ))}
          </ul>
        </ItemsContext>
      )}
      {failed.length > 0 && (
        <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground">
          <span>DM 목록을 불러오지 못했습니다</span>
          <Button
            variant="ghost"
            size="xs"
            disabled={failed.some((q) => q.isFetching)}
            onClick={() => {
              for (const q of failed) void q.refetch();
            }}
          >
            다시 시도
          </Button>
        </div>
      )}
    </nav>
  );
}

/** 에이전트 DM 한 줄 — 에이전트 아바타·이름. 개인 섹션도 이 줄을 그대로 쓴다 */
export function DmLink({ dm, onNavigate }: { dm: DmSummary; onNavigate?: () => void }) {
  return (
    <DmRowLink
      channelId={dm.channel.id}
      avatar={<DmAgentAvatar agent={dm.agent} />}
      label={dm.agent.name}
      onNavigate={onNavigate}
    />
  );
}

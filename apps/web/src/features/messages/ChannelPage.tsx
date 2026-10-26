import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, NetworkError } from "@/api/http";
import { useChannel } from "@/api/queries";
import { ChannelHeader } from "@/app/layout/ChannelHeader";
import { PanelTabs, usePanelTab } from "@/app/layout/PanelTabs";
import { ArchivedNotice } from "@/features/channels/ArchivedNotice";
import { ChannelArchivedContext, isChannelArchived } from "@/features/channels/archived";
import { Composer } from "@/features/composer/Composer";
import { TypingIndicator } from "@/features/composer/TypingIndicator";
import { useSendMessage } from "@/features/composer/useSendMessage";
import { CannotCreateNotice, ClosedNotice } from "@/features/conversations/ClosedNotice";
import { ConversationClosedContext } from "@/features/conversations/closed";
import { ConversationList } from "@/features/conversations/ConversationList";
import { useConversationPermissions } from "@/features/conversations/permissions";
import { useConversation, useSessionChannelGuard } from "@/features/conversations/queries";
import { type DmView, DmViewContext } from "@/features/dms/context";
import { DmHeader } from "@/features/dms/DmHeader";
import { DM_FIRST_NOTICE, DmReadOnlyNotice } from "@/features/dms/DmNotices";
import { isDmChannel, useDm } from "@/features/dms/queries";
import { captureEntryRead } from "@/features/reads/entryRead";
import { StreamingBubble } from "@/features/runs/StreamingBubble";
import { useChannelBubbles } from "@/features/runs/useChannelBubbles";
import { type ThreadOpener, ThreadOpenerContext } from "@/features/threads/threadOpener";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { touchRecentChannel, touchRecentConversation } from "@/pwa/persist";
import { useChannelSubscription } from "@/realtime/WireProvider";
import { Button } from "@/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { ChannelLoading, ChannelUnavailable } from "./ChannelStatus";
import { MessageList } from "./MessageList";
import { type PendingActions, PendingActionsContext } from "./pendingActions";
import { NEW_CONVERSATION } from "./timeline";
import { useTimelineState } from "./useTimeline";

/**
 * 세션 화면(`/c/<채널>/s/<대화>` — 채널 세션 계획 판정 PS6): 헤더 · 세션 목록(넓은 화면은 왼쪽 접히는 칸, 좁은 화면은 시트) · 그 세션의
 * 메시지 목록(루트만) · 작성기 · 오른쪽 패널(`PanelTabs` 틀 + 탭 내용 `<Outlet/>` — 설정·활동·스레드). 채널 머리·설정·활동 패널은 채널 단위
 * 그대로다. 새 세션 창(`NEW_CONVERSATION`)은 빈 목록에 작성기만 — 첫 보내기가 세션을 만든다(만들 수 없는 사람에게는 안내).
 * 닫힌 세션은 작성기 자리에 안내(`ClosedNotice`)를 두고, 그 아래(카드·스레드 패널)에는 `ConversationClosedContext` 로 알린다. 안내를 그리는
 * 동안에도 작성기는 숨긴 채 남겨 둔다 — 세션마다 든 초안이 이 인스턴스에 있다(닫힌 세션을 둘러보고 돌아와도 다른 세션의 초안이 그대로).
 * 채널이 확인되기 전(목록의 자리값 포함)에는 그 안을 그리지 않는다 — 없는 채널에서 멤버·메시지 조회가 나가
 * 전역 토스트가 화면 안 문구와 겹치지 않게. 불러오지 못하면(없는 채널·없는 세션 등) 화면 안에 알린다(`useChannel` 은 silent).
 * DM 채널(`kind === "dm"`)이면 같은 자리를 DM 꼴로 그린다(에이전트 DM 계획 판정 PD2) — 머리는 `DmHeader`, 오른쪽 패널은 활동 탭만(설정·스레드
 * 없음), 작성기 자리는 읽기 전용 사유가 있으면 그 줄, 세션 목록은 날짜 묶음, 빈 DM 은 첫 안내. 아래(메시지·카드·작성기·활동)는
 * `DmViewContext` 로 안다
 */
export function ChannelPage() {
  // 라우트 id 문자열에 기대지 않는다(레이아웃 id 가 바뀌어도 안전)
  const { channelId, conversationId, rootId } = useParams({ strict: false }) as {
    channelId: string;
    conversationId: string;
    rootId?: string;
  };
  // 오른쪽 패널의 탭 머리는 여기서 그린다 — 탭을 옮겨도 머리의 링크가 죽지 않아야 초점이 살아남는다(D3)
  const routeTab = usePanelTab();
  // 좁은 화면에서 패널은 시트로 뜬다 — 닫히면 초점을 연 자리(헤더의 설정 링크)로 돌려준다(D14)
  const settingsRef = useRef<HTMLAnchorElement>(null);
  // 칩·「스레드에서 답하기」로 연 스레드는 닫으면 그 자리로 초점을 돌려준다(p4t-c1, m5)
  const threadOpenerRef = useRef<ThreadOpener>(null);
  // 구분선의 기준을 세션에 들어갈 때 한 번 잡는다(`captureEntryRead` — 읽음 위치는 세션마다 따로). 채널·세션을 옮겨도 이 페이지는
  // 다시 마운트되지 않는다 — 그래서 첫 값만 잡지 않고 세션이 바뀌면 렌더 중에 다시 잡는다(같은 채널 안에서 옮겨도)
  const [entry, setEntry] = useState(() => ({ conversationId, seq: captureEntryRead(conversationId) }));
  if (entry.conversationId !== conversationId)
    setEntry({ conversationId, seq: captureEntryRead(conversationId) });
  const entryReadSeq = entry.conversationId === conversationId ? entry.seq : undefined;
  useChannelSubscription(channelId);
  const channel = useChannel(channelId);
  const dmChannel = isDmChannel(channel.data) ? channel.data : undefined;
  // DM 의 읽기 전용 사유·첫 안내는 DM 목록에서(채널이 아니면 부르지 않는다)
  const dm = useDm(channelId, dmChannel !== undefined);
  const readOnly = dm?.readOnlyReason ?? null;
  const dmView = useMemo<DmView | null>(
    () => (dmChannel ? { channel: dmChannel, readOnly } : null),
    [dmChannel, readOnly],
  );
  // DM 에는 채널 설정·스레드가 없다(계획 판정 PD2·스펙 결정 7) — 그 주소로 와도 패널을 그리지 않는다. 활동 탭만 연다
  const tab = dmChannel && routeTab !== "activity" ? undefined : routeTab;
  // 좁은 화면에서 패널 시트는 타임라인을 통째로 덮는다 — 덮인 채널 목록은 끝이 보이는 것이 아니다(읽음을 보내지 않는다)
  const covered = useIsNarrow() && tab !== undefined;
  // 읽기 전용 사유 줄이 초점을 받는 것은 이 화면에서 쓸 수 있던 DM 이 읽기 전용이 됐을 때만(`DmReadOnlyNotice` 의 focusOnMount)
  const [seenWritable, setSeenWritable] = useState<string>();
  if (dm && readOnly === null && seenWritable !== channelId) setSeenWritable(channelId);
  const session = useTimelineState(channelId, conversationId);
  const known = channel.data !== undefined;
  // 주소의 채널과 세션의 채널이 다르면 그 세션의 채널로 바꿔 간다(태스크 5 리뷰 L1) — 확인되기 전에는 최근 본 세션으로 남기지 않는다.
  // 세션은 채널과 함께 받는다(닫힘을 카드·작성기가 곧바로 알게) — 아래 자리는 다시 받지 않고 읽는다(`useConversationView`)
  const conversation = useConversation(conversationId);
  const belongs = useSessionChannelGuard(channelId, conversationId, conversation.data);
  const closed = conversation.data !== undefined && conversation.data.closedAt !== undefined;
  // 멤버는 채널이 확인된 뒤에 부른다 — 위 주석의 까닭에 더해, 먼저 받아 두면 확인 뒤 마운트되는 머리·목록·작성기의 관찰자가 낡은
  // 값(staleTime 0)을 한 번 더 받는다(태스크 6 리뷰 L1)
  const { canCreate } = useConversationPermissions(channelId, { enabled: known });
  const cannotCreate = conversationId === NEW_CONVERSATION && canCreate === false;
  // 닫힌 안내가 초점을 받는 것은 이 화면에서 열린 채 보던 세션이 닫혔을 때만(`ClosedNotice` 의 focusOnMount)
  const [seenOpen, setSeenOpen] = useState<string>();
  if (conversation.data && !closed && seenOpen !== conversationId) setSeenOpen(conversationId);
  // 세션 목록 — 넓은 화면은 칸(처음엔 펼침), 좁은 화면은 시트(처음엔 닫힘). 닫으면 초점을 헤더의 「세션 목록」으로 돌려준다
  const narrow = useIsNarrow();
  const [listWide, setListWide] = useState(true);
  const [listSheet, setListSheet] = useState(false);
  const listRef = useRef<HTMLButtonElement>(null);
  const toggleList = useCallback(() => (narrow ? setListSheet((v) => !v) : setListWide((v) => !v)), [narrow]);
  const composerSlot = useRef<HTMLDivElement>(null);
  const focusComposer = useCallback(() => {
    requestAnimationFrame(() =>
      composerSlot.current?.querySelector<HTMLElement>('[role="textbox"]')?.focus(),
    );
  }, []);
  // 읽기 전용 DM 이 다시 쓸 수 있게 되면(되살리기·켜기·허용) 사유 줄이 사라진다 — 그 줄에 있던 초점이 body 로 떨어졌으면 돌아온 작성기로.
  // 다른 곳에 초점이 있으면 뺏지 않는다(`DmReadOnlyNotice` 의 focusOnMount 와 짝)
  const prevReadOnly = useRef(readOnly);
  useEffect(() => {
    const was = prevReadOnly.current;
    prevReadOnly.current = readOnly;
    const active = document.activeElement;
    if (was !== null && readOnly === null && (active === null || active === document.body)) focusComposer();
  }, [readOnly, focusComposer]);
  // 확인된 채널만 최근 본 채널로(오프라인 사본 대상, 스펙 4장) — 없는 채널 주소가 실제 채널을 밀어내지 않게.
  // 세션은 받은 것만 그 채널의 마지막으로 본 세션으로(사본이 채널마다 그 세션 하나만 담는다) — 새 세션 창은 남길 것이 없다
  const qc = useQueryClient();
  const sessionKnown = conversationId !== NEW_CONVERSATION && session.timeline !== undefined;
  useEffect(() => {
    if (known) touchRecentChannel(qc, channelId);
  }, [known, qc, channelId]);
  useEffect(() => {
    if (known && sessionKnown && belongs) touchRecentConversation(qc, channelId, conversationId);
  }, [known, sessionKnown, belongs, qc, channelId, conversationId]);
  const bubbleRunIds = useChannelBubbles(channelId, conversationId);
  const { retry, discard } = useSendMessage(channelId, conversationId);
  // 보내는 중 항목의 「다시 보내기」·「삭제」(태스크 7 PendingItem 이 읽는다). 실패는 항목 상태(failed)로 보인다
  const pendingActions = useMemo<PendingActions>(
    () => ({ retry: (id) => void retry(id).catch(() => undefined), discard }),
    [retry, discard],
  );

  if (!channel.data) {
    return (
      <div data-testid="page-channel" className="flex min-h-0 flex-1 flex-col">
        {channel.isError ? (
          <ChannelUnavailable
            error={channel.error}
            retrying={channel.isFetching}
            onRetry={() => void channel.refetch()}
          />
        ) : (
          <ChannelLoading />
        )}
      </div>
    );
  }
  // 보관한 채널은 읽기만(채널 보관 스펙 「웹」 절) — 작성기 자리에 안내, 카드·스레드 패널·설정 패널은 컨텍스트로 안다.
  // 다른 탭이 보관하면 wire `channel.updated` 가 이 채널 캐시를 바꿔 같은 화면이 그대로 읽기 전용이 된다.
  // 닫힘도 같다 — 다른 탭·다른 사람이 닫으면 wire `conversation.updated` 가 세션 캐시를 바꾼다(Review Focus 2)
  const archived = isChannelArchived(channel.data);
  // 세션이 없다(주소가 틀렸다·다른 워크스페이스) — 목록·작성기 대신 안내. 그 밖의 실패는 「다시 시도」
  const sessionError = session.timeline === undefined ? session.error : null;
  const list = (onPick?: () => void) => (
    <ConversationList
      channelId={channelId}
      conversationId={conversationId}
      onPick={onPick}
      inSheet={onPick !== undefined}
      byDate={dmChannel !== undefined}
    />
  );
  // 작성기 자리의 안내 — 보관 → DM 읽기 전용 → 닫힘 → 만들 수 없음 순. 안내가 있으면 작성기는 숨긴다(초안을 잃지 않게 — 위 주석)
  const notice = archived ? (
    <ArchivedNotice channelId={channelId} unarchive />
  ) : dmChannel && readOnly !== null ? (
    <DmReadOnlyNotice key={channelId} reason={readOnly} focusOnMount={seenWritable === channelId} />
  ) : closed && conversation.data ? (
    <ClosedNotice
      key={conversationId}
      channelId={channelId}
      conversation={conversation.data}
      reopen
      focusOnMount={seenOpen === conversationId}
      onReopened={focusComposer}
    />
  ) : cannotCreate ? (
    <CannotCreateNotice />
  ) : undefined;
  return (
    <div data-testid="page-channel" data-kind={dmChannel ? "dm" : undefined} className="flex min-h-0 flex-1">
      <DmViewContext.Provider value={dmView}>
        <ChannelArchivedContext.Provider value={archived}>
          <ConversationClosedContext.Provider value={closed}>
            <PendingActionsContext.Provider value={pendingActions}>
              <ThreadOpenerContext.Provider value={threadOpenerRef}>
                <section className="flex min-w-0 flex-1 flex-col">
                  {dmChannel ? (
                    <DmHeader
                      channel={dmChannel}
                      conversationId={conversationId}
                      activityRef={settingsRef}
                      listOpen={narrow ? listSheet : listWide}
                      onToggleList={toggleList}
                      listRef={listRef}
                    />
                  ) : (
                    <ChannelHeader
                      channelId={channelId}
                      conversationId={conversationId}
                      settingsRef={settingsRef}
                      listOpen={narrow ? listSheet : listWide}
                      onToggleList={toggleList}
                      listRef={listRef}
                    />
                  )}
                  <div className="flex min-h-0 flex-1">
                    {!narrow && listWide && (
                      <div data-testid="conversation-pane" className="flex w-60 shrink-0 flex-col border-r">
                        {list()}
                      </div>
                    )}
                    <div className="flex min-w-0 flex-1 flex-col">
                      {sessionError ? (
                        <ConversationUnavailable
                          channelId={channelId}
                          error={sessionError}
                          onRetry={session.refetch}
                        />
                      ) : (
                        <>
                          <MessageList
                            channelId={channelId}
                            conversationId={conversationId}
                            covered={covered || (narrow && listSheet)}
                            entryReadSeq={entryReadSeq}
                            bubbleRunIds={bubbleRunIds}
                            bubbles={(runId) => <StreamingBubble runId={runId} />}
                            {...(dmChannel
                              ? {
                                  // 빈 DM(세션이 하나도 없다 — 빈 세션은 만들지 않으니 글이 없다)은 첫 안내, 그 밖의 빈 창은 멘션을 권하지 않는다
                                  emptyText:
                                    dm?.lastMessageAt === null ? DM_FIRST_NOTICE : "아직 메시지가 없습니다.",
                                }
                              : {})}
                          />
                          <div data-slot="composer" ref={composerSlot}>
                            {notice}
                            <div hidden={notice !== undefined}>
                              <TypingIndicator conversationId={conversationId} />
                              <Composer channelId={channelId} conversationId={conversationId} />
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </section>
              </ThreadOpenerContext.Provider>
            </PendingActionsContext.Provider>
            {narrow && (
              <Sheet open={listSheet} onOpenChange={setListSheet}>
                <SheetContent
                  side="left"
                  aria-describedby={undefined}
                  className="w-80 gap-0 p-0"
                  onCloseAutoFocus={(e) => {
                    // 트리거 없이 연 시트라 Radix 가 돌려줄 곳을 모른다 — 헤더의 「세션 목록」으로(패널 시트와 같은 수법, D14)
                    if (!listRef.current?.isConnected) return;
                    e.preventDefault();
                    listRef.current.focus();
                  }}
                >
                  <SheetTitle className="sr-only">세션 목록</SheetTitle>
                  {list(() => setListSheet(false))}
                </SheetContent>
              </Sheet>
            )}
            {tab && (
              <PanelTabs
                channelId={channelId}
                conversationId={conversationId}
                rootId={tab === "thread" ? rootId : undefined}
                active={tab}
                openerRef={settingsRef}
                threadOpenerRef={threadOpenerRef}
                only={dmChannel ? ["activity"] : undefined}
              >
                <Outlet />
              </PanelTabs>
            )}
          </ConversationClosedContext.Provider>
        </ChannelArchivedContext.Provider>
      </DmViewContext.Provider>
    </div>
  );
}

/** 세션을 받지 못했다 — 없는 세션(404·주소의 id 가 UUID 가 아님)이면 「찾을 수 없음」과 채널로 가는 길, 그 밖은 원인과 「다시 시도」 */
function ConversationUnavailable({
  channelId,
  error,
  onRetry,
}: {
  channelId: string;
  error: Error;
  onRetry: () => void;
}) {
  const notFound = error instanceof ApiRequestError && (error.status === 404 || error.code === "VALIDATION");
  const cause = error instanceof NetworkError || error instanceof ApiRequestError ? error.message : undefined;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      {notFound ? (
        <>
          <h2 className="text-lg font-semibold">세션을 찾을 수 없습니다</h2>
          <p className="text-sm text-muted-foreground">삭제되었거나 주소가 잘못되었습니다.</p>
          <Button asChild variant="outline" size="sm">
            <Link to="/c/$channelId" params={{ channelId }}>
              채널로 돌아가기
            </Link>
          </Button>
        </>
      ) : (
        <>
          <h2 className="text-lg font-semibold">세션을 불러오지 못했습니다</h2>
          {cause && <p className="text-sm text-muted-foreground">{cause}</p>}
          <Button variant="outline" size="sm" onClick={onRetry}>
            다시 시도
          </Button>
        </>
      )}
    </div>
  );
}

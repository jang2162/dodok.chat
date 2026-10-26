import type { Agent, Channel } from "@dodok/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { ActivityIcon, ListIcon, NotebookPenIcon, SquarePenIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { useAgents } from "@/api/queries";
import { OpenSidebarButton } from "@/app/layout/sidebarSheet";
import { providerName } from "@/features/agents/providerLabels";
import { CloseConversationButton, ConversationTitle } from "@/features/conversations/ConversationTitle";
import { NEW_CONVERSATION } from "@/features/messages/timeline";
import { usePatchChannel } from "@/features/settings/mutations";
import { PROMPT_MAX, PROMPT_SAVED_NOTICE } from "@/features/settings/PromptSection";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import { Textarea } from "@/ui/textarea";
import { DmAgentAvatar } from "./DmSection";
import { DM_READ_ONLY_TEXT, invalidateDms, useDm } from "./queries";

/** DM 지시 칸 이름(에이전트 DM 계획 Global Constraints — 글자 그대로) */
export const DM_INSTRUCTION_LABEL = "이 DM 의 지시";

/**
 * DM 머리(에이전트 DM 스펙 3.2): 에이전트 아바타·이름·제공자(러너면 맡은 러너), 지금 세션 제목(바꾸기·닫기는 채널과 같은 것), 「이 DM 의 지시」,
 * 「새 세션」, 「활동」 패널 여닫기. 채널 머리의 참여 에이전트 묶음·채널 설정은 없다 — DM 에서는 채널 관리를 하지 않는다(서버 VALIDATION, 계획 판정 PD9).
 * `activityRef` 는 「활동」 링크 — 패널을 닫으면 초점이 여기로 돌아온다(채널 머리의 설정 링크 자리). 읽기 전용이면 「새 세션」을 두지 않고
 * 지시는 읽기만 한다
 */
export function DmHeader({
  channel,
  conversationId,
  activityRef,
  listOpen,
  onToggleList,
  listRef,
}: {
  channel: Channel;
  conversationId: string;
  activityRef?: RefObject<HTMLAnchorElement | null>;
  listOpen: boolean;
  onToggleList: () => void;
  listRef?: RefObject<HTMLButtonElement | null>;
}) {
  const dm = useDm(channel.id);
  const agents = useAgents();
  // 에이전트 목록이 정본(이름·보관이 wire agents.changed 로 곧바로 바뀐다), 아직 없으면 DM 목록의 것
  const agent: Agent | undefined = agents.data?.find((a) => a.id === channel.dmAgentId) ?? dm?.agent;
  const readOnly = dm?.readOnlyReason ?? null;
  const matchRoute = useMatchRoute();
  const params = { channelId: channel.id, conversationId };
  const activityOpen = Boolean(matchRoute({ to: "/c/$channelId/s/$conversationId/activity", params }));

  return (
    <header data-testid="dm-header" className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <OpenSidebarButton />
      <Button
        ref={listRef}
        variant="ghost"
        size="icon-sm"
        aria-label="세션 목록"
        aria-expanded={listOpen}
        onClick={onToggleList}
      >
        <ListIcon />
      </Button>
      {agent && <DmAgentAvatar agent={agent} size="default" />}
      <div className="min-w-0 flex-1">
        <h1 className="flex items-baseline gap-2 text-base font-semibold">
          <span className="truncate">{agent?.name ?? "DM"}</span>
          {agent && (
            // 이름보다 먼저 줄어든다 — 좁은 화면에서 라벨이 자리를 쥐면 이름이 한 글자로 잘린다
            <span className="min-w-0 shrink-1000 truncate text-xs font-normal text-muted-foreground">
              {providerName(agent.provider)}
              {agent.provider === "claude" && agent.runner && ` · ${agent.runner.label}`}
            </span>
          )}
        </h1>
        <div className="flex min-w-0 items-center gap-1 text-xs">
          <ConversationTitle channelId={channel.id} conversationId={conversationId} />
        </div>
      </div>
      <DmInstructionDialog channel={channel} readOnly={readOnly !== null} />
      {readOnly === null && conversationId !== NEW_CONVERSATION && (
        <Button asChild variant="ghost" size="icon-sm">
          <Link
            to="/c/$channelId/s/$conversationId"
            params={{ channelId: channel.id, conversationId: NEW_CONVERSATION }}
            aria-label="새 세션"
            title="새 세션"
          >
            <SquarePenIcon />
          </Link>
        </Button>
      )}
      <CloseConversationButton channelId={channel.id} conversationId={conversationId} />
      <Button asChild variant="ghost" size="icon-sm">
        <Link
          ref={activityRef}
          to={activityOpen ? "/c/$channelId/s/$conversationId" : "/c/$channelId/s/$conversationId/activity"}
          params={params}
          activeOptions={{ exact: true }}
          aria-label="활동"
          aria-expanded={activityOpen}
        >
          <ActivityIcon />
        </Link>
      </Button>
    </header>
  );
}

/**
 * 「이 DM 의 지시」 — DM 채널의 `prompt`(에이전트에게는 채널 프롬프트 자리로 간다, 계획 판정 PD8). 주인이 쓴다(역할 무관 — 서버는 DM PATCH
 * 에서 `prompt` 만 받는다, PD9). 공백뿐이면 지운다(null). 읽기 전용 DM 이면 값만 보인다(서버가 409 DM_READ_ONLY).
 * 저장이 409 로 거절되면(이 탭이 읽기 전용을 아직 모른다) 전역 토스트가 사유를 알리고, DM 목록을 다시 받아 읽기만 하게 바뀐다
 */
function DmInstructionDialog({ channel, readOnly }: { channel: Channel; readOnly: boolean }) {
  const qc = useQueryClient();
  const save = usePatchChannel(channel.id);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string>();
  const [saved, setSaved] = useState(false);
  const id = useId();
  const value = (readOnly ? undefined : draft) ?? channel.prompt ?? "";

  function onOpenChange(next: boolean) {
    if (!next && save.isPending) return;
    setOpen(next);
    setDraft(undefined);
    setSaved(false);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (draft === undefined || save.isPending || readOnly) return;
    save.mutate(
      { prompt: draft.trim() === "" ? null : draft },
      {
        onSuccess: () => {
          setDraft(undefined);
          setSaved(true);
        },
        onError: (err) => {
          if (err instanceof ApiRequestError && err.code === "DM_READ_ONLY") void invalidateDms(qc);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={DM_INSTRUCTION_LABEL} title={DM_INSTRUCTION_LABEL}>
          <NotebookPenIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <DialogHeader>
            <DialogTitle>{DM_INSTRUCTION_LABEL}</DialogTitle>
            <DialogDescription>이 DM 의 에이전트가 매 턴 함께 받는 지시입니다.</DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label={DM_INSTRUCTION_LABEL}
            aria-describedby={`${id}-count`}
            value={value}
            maxLength={PROMPT_MAX}
            rows={8}
            placeholder="없음"
            disabled={save.isPending || readOnly}
            onChange={(e) => {
              setDraft(e.target.value);
              setSaved(false);
            }}
          />
          <p id={`${id}-count`} className="text-xs text-muted-foreground">
            {(PROMPT_MAX - value.length).toLocaleString("ko-KR")}자 남음
          </p>
          {saved && (
            <p role="status" className="text-sm text-muted-foreground">
              {PROMPT_SAVED_NOTICE}
            </p>
          )}
          {readOnly ? (
            <ReadOnlyLine channelId={channel.id} />
          ) : (
            <DialogFooter>
              <Button type="submit" size="sm" disabled={draft === undefined || save.isPending}>
                {save.isPending ? "저장 중…" : "저장"}
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReadOnlyLine({ channelId }: { channelId: string }) {
  const reason = useDm(channelId)?.readOnlyReason;
  return reason ? <p className="text-sm text-muted-foreground">{DM_READ_ONLY_TEXT[reason]}</p> : null;
}

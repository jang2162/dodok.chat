import { type Agent, MAX_INVITED_AGENTS } from "@dodok/shared";
import { UserPlusIcon } from "lucide-react";
import { type RefObject, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { formError } from "@/api/formErrors";
import { useAgents, useMembers } from "@/api/queries";
import { isArchived } from "@/features/agents/archived";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/ui/dialog";
import { FieldError } from "@/ui/field-error";
import { useInviteAgent, useInvitedAgents } from "./invitedAgents";

/** 고를 줄의 연결 이름 — OpenClaw 는 Gateway, 러너는 러너 토큰 이름. 모르면 없다 */
function connectionName(agent: Agent): string | undefined {
  if (agent.provider === "openclaw") return agent.gateway?.name;
  return agent.runner?.label;
}

/** 초대가 꽉 찼는가(8) — 머리 단추와 좁은 화면 메뉴 줄을 잠근다 */
export function useInviteFull(conversationId: string): boolean {
  return (useInvitedAgents(conversationId).data?.length ?? 0) >= MAX_INVITED_AGENTS;
}

/**
 * 세션 머리의 「에이전트 초대」(세션 에이전트 초대 스펙 5.4) — 그 채널에 없고 보관되지 않았고 이 세션에 아직 초대하지 않은 에이전트를
 * 이름순으로 보이고, 고르면 바로 초대한다. 초대가 이미 8이면 단추를 잠근다(서버도 400)
 */
export function InviteAgentDialog({
  channelId,
  conversationId,
  open: controlledOpen,
  onOpenChange,
  trigger = true,
  returnFocus,
}: {
  channelId: string;
  conversationId: string;
  /** 좁은 화면 「더 보기」에서 열 때 — 열림을 머리가 쥔다 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 거짓이면 머리 단추 없이 대화상자만(좁은 화면) */
  trigger?: boolean;
  /** 트리거 없이 열었을 때 닫으면 초점이 돌아갈 자리(좁은 화면 「더 보기」) */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  const [error, setError] = useState<string>();
  const members = useMembers(channelId);
  const agents = useAgents();
  const invited = useInvitedAgents(conversationId);
  const invite = useInviteAgent(conversationId);
  const inChannel = new Set(
    (members.data ?? []).filter((m) => m.memberType === "agent").map((m) => m.memberId),
  );
  const invitedIds = new Set((invited.data ?? []).map((row) => row.agentId));
  const candidates = (agents.data ?? [])
    .filter((a) => !isArchived(a) && !inChannel.has(a.id) && !invitedIds.has(a.id))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const full = useInviteFull(conversationId);

  function pick(agent: Agent) {
    setError(undefined);
    invite.mutate(agent.id, {
      onSuccess: () => setOpen(false),
      onError: (e) =>
        setError(formError(e) ?? (e instanceof ApiRequestError ? e.message : "초대하지 못했습니다")),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(undefined);
      }}
    >
      {trigger && (
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="에이전트 초대"
            title="에이전트 초대"
            disabled={full}
          >
            <UserPlusIcon />
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        onCloseAutoFocus={(e) => {
          const el = returnFocus?.current;
          if (!el?.isConnected) return;
          e.preventDefault();
          el.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>에이전트 초대</DialogTitle>
        </DialogHeader>
        {agents.data === undefined || members.data === undefined ? (
          <p role="status" className="text-sm text-muted-foreground">
            불러오는 중…
          </p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">초대할 에이전트가 없습니다.</p>
        ) : (
          <ul aria-label="초대할 에이전트" className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {candidates.map((agent) => {
              const connection = connectionName(agent);
              return (
                <li key={agent.id}>
                  <Button
                    variant="ghost"
                    className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left"
                    disabled={invite.isPending}
                    onClick={() => pick(agent)}
                  >
                    <span className="font-medium">{agent.name}</span>
                    <span className="text-muted-foreground">@{agent.handle}</span>
                    {connection && (
                      <span className="ml-auto text-xs text-muted-foreground">{connection}</span>
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <FieldError role="alert" className="text-sm">
          {error}
        </FieldError>
      </DialogContent>
    </Dialog>
  );
}

import type { Agent } from "@dodok/shared";
import { AtSignIcon, SettingsIcon, UserMinusIcon, UserPlusIcon } from "lucide-react";
import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { useMe, useMembers, usePeople } from "@/api/queries";
import { insertMention, openAgentSettings } from "@/features/composer/insertMention";
import { useRemoveInvitedAgent } from "@/features/conversations/invitedAgents";
import { isDeactivated } from "@/features/members/deactivated";
import { WithPresence } from "@/features/presence/PresenceDot";
import { TERMINAL, useRunStore } from "@/features/runs/runStore";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { IdentityAvatar } from "@/ui/identity-avatar";
import { Input } from "@/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/ui/sheet";

/** 머리 단추에 보이는 얼굴 수 */
export const MAX_FACES = 3;
export const NOT_MENTIONABLE = "이 자리의 작성기에서 부를 수 없습니다";
export const NO_SETTINGS = "이 자리의 작성기에 에이전트 설정이 없습니다";
const RESPONDING = "응답 중…";

type Row = {
  key: string;
  kind: "user" | "agent";
  id: string;
  name: string;
  handle: string;
  avatarUrl?: string | null | undefined;
  sub: string;
  me?: boolean;
  responding?: boolean;
  runner?: boolean;
  invited?: boolean;
};

/**
 * 채널 머리의 참여자 단추(UI 시안 03) — 얼굴 셋(사람 먼저, 그다음 응답 중인 에이전트, 나머지)과 총인원. 누르면 팝오버(좁은 화면은 시트):
 * 검색 칸, 세 갈래(사람 / 에이전트(채널) / 이 세션에만 초대). 행마다 아바타·접속 점·이름·핸들 또는 상태, 「멘션」(나 제외 — 세션 작성기에
 * 넣는다), 러너 에이전트는 「⚙」(작성기의 설정 패널을 그 줄에 초점을 두고 연다), 초대 에이전트는 「세션에서 내보내기」(`canInvite`), 맨
 * 아래 「＋ 에이전트 초대」. 고른 동작은 팝오버가 닫히고 초점 되돌리기를 막은 **뒤에** 부른다 — 작성기·설정 패널·초대 대화상자가 초점을 가져간다
 */
export function ParticipantsButton({
  channelId,
  conversationId,
  channelAgents,
  invited,
  canInvite,
  inviteFull,
  onInvite,
  narrow,
  triggerRef,
}: {
  channelId: string;
  conversationId: string;
  /** 채널 멤버 에이전트(보관 제외, 멤버 순) */
  channelAgents: readonly Agent[];
  /** 이 세션에만 초대한 에이전트(채널 에이전트 제외) */
  invited: readonly Agent[];
  canInvite: boolean;
  inviteFull: boolean;
  onInvite: () => void;
  narrow: boolean;
  /** 초대 대화상자가 닫히면 초점이 돌아올 자리 — 이 단추 */
  triggerRef?: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const pending = useRef<(() => void) | null>(null);
  const members = useMembers(channelId);
  const people = usePeople();
  const me = useMe().data?.user;
  const remove = useRemoveInvitedAgent(conversationId);
  const titleId = useId();
  // 이 세션(그 스레드 포함)에서 끝나지 않은 런의 에이전트
  const responding = new Set(
    useRunStore(
      useShallow((s) =>
        Object.values(s.runs)
          .filter(
            (v) =>
              v.state.channelId === channelId &&
              v.state.conversationId === conversationId &&
              !TERMINAL.has(v.state.status),
          )
          .map((v) => v.state.agentId),
      ),
    ),
  );

  const humans = (members.data ?? []).flatMap((m): Row[] => {
    if (m.memberType !== "user") return [];
    const person = people.data?.find((p) => p.id === m.memberId);
    const isMe = me?.id === m.memberId;
    const name = person?.displayName ?? (isMe ? me.displayName : undefined);
    const handle = person?.handle ?? (isMe ? me.handle : undefined);
    if (name === undefined || handle === undefined) return [];
    return [
      {
        key: `u:${m.memberId}`,
        kind: "user",
        id: m.memberId,
        name,
        handle,
        avatarUrl: person?.avatarUrl,
        sub: isMe ? "나" : person && isDeactivated(person) ? "비활성" : `@${handle}`,
        ...(isMe ? { me: true } : {}),
      },
    ];
  });
  const agentRow = (agent: Agent, invitedRow: boolean): Row => {
    const busy = responding.has(agent.id);
    return {
      key: `a:${agent.id}`,
      kind: "agent",
      id: agent.id,
      name: agent.name,
      handle: agent.handle,
      avatarUrl: agent.avatarUrl,
      sub: busy ? RESPONDING : `@${agent.handle}`,
      ...(busy ? { responding: true } : {}),
      ...(agent.provider === "runner" ? { runner: true } : {}),
      ...(invitedRow ? { invited: true } : {}),
    };
  };
  const agentRows = channelAgents.map((a) => agentRow(a, false));
  const invitedRows = invited.map((a) => agentRow(a, true));
  const total = humans.length + agentRows.length + invitedRows.length;
  const allAgents = [...agentRows, ...invitedRows];
  const faces = [
    ...humans,
    ...allAgents.filter((r) => r.responding),
    ...allAgents.filter((r) => !r.responding),
  ].slice(0, MAX_FACES);

  const q = query.trim().toLowerCase();
  const match = (r: Row) => q === "" || [r.name, r.handle].some((s) => s.toLowerCase().includes(q));
  const scope = { channelId, conversationId };
  const later = (fn: () => void) => {
    pending.current = fn;
    setOpen(false);
  };
  const onOpenChange = (next: boolean) => {
    if (next) setQuery("");
    setOpen(next);
  };
  const onCloseAutoFocus = (e: Event) => {
    const run = pending.current;
    pending.current = null;
    if (!run) return;
    e.preventDefault();
    run();
  };

  const row = (r: Row) => (
    <li key={r.key} className="flex min-h-10 items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-accent/50">
      <WithPresence kind={r.kind} id={r.id}>
        <IdentityAvatar
          kind={r.kind === "agent" ? "agent" : "person"}
          id={r.id}
          name={r.name}
          handle={r.handle}
          avatarUrl={r.avatarUrl}
          size={24}
        />
      </WithPresence>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-medium">{r.name}</span>
        <span className={cn("truncate text-xs text-muted-foreground", r.responding && "text-primary")}>
          {r.sub}
          {r.invited && " · 초대됨"}
        </span>
      </span>
      {!r.me && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          aria-label={`@${r.handle} 멘션`}
          onClick={() =>
            later(() => {
              if (!insertMention(scope, r.handle)) toast.info(NOT_MENTIONABLE, { id: "mention-participant" });
            })
          }
        >
          <AtSignIcon className="size-3.5" />
          멘션
        </Button>
      )}
      {/* 러너가 아닌 에이전트도 ⚙ 자리를 비워 「멘션」 단추 열을 맞춘다 */}
      {r.kind === "agent" && !r.runner && <span className="size-7 shrink-0" aria-hidden />}
      {r.runner && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7"
          aria-label={`@${r.handle} 설정`}
          title="이 세션 설정"
          onClick={() =>
            later(() => {
              if (!openAgentSettings(scope, r.id)) toast.info(NO_SETTINGS, { id: "settings-participant" });
            })
          }
        >
          <SettingsIcon />
        </Button>
      )}
      {r.invited && canInvite && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7"
          aria-label={`@${r.handle} 세션에서 내보내기`}
          title="세션에서 내보내기"
          disabled={remove.isPending}
          onClick={() => remove.mutate(r.id)}
        >
          <UserMinusIcon />
        </Button>
      )}
    </li>
  );
  const section = (label: string, title: string, rows: readonly Row[]) => {
    const shown = rows.filter(match);
    if (rows.length === 0) return null;
    return (
      <section aria-label={label} className="flex flex-col gap-0.5">
        <h3 className="px-1.5 pt-1 text-xs font-medium text-muted-foreground">{title}</h3>
        {shown.length === 0 ? (
          <p className="px-1.5 text-xs text-muted-foreground">맞는 참여자가 없습니다</p>
        ) : (
          <ul className="flex flex-col">{shown.map(row)}</ul>
        )}
      </section>
    );
  };
  const busyCount = allAgents.filter((r) => r.responding).length;
  const body: ReactNode = (
    <>
      <Input
        type="search"
        aria-label="참여자 찾기"
        placeholder="이름·핸들 찾기"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        className="h-8 text-sm"
      />
      <div className="flex max-h-[min(24rem,60dvh)] flex-col gap-2 overflow-y-auto">
        {section("사람", `사람 ${humans.length}`, humans)}
        {section(
          "에이전트",
          `에이전트 ${agentRows.length}${busyCount > 0 ? ` · 응답 중 ${busyCount}` : ""}`,
          agentRows,
        )}
        {section("이 세션에만 초대", `이 세션에만 초대 ${invitedRows.length}`, invitedRows)}
      </div>
      {canInvite && (
        <Button
          variant="outline"
          size="sm"
          disabled={inviteFull}
          onClick={() => later(onInvite)}
          className="justify-start"
        >
          <UserPlusIcon />
          에이전트 초대
        </Button>
      )}
    </>
  );

  const label = `참여자 ${total}명`;
  const trigger = (
    <button
      ref={(el) => {
        if (triggerRef) triggerRef.current = el;
      }}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full py-0.5 pr-2 pl-0.5 text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
        narrow && "min-h-11",
      )}
    >
      <span className="flex -space-x-1.5" aria-hidden>
        {faces.map((r) => (
          <IdentityAvatar
            key={r.key}
            kind={r.kind === "agent" ? "agent" : "person"}
            id={r.id}
            name={r.name}
            handle={r.handle}
            avatarUrl={r.avatarUrl}
            size={24}
            className="ring-2 ring-background"
          />
        ))}
      </span>
      <span className="font-medium tabular-nums text-foreground">{total}</span>
    </button>
  );

  if (narrow)
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] gap-3 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <SheetTitle className="pr-8 text-sm font-medium">참여자 {total}</SheetTitle>
          <SheetDescription className="sr-only">이 세션의 사람과 에이전트</SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    );
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        aria-labelledby={titleId}
        className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 p-2"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <h2 id={titleId} className="px-1.5 pt-0.5 text-sm font-medium">
          참여자 {total}
        </h2>
        {body}
      </PopoverContent>
    </Popover>
  );
}

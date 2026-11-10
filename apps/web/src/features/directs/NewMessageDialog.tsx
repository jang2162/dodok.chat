import type { Agent, Person } from "@dodok/shared";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ApiRequestError, NetworkError } from "@/api/http";
import { useAgents, useCachedMe, usePeople, useRole } from "@/api/queries";
import { canOpenDm } from "@/features/dms/queries";
import { isDeactivated } from "@/features/members/deactivated";
import { josa } from "@/lib/josa";
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
import { DmAgentAvatar, PersonPresenceAvatar } from "./DirectRow";
import { DIRECT_PICK_MAX, personName, useOpenDirect } from "./queries";

type Pick = { users: string[]; agents: string[] };
const EMPTY: Pick = { users: [], agents: [] };

/**
 * 열기 실패의 문구. 403 이 막은 에이전트(`details.agentId`)를 알면 그 핸들과 두 까닭을 함께 말한다 — 누가 막혔는지는 말하지 않는다(남의 역할이
 * 드러나지 않게, 사람 간 DM 스펙 5.1). 에이전트를 모르거나 그 밖의 실패는 서버 문구 그대로
 */
function openErrorText(e: unknown, agents: readonly Agent[]): string {
  if (e instanceof ApiRequestError && e.code === "FORBIDDEN") {
    const agent = agents.find((a) => a.id === e.details?.agentId);
    if (agent) {
      const handle = `@${agent.handle}`;
      return `${handle} ${josa(agent.handle, "과", "와")} 대화를 열 수 없습니다 — 에이전트가 꺼져 있거나, 참여자 가운데 이 에이전트의 DM 허용 범위 밖인 사람이 있습니다`;
    }
  }
  if (e instanceof ApiRequestError || e instanceof NetworkError) return e.message;
  return "대화를 열지 못했습니다";
}

/**
 * 사이드바 「다이렉트 메시지」 의 「+」 → 「새 메시지」(사람 간 DM 스펙 「열기」). 사람(활성 멤버, 나 제외)과 에이전트(지금 내 역할로 DM 할 수
 * 있는 것 — `canOpenDm`)를 한 목록에서 여럿(나를 빼고 최대 8) 고른다. 에이전트 하나만 고르면 에이전트 DM(`/dm/<에이전트>` — 그 화면이 찾거나
 * 만든다), 그 밖은 `POST /directs` 뒤 `/c/<채널>`. 다른 참여자의 역할은 웹이 모를 수 있어 403 은 대화상자 안에 보인다(`openErrorText`).
 * `onNavigate` 는 이동할 때마다(좁은 화면 시트 닫기)
 */
export function NewMessageDialog({ onNavigate }: { onNavigate?: () => void }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Pick>(EMPTY);
  const people = usePeople();
  const agents = useAgents();
  const role = useRole();
  const meId = useCachedMe()?.user.id;
  const navigate = useNavigate();
  const openDirect = useOpenDirect();

  const humans = (people.data ?? []).filter(
    (p: Person) => p.id !== meId && p.role !== undefined && !isDeactivated(p),
  );
  const bots = (agents.data ?? []).filter((a: Agent) => canOpenDm(a, role));
  const count = picked.users.length + picked.agents.length;
  const full = count >= DIRECT_PICK_MAX;

  function onOpenChange(next: boolean) {
    if (!next && openDirect.isPending) return;
    setOpen(next);
    setPicked(EMPTY);
    openDirect.reset();
  }

  function toggle(kind: keyof Pick, id: string) {
    openDirect.reset();
    setPicked((prev) => {
      const list = prev[kind];
      if (list.includes(id)) return { ...prev, [kind]: list.filter((x) => x !== id) };
      if (prev.users.length + prev.agents.length >= DIRECT_PICK_MAX) return prev;
      return { ...prev, [kind]: [...list, id] };
    });
  }

  function done(to: () => Promise<void>) {
    setOpen(false);
    setPicked(EMPTY);
    onNavigate?.();
    void to();
  }

  function submit() {
    if (count === 0 || openDirect.isPending) return;
    const [onlyAgent] = picked.agents;
    if (picked.users.length === 0 && picked.agents.length === 1 && onlyAgent) {
      done(() => navigate({ to: "/dm/$agentId", params: { agentId: onlyAgent } }));
      return;
    }
    openDirect.mutate(
      { userIds: picked.users, agentIds: picked.agents },
      {
        onSuccess: ({ channel }) =>
          done(() => navigate({ to: "/c/$channelId", params: { channelId: channel.id } })),
      },
    );
  }

  const loading = people.data === undefined || agents.data === undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="새 메시지" title="새 메시지">
          <PlusIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>새 메시지</DialogTitle>
          <DialogDescription>최대 {DIRECT_PICK_MAX}명</DialogDescription>
        </DialogHeader>
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            {people.isError || agents.isError ? "목록을 불러오지 못했습니다" : "불러오는 중…"}
          </p>
        ) : humans.length + bots.length === 0 ? (
          <p className="text-sm text-muted-foreground">대화할 수 있는 사람이나 에이전트가 없습니다.</p>
        ) : (
          <ul aria-label="상대" className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {humans.map((p) => (
              <Candidate
                key={`u:${p.id}`}
                on={picked.users.includes(p.id)}
                locked={full}
                onToggle={() => toggle("users", p.id)}
                avatar={<PersonPresenceAvatar person={p} />}
                name={personName(p)}
                handle={p.handle}
              />
            ))}
            {bots.map((a) => (
              <Candidate
                key={`a:${a.id}`}
                on={picked.agents.includes(a.id)}
                locked={full}
                onToggle={() => toggle("agents", a.id)}
                avatar={<DmAgentAvatar agent={a} />}
                name={a.name}
                handle={a.handle}
              />
            ))}
          </ul>
        )}
        {openDirect.isError && (
          <p role="alert" className="text-sm text-destructive">
            {openErrorText(openDirect.error, agents.data ?? [])}
          </p>
        )}
        <DialogFooter>
          <Button
            size="sm"
            aria-disabled={count === 0 || openDirect.isPending || undefined}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={submit}
          >
            {openDirect.isPending ? "여는 중…" : "열기"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 후보 한 줄 — 누르면 고르기·풀기(`aria-pressed`). 다 찼으면 고르지 않은 줄은 잠긴다 */
function Candidate({
  on,
  locked,
  onToggle,
  avatar,
  name,
  handle,
}: {
  on: boolean;
  locked: boolean;
  onToggle: () => void;
  avatar: ReactNode;
  name: string;
  handle: string;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={on}
        disabled={locked && !on}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 aria-pressed:bg-accent"
      >
        {avatar}
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-muted-foreground">@{handle}</span>
        {on && <CheckIcon aria-hidden className="ml-auto size-4 shrink-0" />}
      </button>
    </li>
  );
}

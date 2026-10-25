import type { Channel, ChannelMember, Person, SessionPolicy } from "@dodok/shared";
import { type FormEvent, useId, useState } from "react";
import { formError } from "@/api/formErrors";
import { useCanManage, usePeople } from "@/api/queries";
import { useSetSessionManager } from "@/features/conversations/mutations";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { FieldError } from "@/ui/field-error";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { usePatchChannel } from "./mutations";
import { Section } from "./Section";

const POLICY_LABEL: Record<SessionPolicy["create"], string> = {
  members: "누구나",
  managers: "세션 관리자만",
};

/**
 * 채널 설정 「세션」 칸(채널 세션 스펙 「웹」 장): 누가 새 세션을 만드나(누구나 / 세션 관리자만)와 세션 관리자 목록. 바꾸는 것은 admin
 * 이상이고(계획 판정 PS8 — 서버가 막는다), 그 아래는 값만 보이고 잠근다. 정책은 고르는 즉시 저장한다. 세션 관리자는 그 채널의 세션을
 * 만들고(정책이 「세션 관리자만」이어도) 남의 세션도 이름을 바꾸고 닫는다. 지정하면 채널에 없던 사람도 참여한다(서버)
 */
export function SessionSection({
  channel,
  members,
}: {
  channel: Channel;
  members: ChannelMember[] | undefined;
}) {
  const locked = !useCanManage();
  const save = usePatchChannel(channel.id);
  const [error, setError] = useState<string>();
  const id = useId();
  const policy = channel.sessionPolicy?.create ?? "members";

  function choose(next: string) {
    if (locked || save.isPending || (next !== "members" && next !== "managers") || next === policy) return;
    setError(undefined);
    save.mutate({ sessionPolicy: { create: next } }, { onError: (err) => setError(formError(err)) });
  }

  return (
    <Section title="세션" locked={locked}>
      <div className="flex flex-col gap-2">
        <p id={`${id}-policy`} className="text-sm font-medium">
          새 세션을 만들 수 있는 사람
        </p>
        <RadioGroup
          aria-labelledby={`${id}-policy`}
          value={policy}
          onValueChange={choose}
          disabled={locked || save.isPending}
          className="flex flex-col gap-2"
        >
          {(["members", "managers"] as const).map((value) => (
            <div key={value} className="flex items-center gap-2">
              <RadioGroupItem id={`${id}-${value}`} value={value} />
              <Label htmlFor={`${id}-${value}`} className="font-normal">
                {POLICY_LABEL[value]}
              </Label>
            </div>
          ))}
        </RadioGroup>
        <FieldError id={`${id}-error`}>{error}</FieldError>
      </div>
      <Managers channelId={channel.id} members={members} locked={locked} />
    </Section>
  );
}

/** 세션 관리자 목록 + (admin 이상) 해제·지정. 사람 이름은 사람 목록에서 — 못 받았으면 「알 수 없음」 */
function Managers({
  channelId,
  members,
  locked,
}: {
  channelId: string;
  members: ChannelMember[] | undefined;
  locked: boolean;
}) {
  const people = usePeople().data;
  const set = useSetSessionManager(channelId);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string>();
  const id = useId();
  if (members === undefined) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        불러오는 중…
      </p>
    );
  }
  const byId = new Map((people ?? []).map((p) => [p.id, p]));
  const managers = members.filter((m) => m.memberType === "user" && m.role === "manager");
  const managerIds = new Set(managers.map((m) => m.memberId));
  // 지정할 수 있는 사람 — 활성 멤버(역할이 있는) 가운데 아직 세션 관리자가 아닌 사람
  const candidates = (people ?? []).filter(
    (p) => p.role !== undefined && p.deactivatedAt === null && !managerIds.has(p.id),
  );
  const name = (person: Person | undefined) =>
    person ? `@${person.handle} — ${person.displayName}` : "알 수 없는 사람";

  function run(userId: string, on: boolean, done?: () => void) {
    setError(undefined);
    set.mutate({ userId, on }, { onSuccess: done, onError: (err) => setError(formError(err)) });
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected || set.isPending) return;
    run(selected, true, () => setSelected(""));
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">세션 관리자</p>
      {managers.length === 0 ? (
        <p className="text-sm text-muted-foreground">세션 관리자가 없습니다.</p>
      ) : (
        <ul aria-label="세션 관리자" className="flex flex-col gap-1">
          {managers.map((m) => (
            <li key={m.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {name(byId.get(m.memberId))}
                {byId.get(m.memberId)?.deactivatedAt ? " (비활성)" : ""}
              </span>
              {!locked && (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={set.isPending}
                  aria-label={`${name(byId.get(m.memberId))} 세션 관리자 해제`}
                  onClick={() => run(m.memberId, false)}
                >
                  해제
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!locked && candidates.length > 0 && (
        <form onSubmit={submit} className="flex flex-col gap-1.5">
          <Label htmlFor={id}>세션 관리자 지정</Label>
          <div className="flex gap-2">
            <select
              id={id}
              value={selected}
              disabled={set.isPending}
              aria-describedby={error === undefined ? undefined : `${id}-error`}
              onChange={(e) => {
                setSelected(e.target.value);
                setError(undefined);
              }}
              className={cn(
                "h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none",
                "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50",
              )}
            >
              <option value="">사람 선택</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {name(p)}
                </option>
              ))}
            </select>
            <Button type="submit" size="sm" className="h-9" disabled={!selected || set.isPending}>
              {set.isPending ? "지정하는 중…" : "지정"}
            </Button>
          </div>
        </form>
      )}
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}

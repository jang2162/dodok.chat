import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { MemberRow } from "@dodok/shared";
import { api } from "@/api/http";
import { qk, useCanManage, useMe, usePeople } from "@/api/queries";
import { DeactivatedTag } from "@/features/members/DeactivatedTag";
import { isDeactivated } from "@/features/members/deactivated";
import { PRESENCE_LABEL, SELF_INVISIBLE_LABEL, WithPresence } from "@/features/presence/PresenceDot";
import { useDot } from "@/features/presence/store";
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { untilLabel } from "./format";
import { requestMention } from "./openProfile";
import { Field, NotFound } from "./ProfileParts";

/**
 * 사람 프로필(프로필 스펙 3.1) — 큰 아바타 + 점, 표시 이름, @핸들, 역할, 상태 줄, 상태 메시지, admin 이상이면 이메일. 비활성 멤버는
 * 「비활성」만(점 없음). 내 패널이면 「상태 바꾸기」
 */
export function PersonProfile({ userId }: { userId: string }) {
  const people = usePeople();
  const me = useMe().data;
  const canManage = useCanManage();
  const { entry, selfInvisible } = useDot("user", userId);
  const [editing, setEditing] = useState(false);
  // 이메일은 멤버 표(admin 이상)에만 있다 — 사람 목록(누구나)에는 싣지 않는다
  const members = useQuery({
    queryKey: qk.teamMembers,
    queryFn: async () => (await api<{ members: MemberRow[] }>("GET", "/members")).members,
    enabled: canManage,
  });
  const person = people.data?.find((p) => p.id === userId);
  if (!person) return people.isPending ? null : <NotFound />;
  const deactivated = isDeactivated(person);
  const mine = me?.user.id === userId;
  const email = members.data?.find((m) => m.id === userId)?.email;
  const name = person.displayName || person.handle;
  const stateLabel = entry?.state
    ? selfInvisible
      ? SELF_INVISIBLE_LABEL
      : PRESENCE_LABEL[entry.state]
    : undefined;

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="profile-person">
      <div className="flex items-center gap-3">
        {deactivated ? (
          <BigAvatar url={person.avatarUrl} name={name} />
        ) : (
          <WithPresence kind="user" id={userId} size="lg">
            <BigAvatar url={person.avatarUrl} name={name} />
          </WithPresence>
        )}
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold">{name}</h3>
          <p className="text-sm text-muted-foreground">@{person.handle}</p>
        </div>
      </div>
      <dl className="flex flex-col gap-3">
        {person.role && <Field label="역할">{person.role}</Field>}
        <Field label="상태">
          {deactivated ? (
            <DeactivatedTag />
          ) : (
            <>
              {stateLabel ?? "알 수 없음"}
              {entry?.kind === "user" && entry.until && (
                <span className="text-muted-foreground"> · {untilLabel(entry.until)}</span>
              )}
            </>
          )}
        </Field>
        {/* 방해 금지는 접속과 상관없이 살아 있다 — 오프라인이어도 보인다 */}
        {!deactivated && entry?.kind === "user" && entry.dnd && (
          <p className="text-sm text-red-600 dark:text-red-400">
            방해 금지 중{entry.dnd.until ? ` · ${untilLabel(entry.dnd.until)}` : ""}
          </p>
        )}
        {person.statusMessage && (
          <Field label="상태 메시지">
            {person.statusMessage.emoji && <span className="mr-1">{person.statusMessage.emoji}</span>}
            <span>{person.statusMessage.text}</span>
          </Field>
        )}
        {canManage && email && <Field label="이메일">{email}</Field>}
      </dl>
      <div className="flex flex-wrap gap-2">
        {!deactivated && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => requestMention({ kind: "u", id: person.id, handle: person.handle })}
          >
            멘션
          </Button>
        )}
        {mine && (
          <Button variant="outline" size="sm" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
            상태 바꾸기
          </Button>
        )}
      </div>
    </div>
  );
}

function BigAvatar({ url, name }: { url: string | undefined; name: string }) {
  return (
    <Avatar className="size-16">
      {url && <AvatarImage src={url} alt="" />}
      <AvatarFallback className="text-xl">{name.slice(0, 1)}</AvatarFallback>
    </Avatar>
  );
}

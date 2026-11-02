import type { PresenceEntry } from "@dodok/shared";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useDot } from "./store";

type State = NonNullable<PresenceEntry["state"]>;

/** 상태 이름(스펙 3.2·3.4) — 점의 aria-label 과 프로필 패널의 상태 줄이 같은 글을 쓴다 */
export const PRESENCE_LABEL: Record<State, string> = {
  online: "접속 중",
  away: "자리 비움",
  busy: "다른 용무 중",
  dnd: "방해 금지",
  offline: "오프라인",
  available: "응답 가능",
  working: "작업 중",
  disconnected: "연결 끊김",
  off: "꺼짐",
};
export const SELF_INVISIBLE_LABEL = "오프라인으로 보이기";

const COLOR: Record<State, string> = {
  online: "bg-emerald-500",
  away: "bg-amber-400",
  busy: "bg-violet-500",
  dnd: "bg-red-500",
  offline: "bg-zinc-400",
  available: "bg-emerald-500",
  working: "bg-sky-500",
  disconnected: "bg-zinc-400",
  off: "border-2 border-zinc-400 bg-background",
};

/**
 * 아바타 오른쪽 아래의 작은 점 — 부모가 relative 여야 한다. state 가 null(비활성 멤버·보관한 에이전트)이거나 아직 모르는 줄이면
 * 그리지 않는다
 */
export function PresenceDot({
  entry,
  size = "sm",
  selfInvisible = false,
  className,
}: {
  entry: PresenceEntry | undefined;
  size?: "sm" | "lg";
  selfInvisible?: boolean;
  className?: string;
}) {
  const state = entry?.state;
  if (!state) return null;
  const label = selfInvisible ? SELF_INVISIBLE_LABEL : PRESENCE_LABEL[state];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-presence={state}
      className={cn(
        "absolute right-0 bottom-0 block rounded-full ring-2 ring-background",
        size === "lg" ? "size-3.5" : "size-2.5",
        COLOR[state],
        className,
      )}
    />
  );
}

/** 아바타에 점을 붙인다 — 아바타는 overflow-hidden 이라 점을 바깥 틀에 둔다 */
export function WithPresence({
  kind,
  id,
  size = "sm",
  children,
}: {
  kind: "user" | "agent";
  id: string | undefined;
  size?: "sm" | "lg";
  children: ReactNode;
}) {
  const { entry, selfInvisible } = useDot(kind, id);
  return (
    <span className="relative inline-flex shrink-0">
      {children}
      <PresenceDot entry={entry} size={size} selfInvisible={selfInvisible} />
    </span>
  );
}

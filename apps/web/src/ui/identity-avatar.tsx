import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { agentColorIndex, agentColorVar } from "@/theme/agentColor";
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/avatar";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 이니셜 — 첫 글자소(이모지 묶음도 한 글자), 라틴이면 대문자. 빈 글·공백뿐이면 「?」 */
export function initialOf(name: string): string {
  const first = segmenter.segment(name.trim())[Symbol.iterator]().next().value?.segment;
  if (!first) return "?";
  return /\p{Script=Latin}/u.test(first) ? first.toUpperCase() : first;
}

/** 사람 색상각 — 에이전트 8색(tokens.css --agent-1…8, 25°부터 45° 간격)의 사이에 오게 22.5° 어긋낸다 */
export function personHue(id: string): number {
  return (agentColorIndex(id) * 45 + 25 + 22.5) % 360;
}

const ROOT_SIZE = { 24: "size-6", 32: "size-8", 36: "size-9" } as const;
const INITIAL_SIZE = { 24: "text-xs", 32: "text-sm", 36: "text-[15px]" } as const;

/**
 * 사람·에이전트 아바타 하나 — 사진이 있으면 사진, 없거나 받는 사이에는 이니셜(스펙 2026-11-19 U4). 사람은 테두리 없이 옅은 채움,
 * 에이전트는 에이전트 색 2px 테두리(스펙 7.2)에 그 색 16% 채움 — 테두리 유무가 둘을 가르는 축이다
 */
export function IdentityAvatar({
  kind,
  id,
  name,
  handle,
  avatarUrl,
  size,
  className,
}: {
  kind: "person" | "agent";
  id: string;
  name: string;
  /** 에이전트 색은 핸들로 정한다(없으면 id) */
  handle?: string;
  avatarUrl?: string | null;
  size: 24 | 32 | 36;
  className?: string;
}) {
  let rootStyle: CSSProperties | undefined;
  let fillStyle: CSSProperties;
  if (kind === "agent") {
    const color = agentColorVar(handle ?? id);
    rootStyle = { borderColor: color };
    fillStyle = {
      backgroundColor: `color-mix(in oklch, ${color} 16%, transparent)`,
      color: `color-mix(in oklch, ${color} 75%, var(--foreground))`,
    };
  } else {
    const hue = personHue(id);
    fillStyle = {
      backgroundColor: `oklch(var(--person-tint-l) var(--person-tint-c) ${hue})`,
      color: `oklch(var(--person-ink-l) var(--person-ink-c) ${hue})`,
    };
  }
  return (
    <Avatar
      data-kind={kind}
      size={size === 24 ? "sm" : "default"}
      className={cn(ROOT_SIZE[size], kind === "agent" && "border-2", className)}
      style={rootStyle}
    >
      {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
      <AvatarFallback className={cn("font-medium", INITIAL_SIZE[size])} style={fillStyle}>
        {initialOf(name)}
      </AvatarFallback>
    </Avatar>
  );
}

import type { ComponentProps, CSSProperties } from "react";
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

/**
 * 사람 색상각 표 — 에이전트 8색(tokens.css --agent-1…8: 25·70·110·150·195·240·285·330°, 등간격이 아니다)의 이웃한 두 색상각 한가운데.
 * 어느 칸이든 가장 가까운 에이전트 색과 20° 이상 떨어진다
 */
const PERSON_HUE = [47.5, 90, 130, 172.5, 217.5, 262.5, 307.5, 357.5] as const;

/** 사람 색상각 — 사람 id 로 고정(`agentColorIndex` 와 같은 칸 고르기) */
export function personHue(id: string): number {
  return PERSON_HUE[agentColorIndex(id)] as number;
}

const ROOT_SIZE = { 24: "size-6", 32: "size-8", 36: "size-9", 64: "size-16" } as const;
const INITIAL_SIZE = { 24: "text-xs", 32: "text-sm", 36: "text-[15px]", 64: "text-xl" } as const;

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
  imageAlt = "",
  size,
  className,
  ...rest
}: Omit<ComponentProps<typeof Avatar>, "size" | "children" | "style" | "id"> & {
  kind: "person" | "agent";
  id: string;
  name: string;
  /** 에이전트 색은 핸들로 정한다(없으면 id) */
  handle?: string;
  avatarUrl?: string | null;
  /** 사진의 대체 글 — 기본은 장식(빈 글) */
  imageAlt?: string;
  size: 24 | 32 | 36 | 64;
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
      {...rest}
      data-kind={kind}
      size={size === 24 ? "sm" : "default"}
      className={cn(ROOT_SIZE[size], kind === "agent" && "border-2", className)}
      style={rootStyle}
    >
      {avatarUrl && <AvatarImage src={avatarUrl} alt={imageAlt} />}
      <AvatarFallback className={cn("font-medium", INITIAL_SIZE[size])} style={fillStyle}>
        {initialOf(name)}
      </AvatarFallback>
    </Avatar>
  );
}

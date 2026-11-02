import { type UseNavigateResult, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";
import { NEW_CONVERSATION } from "@/features/messages/timeline";

/** 프로필 대상 — 경로의 kind 는 짧게(u·a) */
export type ProfileTarget = { kind: "user" | "agent"; id: string };
export const PROFILE_KIND = { user: "u", agent: "a" } as const;

/**
 * 프로필 패널을 연다(프로필 스펙 3.1) — 세션 화면 오른쪽 패널의 탭 하나라 새로고침·뒤로 가기가 그대로 된다
 */
export function openProfile(
  navigate: UseNavigateResult<string>,
  params: { channelId: string; conversationId: string },
  target: ProfileTarget,
): void {
  void navigate({
    to: "/c/$channelId/s/$conversationId/p/$kind/$id",
    params: { ...params, kind: PROFILE_KIND[target.kind], id: target.id },
  });
}

/**
 * 지금 세션 화면이면 프로필을 여는 함수, 아니면 undefined — 세션 화면 밖(설정 표·검색 결과)이나 새 세션 창에서는 열지 않는다(스펙 3.1)
 */
export function useOpenProfile(): ((target: ProfileTarget) => void) | undefined {
  const navigate = useNavigate();
  // useParams 는 매치가 없는 문맥(라우터 문맥만 준 시험·화면 밖)에서 던진다 — 라우터 상태에서 읽는다
  const params = useRouterState({ select: (s) => s.matches.at(-1)?.params }) as
    | { channelId?: string; conversationId?: string }
    | undefined;
  const channelId = params?.channelId;
  const conversationId = params?.conversationId;
  const open = useCallback(
    (target: ProfileTarget) => {
      if (channelId && conversationId) openProfile(navigate, { channelId, conversationId }, target);
    },
    [navigate, channelId, conversationId],
  );
  if (!channelId || !conversationId || conversationId === NEW_CONVERSATION) return undefined;
  return open;
}

type MentionRequest = { kind: "u" | "a"; id: string; handle: string };
const mentionListeners = new Set<(m: MentionRequest) => void>();

/** 「멘션」 단추 — 보고 있는 세션의 작성기에 `@핸들` 을 넣는다(작성기가 듣는다) */
export function requestMention(m: MentionRequest): void {
  for (const fn of mentionListeners) fn(m);
}
export function onMentionRequest(fn: (m: MentionRequest) => void): () => void {
  mentionListeners.add(fn);
  return () => mentionListeners.delete(fn);
}

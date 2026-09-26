import type { InviteKind, InviteLookup } from "@dodok/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId } from "react";
import { ApiRequestError, api } from "@/api/http";
import { Button } from "@/ui/button";
import { authErrorText } from "./fields";

/** 무효 링크 안내 — 서버는 까닭(쓰임·만료·폐기·없음)을 가르지 않고 모두 404 다(팀 스펙 3.1) */
export const INVALID_TEXT: Record<InviteKind, string> = {
  invite: "초대가 만료됐거나 이미 쓰였습니다 — 초대한 사람에게 새 링크를 받으세요",
  reset: "링크가 만료됐거나 이미 쓰였습니다 — 관리자에게 새 링크를 받으세요",
};

/**
 * 링크 조회(`POST /invites/lookup`) — 토큰은 본문으로 보낸다(서버 접근 로그의 URL 에 남지 않게, 팀 스펙 7장).
 * 조회는 초대 IP 버킷을 쓴다(로그인과 다른 한도 — authErrorText 의 "invite") — 저절로 되풀이하지 않는다(`retry: false`,
 * 다시 받는 일은 「다시 시도」만).
 * 키에는 토큰 대신 마운트마다 다른 `useId` 를 쓴다 — 키는 `queryHash` 로 캐시 전체에 퍼지는 식별자라 원문을 싣지 않는다.
 * 그래서 토큰이 바뀌면 부르는 쪽이 `<InviteGate key={token}>` 로 다시 마운트한다. 화면을 떠나면 곧 빠진다(`gcTime: 0`)
 */
function useInviteLookup(token: string, kind: InviteKind) {
  const id = useId();
  return useQuery({
    queryKey: ["inviteLookup", kind, id],
    queryFn: () => api<InviteLookup>("POST", "/invites/lookup", { token }),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    meta: { silent: true },
  });
}

/** 로그인 전 화면의 틀 — 로그인 화면과 같은 가운데 한 줄(390px 에서 가로 스크롤 없이 w-full) */
export function AuthScreen({ children }: { children: ReactNode }) {
  return <main className="flex min-h-svh items-center justify-center p-6">{children}</main>;
}

/** 무효 링크 화면 — 로그인 화면으로 가는 길만 둔다(이미 계정이 있는 사람) */
export function InviteInvalid({ kind }: { kind: InviteKind }) {
  return (
    <AuthScreen>
      <div className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-xl font-semibold">링크를 쓸 수 없습니다</h1>
        <p className="text-sm text-muted-foreground">{INVALID_TEXT[kind]}</p>
        <Button variant="outline" asChild>
          <Link to="/login">로그인 화면으로</Link>
        </Button>
      </div>
    </AuthScreen>
  );
}

/**
 * 조회가 끝나야 폼을 그린다. 404 와 종류가 다른 링크(가입 주소에 재설정 토큰)는 무효 화면, 그 밖의 실패(네트워크·5xx·429)는
 * 문구와 「다시 시도」. 조회 키가 토큰을 모르므로 부르는 쪽은 `key={token}` 을 준다 — 라우터는 같은 라우트의 파라미터만 바뀌면
 * 다시 마운트하지 않는다
 */
export function InviteGate({
  token,
  kind,
  children,
}: {
  token: string;
  kind: InviteKind;
  children: (lookup: InviteLookup) => ReactNode;
}) {
  const lookup = useInviteLookup(token, kind);
  if (lookup.data) return lookup.data.kind === kind ? children(lookup.data) : <InviteInvalid kind={kind} />;
  if (lookup.error instanceof ApiRequestError && lookup.error.status === 404)
    return <InviteInvalid kind={kind} />;
  return (
    <AuthScreen>
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        {lookup.isError ? (
          <>
            <p className="text-sm text-muted-foreground">
              {lookup.error instanceof ApiRequestError && lookup.error.status === 429
                ? authErrorText(lookup.error, "invite")
                : "링크를 확인하지 못했습니다"}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={lookup.isFetching}
              onClick={() => void lookup.refetch()}
            >
              다시 시도
            </Button>
          </>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            링크를 확인하는 중…
          </p>
        )}
      </div>
    </AuthScreen>
  );
}

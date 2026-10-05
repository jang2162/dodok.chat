import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CHANNEL_ARCHIVED_TEXT, isFormErrorCode } from "@/api/formErrors";
import { ApiRequestError, NetworkError } from "@/api/http";
import { meQuery, qk } from "@/api/queries";

/**
 * 쿼리·뮤테이션 meta. `silent` 면 전역 오류 토스트를 내지 않는다(401 처리는 그대로) — 오류를 스스로 보이는 곳이 쓴다.
 * `apiErrorText` 는 API 오류 토스트의 서버 message 를 고정 문구로 바꾼다(네트워크·권한 토스트는 그대로)
 */
export type RequestMeta = { silent?: boolean; apiErrorText?: (e: ApiRequestError) => string };

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: RequestMeta;
    mutationMeta: RequestMeta;
  }
}

const is401 = (e: unknown) => e instanceof ApiRequestError && e.status === 401;
/** 역할이 모자라 서버가 막은 것(팀 스펙 2장) — 봉투 없는 403(프록시 등)은 아니다 */
const isForbidden = (e: unknown) => e instanceof ApiRequestError && e.code === "FORBIDDEN";
/** 보관한 채널에 쓰기(채널 보관 스펙 「오류」 장) — 이 탭이 아직 보관을 모른다 */
const isChannelArchived = (e: unknown) => e instanceof ApiRequestError && e.code === "CHANNEL_ARCHIVED";
/** 폼 입력 오류는 폼 안에서 보인다(스펙 8장) — 뮤테이션 전역 토스트에서 뺀다 */
const isFormError = (e: unknown) => e instanceof ApiRequestError && isFormErrorCode(e.code);

/** 스펙 8장 「네트워크 실패 → 재시도 2회」: 네트워크 실패·5xx 만. 4xx·코드 오류는 되풀이해도 같다 — 필요한 쿼리는 자기 `retry` 를 준다 */
const isRetryable = (e: unknown) =>
  e instanceof NetworkError || (e instanceof ApiRequestError && e.status >= 500);

/** 스펙 8장: 네트워크 실패는 한 id 로 모아 하나만, API 오류는 서버 message(`apiErrorText` 가 있으면 그 문구). 그 밖(코드 오류)은 토스트하지 않는다 */
function toastError(e: unknown, meta: RequestMeta | undefined) {
  if (isForbidden(e)) toast.error("권한이 없습니다", { id: "forbidden" });
  else if (isChannelArchived(e)) toast.error(CHANNEL_ARCHIVED_TEXT, { id: "channel-archived" });
  else if (e instanceof NetworkError) toast.error("서버에 연결할 수 없습니다", { id: "network" });
  else if (e instanceof ApiRequestError) toast.error(meta?.apiErrorText?.(e) ?? e.message);
}

/**
 * 쿼리·뮤테이션의 401 은 onUnauthorized(토스트 없음). 다만 값이 없는 me 의 401 은 여기서 아무것도 하지 않는다 — 라우트
 * 가드가 `/login?next=` 로 보내고(로그인 화면은 me 로 「이미 로그인」만 본다), 여기서도 보내면 로그인 화면으로 두 번 간다.
 * me 는 토스트하지 않는다(오프라인은 배너가 알린다).
 * 그 밖의 실패는 전역 토스트 — `meta.silent` 로 끄고, 뮤테이션의 VALIDATION·CONFLICT 는 저절로 빠진다.
 * 쿼리 onError 는 재시도가 다 끝난 뒤 한 번 온다. 재시도는 5xx·네트워크 실패만 2회.
 * `FORBIDDEN` 은 역할이 바뀐 것을 화면이 아직 모른다는 뜻이다(팀 스펙 6장 — 역할은 다음 `/auth/me` 부터 따른다) — 서버 문구 대신
 * 「권한이 없습니다」 한 줄을 띄우고, `silent` 여부와 상관없이 me 를 다시 받아 관리 화면을 잠근다
 */
export function createQueryClient(onUnauthorized: () => void): QueryClient {
  const refreshRole = (e: unknown) => {
    if (isForbidden(e)) void qc.fetchQuery({ ...meQuery, staleTime: 0 }).catch(() => undefined);
  };
  // 보관을 놓친 탭의 쓰기(설정·멤버·「새 대화」)가 409 면 채널을 다시 받는다 — 열린 화면이 읽기 전용으로, 사이드바에서 빠진다.
  // 어느 채널인지 오류가 말하지 않으므로 보고 있는 채널 상세 전부(관찰자 있는 것만 다시 부른다)
  const refreshChannels = (e: unknown) => {
    if (!isChannelArchived(e)) return;
    void qc.invalidateQueries({ queryKey: ["channel"] });
    void qc.invalidateQueries({ queryKey: qk.channels, exact: true });
  };
  const qc: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (e, query) => {
        if (query.queryKey[0] === qk.me[0]) {
          // 값을 가진 me 의 401 은 세션 만료다(오프라인 사본으로 뜬 뒤 다시 확인 등) — 가드가 다시 돌지 않으므로 여기서
          if (is401(e) && query.state.data !== undefined) onUnauthorized();
          return;
        }
        refreshRole(e);
        if (is401(e)) onUnauthorized();
        else if (!query.meta?.silent) toastError(e, query.meta);
      },
    }),
    mutationCache: new MutationCache({
      onError: (e, _variables, _onMutateResult, mutation) => {
        refreshRole(e);
        refreshChannels(e);
        if (is401(e)) onUnauthorized();
        else if (!mutation.meta?.silent && !isFormError(e)) toastError(e, mutation.meta);
      },
    }),
    defaultOptions: {
      queries: {
        retry: (count, e) => isRetryable(e) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
  return qc;
}

import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiRequestError, NetworkError } from "@/api/http";
import { qk } from "@/api/queries";

/** 쿼리·뮤테이션 meta. `silent` 면 전역 오류 토스트를 내지 않는다(401 처리는 그대로) — 오류를 스스로 보이는 곳이 쓴다 */
export type RequestMeta = { silent?: boolean };

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: RequestMeta;
    mutationMeta: RequestMeta;
  }
}

const is401 = (e: unknown) => e instanceof ApiRequestError && e.status === 401;
/** 폼 입력 오류는 폼 안에서 보인다(스펙 8장) — 뮤테이션 전역 토스트에서 뺀다 */
const isFormError = (e: unknown) =>
  e instanceof ApiRequestError && (e.code === "VALIDATION" || e.code === "CONFLICT");

/** 스펙 8장: 네트워크 실패는 한 id 로 모아 하나만, API 오류는 서버 message. 그 밖(코드 오류)은 토스트하지 않는다 */
function toastError(e: unknown) {
  if (e instanceof NetworkError) toast.error("서버에 연결할 수 없습니다", { id: "network" });
  else if (e instanceof ApiRequestError) toast.error(e.message);
}

/**
 * 쿼리·뮤테이션의 401 은 onUnauthorized(토스트 없음). 다만 me 쿼리는 여기서 아무것도 하지 않는다 — 라우트 가드가
 * `/login?next=` 로 보내고(로그인 화면은 me 로 「이미 로그인」만 본다), 여기서도 보내면 로그인 화면으로 두 번 간다.
 * 그 밖의 실패는 전역 토스트 — `meta.silent` 로 끄고, 뮤테이션의 VALIDATION·CONFLICT 는 저절로 빠진다.
 * 쿼리 onError 는 재시도가 다 끝난 뒤 한 번 온다. 재시도는 5xx·네트워크 실패만 2회.
 */
export function createQueryClient(onUnauthorized: () => void): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (e, query) => {
        if (query.queryKey[0] === qk.me[0]) return;
        if (is401(e)) onUnauthorized();
        else if (!query.meta?.silent) toastError(e);
      },
    }),
    mutationCache: new MutationCache({
      onError: (e, _variables, _onMutateResult, mutation) => {
        if (is401(e)) onUnauthorized();
        else if (!mutation.meta?.silent && !isFormError(e)) toastError(e);
      },
    }),
    defaultOptions: {
      queries: {
        retry: (count, e) => !(e instanceof ApiRequestError && e.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
    },
  });
}

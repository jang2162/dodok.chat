import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "@/api/http";
import { qk } from "@/api/queries";

const is401 = (e: unknown) => e instanceof ApiRequestError && e.status === 401;

/**
 * 쿼리·뮤테이션의 401 은 onUnauthorized. 다만 me 쿼리의 401 은 부르지 않는다 — 라우트 가드가
 * `/login?next=` 로 보내고(로그인 화면은 me 로 「이미 로그인」만 본다), 여기서도 보내면 로그인 화면으로 두 번 간다.
 * 재시도는 5xx·네트워크 실패만 2회.
 */
export function createQueryClient(onUnauthorized: () => void): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (e, query) => {
        if (is401(e) && query.queryKey[0] !== qk.me[0]) onUnauthorized();
      },
    }),
    mutationCache: new MutationCache({
      onError: (e) => {
        if (is401(e)) onUnauthorized();
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

import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, NetworkError, api } from "@/api/http";
import { qk } from "@/api/queries";
import { type RequestMeta, createQueryClient } from "./queryClient";

const unauthorized = () => new ApiRequestError(401, "UNAUTHORIZED", "로그인이 필요하다");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 뮤테이션 하나를 캐시에 만들어 돌린다(훅 없이) — 전역 onError 는 캐시가 부른다 */
const runMutation = (qc: QueryClient, error: Error, meta?: RequestMeta) =>
  qc
    .getMutationCache()
    .build(qc, { mutationFn: async () => Promise.reject(error), ...(meta ? { meta } : {}) })
    .execute(undefined)
    .catch(() => {});

describe("createQueryClient", () => {
  it("쿼리의 401 은 onUnauthorized 로", async () => {
    const onUnauthorized = vi.fn();
    const qc = createQueryClient(onUnauthorized);
    const queryFn = vi.fn(async () => Promise.reject(unauthorized()));
    await expect(qc.fetchQuery({ queryKey: qk.channels, queryFn })).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("뮤테이션의 401 도 onUnauthorized 로", async () => {
    const onUnauthorized = vi.fn();
    const qc = createQueryClient(onUnauthorized);
    const mutation = qc
      .getMutationCache()
      .build(qc, { mutationFn: async () => Promise.reject(unauthorized()) });
    await expect(mutation.execute(undefined)).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("me 의 401 은 부르지 않는다 — 라우트 가드가 ?next= 를 붙여 보낸다(두 번 이동 방지)", async () => {
    const onUnauthorized = vi.fn();
    const qc = createQueryClient(onUnauthorized);
    await expect(
      qc.fetchQuery({ queryKey: qk.me, queryFn: async () => Promise.reject(unauthorized()) }),
    ).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("401 밖의 오류는 부르지 않는다", async () => {
    const onUnauthorized = vi.fn();
    const qc = createQueryClient(onUnauthorized);
    const queryFn = async () => Promise.reject(new ApiRequestError(403, "FORBIDDEN", "x"));
    await expect(qc.fetchQuery({ queryKey: qk.agents, queryFn })).rejects.toMatchObject({ status: 403 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("재시도는 네트워크 실패(NetworkError)·5xx 만 두 번 더 — 4xx·코드 오류는 한 번으로 끝낸다", async () => {
    const qc = createQueryClient(() => {});
    const clientError = vi.fn(async () => Promise.reject(new ApiRequestError(404, "NOT_FOUND", "x")));
    await expect(
      qc.fetchQuery({ queryKey: ["a"], queryFn: clientError, retryDelay: 0 }),
    ).rejects.toBeInstanceOf(ApiRequestError);
    expect(clientError).toHaveBeenCalledTimes(1);

    const codeError = vi.fn(async () => Promise.reject(new TypeError("x is undefined")));
    await expect(
      qc.fetchQuery({ queryKey: ["b"], queryFn: codeError, retryDelay: 0 }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(codeError).toHaveBeenCalledTimes(1);

    const serverError = vi.fn(async () =>
      Promise.reject(new ApiRequestError(503, "ADAPTER_UNAVAILABLE", "x")),
    );
    await expect(
      qc.fetchQuery({ queryKey: ["c"], queryFn: serverError, retryDelay: 0 }),
    ).rejects.toBeInstanceOf(ApiRequestError);
    expect(serverError).toHaveBeenCalledTimes(3);

    // api() 가 fetch 실패를 NetworkError 로 감싼 것이 재시도를 탄다
    const fetch = vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetch);
    await expect(
      qc.fetchQuery({ queryKey: ["d"], queryFn: () => api("GET", "/d"), retryDelay: 0 }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("전역 오류 토스트(스펙 8장)", () => {
  let toastError: MockInstance<typeof toast.error>;
  beforeEach(() => {
    toastError = vi.spyOn(toast, "error").mockImplementation(() => 0);
  });

  const failQuery = (
    qc: QueryClient,
    error: Error,
    opts: { key?: readonly unknown[]; meta?: RequestMeta } = {},
  ) =>
    qc
      .fetchQuery({
        queryKey: opts.key ?? ["x"],
        queryFn: async () => Promise.reject(error),
        retryDelay: 0,
        ...(opts.meta ? { meta: opts.meta } : {}),
      })
      .catch(() => {});

  it('쿼리 네트워크 실패는 재시도가 다 끝난 뒤 한 번, id "network"(여러 쿼리가 함께 실패해도 토스트 하나)', async () => {
    const qc = createQueryClient(() => {});
    const queryFn = vi.fn(async () => Promise.reject(new NetworkError(new TypeError("Failed to fetch"))));
    await qc.fetchQuery({ queryKey: ["x"], queryFn, retryDelay: 0 }).catch(() => {});
    expect(queryFn).toHaveBeenCalledTimes(3);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("서버에 연결할 수 없습니다", { id: "network" });
  });

  it("쿼리의 API 오류(500)는 서버 message 로", async () => {
    const qc = createQueryClient(() => {});
    await failQuery(qc, new ApiRequestError(500, "INTERNAL", "서버 내부 오류"));
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("서버 내부 오류");
  });

  it("401 은 토스트 없이 onUnauthorized 만", async () => {
    const onUnauthorized = vi.fn();
    const qc = createQueryClient(onUnauthorized);
    await failQuery(qc, unauthorized());
    await runMutation(qc, unauthorized());
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("meta.silent 면 토스트하지 않는다 — 401 처리는 그대로", async () => {
    const onUnauthorized = vi.fn();
    const qc = createQueryClient(onUnauthorized);
    await failQuery(qc, new ApiRequestError(500, "INTERNAL", "x"), { meta: { silent: true } });
    await failQuery(qc, new NetworkError(new TypeError("x")), { key: ["y"], meta: { silent: true } });
    await runMutation(qc, new ApiRequestError(403, "FORBIDDEN", "x"), { silent: true });
    expect(toastError).not.toHaveBeenCalled();

    await failQuery(qc, unauthorized(), { key: ["z"], meta: { silent: true } });
    await runMutation(qc, unauthorized(), { silent: true });
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
  });

  it("me 는 토스트하지 않는다 — 가드·로그인 화면이 다룬다", async () => {
    const qc = createQueryClient(() => {});
    await failQuery(qc, new ApiRequestError(500, "INTERNAL", "x"), { key: qk.me });
    await failQuery(qc, new NetworkError(new TypeError("x")), { key: qk.me });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("뮤테이션의 VALIDATION·CONFLICT 는 폼 안에서 보이므로 토스트하지 않는다", async () => {
    const qc = createQueryClient(() => {});
    await runMutation(qc, new ApiRequestError(400, "VALIDATION", "이름이 비었다"));
    await runMutation(qc, new ApiRequestError(409, "CONFLICT", "이미 있다"));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("뮤테이션의 그 밖 4xx·네트워크 실패는 토스트", async () => {
    const qc = createQueryClient(() => {});
    await runMutation(qc, new ApiRequestError(403, "FORBIDDEN", "권한이 없다"));
    await runMutation(qc, new ApiRequestError(404, "NOT_FOUND", "채널이 없다"));
    await runMutation(qc, new NetworkError(new TypeError("Failed to fetch")));
    expect(toastError.mock.calls).toEqual([
      ["권한이 없다"],
      ["채널이 없다"],
      ["서버에 연결할 수 없습니다", { id: "network" }],
    ]);
  });

  it("API·네트워크 밖의 오류(프로그래머 오류)는 토스트하지 않는다", async () => {
    const qc = createQueryClient(() => {});
    await failQuery(qc, new TypeError("x is undefined"));
    await runMutation(qc, new Error("boom"));
    expect(toastError).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/api/http";
import { qk } from "@/api/queries";
import { createQueryClient } from "./queryClient";

const unauthorized = () => new ApiRequestError(401, "UNAUTHORIZED", "로그인이 필요하다");

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

  it("4xx 는 재시도하지 않고, 5xx·네트워크 실패는 두 번 더 시도한다", async () => {
    const qc = createQueryClient(() => {});
    const clientError = vi.fn(async () => Promise.reject(new ApiRequestError(404, "NOT_FOUND", "x")));
    await expect(
      qc.fetchQuery({ queryKey: ["a"], queryFn: clientError, retryDelay: 0 }),
    ).rejects.toBeInstanceOf(ApiRequestError);
    expect(clientError).toHaveBeenCalledTimes(1);

    const serverError = vi.fn(async () => Promise.reject(new ApiRequestError(502, "INTERNAL", "x")));
    await expect(
      qc.fetchQuery({ queryKey: ["b"], queryFn: serverError, retryDelay: 0 }),
    ).rejects.toBeInstanceOf(ApiRequestError);
    expect(serverError).toHaveBeenCalledTimes(3);

    const network = vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(qc.fetchQuery({ queryKey: ["c"], queryFn: network, retryDelay: 0 })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(network).toHaveBeenCalledTimes(3);
  });
});

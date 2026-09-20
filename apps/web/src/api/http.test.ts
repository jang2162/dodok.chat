import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, NetworkError, api } from "./http";

const reply = (status: number, body?: unknown) =>
  vi.fn<typeof fetch>(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  it("JSON 본문·같은 출처 쿠키로 보내고 JSON 을 돌려준다", async () => {
    const fetch = reply(201, { channel: { id: "c" } });
    vi.stubGlobal("fetch", fetch);
    await expect(api("POST", "/channels", { name: "x" })).resolves.toEqual({ channel: { id: "c" } });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/channels",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ name: "x" }),
        headers: { "content-type": "application/json" },
      }),
    );
  });

  it("본문 없는 GET 은 content-type 을 싣지 않는다", async () => {
    const fetch = reply(200, { channels: [] });
    vi.stubGlobal("fetch", fetch);
    await api("GET", "/channels");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", headers: {} });
  });

  it("오류 본문 { code, message } 는 ApiRequestError 로", async () => {
    vi.stubGlobal("fetch", reply(409, { code: "CONFLICT", message: "이미 채널 멤버다" }));
    await expect(api("POST", "/channels/c/members", {})).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      message: "이미 채널 멤버다",
    });
  });

  it("오류 본문이 계약 밖이면 INTERNAL + 한국어 일반 문구(상태 코드만 덧붙임 — 영문 상태 문구는 토스트에 나가지 않는다)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" })),
    );
    const err = await api("GET", "/channels").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({
      status: 502,
      code: "INTERNAL",
      message: "서버가 요청을 처리하지 못했습니다 (502)",
    });

    // 상태 문구가 없는 응답(HTTP/2 등)도 같은 문구, 5xx 밖이면 「요청을 처리하지 못했습니다」
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 504 })),
    );
    await expect(api("GET", "/channels")).rejects.toMatchObject({
      message: "서버가 요청을 처리하지 못했습니다 (504)",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { status: 413 })),
    );
    await expect(api("POST", "/channels", {})).rejects.toMatchObject({
      status: 413,
      code: "INTERNAL",
      message: "요청을 처리하지 못했습니다 (413)",
    });
  });

  it("fetch 가 던지면(응답 없음) NetworkError — 원래 오류는 cause", async () => {
    const cause = new TypeError("Failed to fetch");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(cause)),
    );
    const err = await api("GET", "/channels").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).not.toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ name: "NetworkError", cause });
  });

  it("본문을 받다 끊겨도 NetworkError", async () => {
    const cause = new TypeError("network error");
    const broken = new ReadableStream({ start: (c) => c.error(cause) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(broken, { status: 200 })),
    );
    await expect(api("GET", "/channels")).rejects.toMatchObject({ name: "NetworkError", cause });
  });
});

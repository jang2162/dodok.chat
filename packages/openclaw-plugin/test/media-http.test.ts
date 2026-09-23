import { describe, expect, it, vi } from "vitest";
import { bridgeHttpOrigin, downloadAttachment, MediaHttpError, uploadAttachment } from "../src/media-http";

const ID = "01a0cc16-22ee-7018-826c-e4783d25fa14";
const CH = "01a0cc14-f436-7002-8c10-bc7d4d032c2f";
const att = {
  id: ID,
  kind: "file",
  url: `artifact://${ID}`,
  name: "보고서.pdf",
  mime: "application/pdf",
  size: 3,
};

describe("media-http", () => {
  it("브리지 URL → HTTP 오리진", () => {
    expect(bridgeHttpOrigin("ws://127.0.0.1:19100/bridge")).toBe("http://127.0.0.1:19100");
    expect(bridgeHttpOrigin("wss://dodok.example.com/bridge")).toBe("https://dodok.example.com");
    expect(bridgeHttpOrigin("https://dodok.example.com:8443/x")).toBe("https://dodok.example.com:8443");
  });

  it("받기: 토큰 헤더·경로, MIME 은 content-type", async () => {
    const f = vi.fn(
      async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }),
    );
    const r = await downloadAttachment({ origin: "http://h", token: "t", id: ID, fetch: f as never });
    expect(f).toHaveBeenCalledWith(
      `http://h/bridge/attachments/${ID}`,
      expect.objectContaining({ headers: { authorization: "Bearer t" } }),
    );
    expect(r).toEqual({ bytes: Buffer.from([1, 2]), mime: "image/png" });
  });

  it("받기: 404 는 status 를 실은 MediaHttpError", async () => {
    const f = vi.fn(async () => new Response("no", { status: 404 }));
    await expect(
      downloadAttachment({ origin: "http://h", token: "t", id: ID, fetch: f as never }),
    ).rejects.toMatchObject({ name: "MediaHttpError", status: 404 });
    await expect(
      downloadAttachment({ origin: "http://h", token: "t", id: ID, fetch: f as never }),
    ).rejects.toBeInstanceOf(MediaHttpError);
  });

  it("올리기: 헤더(채널·퍼센트 인코딩 이름·content-type)와 응답 Attachment 파싱", async () => {
    const f = vi.fn(async () => Response.json(att));
    const r = await uploadAttachment({
      origin: "http://h",
      token: "t",
      channelId: CH,
      bytes: new Uint8Array([1]),
      name: "보고서.pdf",
      mime: "application/pdf",
      fetch: f as never,
    });
    expect(r).toEqual(att);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer t",
      "x-dodok-channel-id": CH,
      "x-dodok-file-name": encodeURIComponent("보고서.pdf"),
      "content-type": "application/pdf",
    });
  });

  it("올리기: 네트워크 오류는 한 번 다시, HTTP 오류는 다시 하지 않는다", async () => {
    const net = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(Response.json(att));
    await expect(
      uploadAttachment({
        origin: "http://h",
        token: "t",
        channelId: CH,
        bytes: new Uint8Array([1]),
        name: "a",
        fetch: net as never,
      }),
    ).resolves.toEqual(att);
    expect(net).toHaveBeenCalledTimes(2);
    const http = vi.fn(async () => new Response("big", { status: 413 }));
    await expect(
      uploadAttachment({
        origin: "http://h",
        token: "t",
        channelId: CH,
        bytes: new Uint8Array([1]),
        name: "a",
        fetch: http as never,
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("받기: content-type 이 없으면 application/octet-stream, 매개변수는 뗀다", async () => {
    const none = vi.fn(async () => new Response(new Uint8Array([1])));
    await expect(
      downloadAttachment({ origin: "http://h", token: "t", id: ID, fetch: none as never }),
    ).resolves.toMatchObject({ mime: "application/octet-stream" });
    const param = vi.fn(
      async () =>
        new Response(new Uint8Array([1]), { headers: { "content-type": "image/png; charset=binary" } }),
    );
    await expect(
      downloadAttachment({ origin: "http://h", token: "t", id: ID, fetch: param as never }),
    ).resolves.toMatchObject({ mime: "image/png" });
    // 빈 값·매개변수만 있는 값도 octet-stream(`??` 가 아니라 `||`)
    for (const ct of ["", ";charset=x"]) {
      const empty = vi.fn(async () => new Response(new Uint8Array([1]), { headers: { "content-type": ct } }));
      await expect(
        downloadAttachment({ origin: "http://h", token: "t", id: ID, fetch: empty as never }),
      ).resolves.toMatchObject({ mime: "application/octet-stream" });
    }
  });

  it("올리기: 네트워크 오류가 retries 를 넘으면 그 오류를 던진다", async () => {
    const net = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      uploadAttachment({
        origin: "http://h",
        token: "t",
        channelId: CH,
        bytes: new Uint8Array([1]),
        name: "a",
        fetch: net as never,
      }),
    ).rejects.toThrow("fetch failed");
    expect(net).toHaveBeenCalledTimes(2);
  });

  it("응답이 계약을 어기면 던진다", async () => {
    const f = vi.fn(async () => Response.json({ id: "x" }));
    await expect(
      uploadAttachment({
        origin: "http://h",
        token: "t",
        channelId: CH,
        bytes: new Uint8Array([1]),
        name: "a",
        fetch: f as never,
      }),
    ).rejects.toBeInstanceOf(MediaHttpError);
    // 계약 위반은 네트워크 오류가 아니다 — 다시 보내지 않는다
    expect(f).toHaveBeenCalledTimes(1);
  });
});

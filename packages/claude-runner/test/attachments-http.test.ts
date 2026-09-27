import { BRIDGE_ATTACHMENT_HEADERS, RUNNER_ATTACHMENTS_PATH } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { AttachmentsHttpError, createAttachmentsHttp } from "../src/attachments-http";

const TOKEN = "drn_secret_token_value";
const ATT_ID = "0192f000-0000-7000-8000-0000000000f1";
const CHANNEL = "0192f000-0000-7000-8000-00000000c001";

type Seen = { url: string; init: RequestInit };

function fakeFetch(respond: (s: Seen) => Response) {
  const seen: Seen[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const s = { url: String(url), init: init ?? {} };
    seen.push(s);
    return respond(s);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const attachment = {
  id: ATT_ID,
  kind: "file",
  url: `artifact://${ATT_ID}`,
  name: "report final.md",
  mime: "text/plain",
  size: 5,
};

describe("createAttachmentsHttp — 브리지 첨부 HTTP 와 같은 모양, 경로만 /runner/attachments", () => {
  it("upload — POST, 러너 토큰 Bearer·채널 헤더·이름 퍼센트 인코딩, 응답은 Attachment 로 파싱", async () => {
    const { fetch, seen } = fakeFetch(() => Response.json(attachment));
    const http = createAttachmentsHttp({ serverUrl: "https://chat.example.com/", token: TOKEN, fetch });
    const out = await http.upload({
      channelId: CHANNEL,
      bytes: new TextEncoder().encode("hello"),
      name: "report final.md",
      mime: "text/plain",
    });
    expect(out).toEqual(attachment);
    expect(seen[0]!.url).toBe(`https://chat.example.com${RUNNER_ATTACHMENTS_PATH}`);
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      [BRIDGE_ATTACHMENT_HEADERS.channelId]: CHANNEL,
      [BRIDGE_ATTACHMENT_HEADERS.fileName]: "report%20final.md",
      "content-type": "text/plain",
    });
  });

  it("download — GET /runner/attachments/<id>, MIME 은 응답 헤더", async () => {
    const { fetch, seen } = fakeFetch(
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png; x=1" } }),
    );
    const http = createAttachmentsHttp({ serverUrl: "http://127.0.0.1:3100", token: TOKEN, fetch });
    const out = await http.download(ATT_ID);
    expect([...out.bytes]).toEqual([1, 2, 3]);
    expect(out.mime).toBe("image/png");
    expect(seen[0]!.url).toBe(`http://127.0.0.1:3100${RUNNER_ATTACHMENTS_PATH}/${ATT_ID}`);
    expect(seen[0]!.init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
  });

  it("HTTP 오류는 상태를 싣고 던진다 — 문구에 토큰·주소가 없다", async () => {
    const { fetch } = fakeFetch(() => new Response("nope", { status: 413 }));
    const http = createAttachmentsHttp({ serverUrl: "https://chat.example.com", token: TOKEN, fetch });
    const err = await http
      .upload({ channelId: CHANNEL, bytes: new Uint8Array([1]), name: "a" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentsHttpError);
    expect((err as AttachmentsHttpError).status).toBe(413);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain("chat.example.com");
    await expect(http.download(ATT_ID)).rejects.toMatchObject({ status: 413 });
  });

  it("업로드 응답이 계약과 다르면 던진다", async () => {
    const { fetch } = fakeFetch(() => Response.json({ id: "x" }));
    const http = createAttachmentsHttp({ serverUrl: "https://chat.example.com", token: TOKEN, fetch });
    await expect(
      http.upload({ channelId: CHANNEL, bytes: new Uint8Array([1]), name: "a" }),
    ).rejects.toBeInstanceOf(AttachmentsHttpError);
  });

  it("네트워크 오류도 토큰 없는 AttachmentsHttpError 로", async () => {
    const fetch = (async () => {
      throw new TypeError(`fetch failed Bearer ${TOKEN}`);
    }) as typeof globalThis.fetch;
    const http = createAttachmentsHttp({ serverUrl: "https://chat.example.com", token: TOKEN, fetch });
    const err = await http.download(ATT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentsHttpError);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("런 signal 이 끊기면 제한 시간을 기다리지 않고 끊는다 — 올리기·받기 둘 다", async () => {
    // 신호가 끊길 때까지 응답하지 않는 fetch
    const fetch = ((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      })) as typeof globalThis.fetch;
    const http = createAttachmentsHttp({
      serverUrl: "https://chat.example.com",
      token: TOKEN,
      fetch,
      timeoutMs: 60_000,
    });
    const run = new AbortController();
    const started = Date.now();
    const down = http.download(ATT_ID, { signal: run.signal }).catch((e: unknown) => e);
    const up = http
      .upload({ channelId: CHANNEL, bytes: new Uint8Array([1]), name: "a", signal: run.signal })
      .catch((e: unknown) => e);
    run.abort();
    const [d, u] = await Promise.all([down, up]);
    expect(d).toBeInstanceOf(AttachmentsHttpError);
    expect(u).toBeInstanceOf(AttachmentsHttpError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("런 signal 이 없어도 제한 시간은 그대로 건다", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const fetch = (async (_url: string | URL, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response(new Uint8Array([1]));
    }) as typeof globalThis.fetch;
    const http = createAttachmentsHttp({ serverUrl: "https://chat.example.com", token: TOKEN, fetch });
    await http.download(ATT_ID);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});

import { Attachment, BRIDGE_ATTACHMENT_HEADERS as H, RUNNER_ATTACHMENTS_PATH } from "@dodok/shared";

// 러너 첨부 HTTP(러너 스펙 3·4.4) — 서버의 브리지 첨부 HTTP(apps/server modules/attachments/routes.ts)와 같은 모양·같은
// 제한이고 경로와 토큰만 러너 것이다. 오류 문구는 도구 결과·로그로 가므로 토큰·서버 주소를 싣지 않는다

export class AttachmentsHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AttachmentsHttpError";
  }
}

/** signal 은 런의 것 — 멈춘 런은 제한 시간까지 기다리지 않는다 */
export type AttachmentsHttp = {
  upload(o: {
    /** 서버가 그 대화의 채널로 묶는다 */
    conversationId: string;
    bytes: Uint8Array;
    name: string;
    mime?: string;
    signal?: AbortSignal;
  }): Promise<Attachment>;
  download(id: string, o?: { signal?: AbortSignal }): Promise<{ bytes: Buffer; mime: string }>;
};

const DEFAULT_TIMEOUT_MS = 30_000;

export function createAttachmentsHttp(o: {
  /** 설정의 serverUrl — 소켓 연결과 같은 바탕 */
  serverUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): AttachmentsHttp {
  const base = o.serverUrl.replace(/\/+$/, "") + RUNNER_ATTACHMENTS_PATH;
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(
    url: string,
    init: RequestInit,
    what: string,
    runSignal: AbortSignal | undefined,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        ...init,
        signal: runSignal ? AbortSignal.any([timeout, runSignal]) : timeout,
      });
    } catch (error) {
      // fetch 오류 문구는 주소를 담을 수 있다 — 종류만 남긴다
      const kind = error instanceof Error ? error.name : "unknown";
      throw new AttachmentsHttpError(`첨부 ${what} 실패(${kind})`);
    }
    if (!res.ok) throw new AttachmentsHttpError(`첨부 ${what} 실패 ${res.status}`, res.status);
    return res;
  }

  return {
    async upload({ conversationId, bytes, name, mime, signal }) {
      const res = await request(
        base,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${o.token}`,
            [H.conversationId]: conversationId,
            [H.fileName]: encodeURIComponent(name),
            "content-type": mime ?? "application/octet-stream",
          },
          body: bytes,
        },
        "올리기",
        signal,
      );
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      const parsed = Attachment.safeParse(body);
      if (!parsed.success) throw new AttachmentsHttpError("첨부 올리기 응답이 계약과 다릅니다");
      return parsed.data;
    },

    async download(id, opts) {
      const res = await request(
        `${base}/${encodeURIComponent(id)}`,
        { headers: { authorization: `Bearer ${o.token}` } },
        "받기",
        opts?.signal,
      );
      return {
        bytes: Buffer.from(await res.arrayBuffer()),
        mime: res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
      };
    },
  };
}

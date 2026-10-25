/**
 * 브리지 오리진 HTTP 로 첨부 바이트를 주고받는다(스펙 결정 3). 모듈 상태 없음(ADR 0004), `fetch` 는 주입할 수 있다.
 * `openclaw` 를 import 하지 않는다 — 단위 테스트 대상
 */
import { Attachment, BRIDGE_ATTACHMENT_HEADERS as H, BRIDGE_ATTACHMENTS_PATH } from "@dodok/shared";

export class MediaHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MediaHttpError";
  }
}

/** 계정 `bridgeUrl` 의 오리진 — `ws:`→`http:`, `wss:`→`https:`, 경로는 뗀다 */
export function bridgeHttpOrigin(bridgeUrl: string): string {
  const u = new URL(bridgeUrl);
  const protocol = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
  return `${protocol}//${u.host}`;
}

type Common = { origin: string; token: string; fetch?: typeof fetch; timeoutMs?: number };
const DEFAULT_TIMEOUT_MS = 30_000;

export async function downloadAttachment(
  o: Common & { id: string },
): Promise<{ bytes: Buffer; mime: string }> {
  const res = await (o.fetch ?? fetch)(`${o.origin}${BRIDGE_ATTACHMENTS_PATH}/${o.id}`, {
    headers: { authorization: `Bearer ${o.token}` },
    signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) throw new MediaHttpError(`첨부 받기 실패 ${res.status}`, res.status);
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    mime: res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
  };
}

/** 파일 하나를 올린다. 네트워크 오류만 `retries`(기본 1)번 다시 하고, HTTP 오류(`MediaHttpError`)는 바로 던진다 */
export async function uploadAttachment(
  o: Common & { conversationId: string; bytes: Uint8Array; name: string; mime?: string; retries?: number },
): Promise<Attachment> {
  const attempt = async (): Promise<Attachment> => {
    const res = await (o.fetch ?? fetch)(`${o.origin}${BRIDGE_ATTACHMENTS_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${o.token}`,
        [H.conversationId]: o.conversationId,
        [H.fileName]: encodeURIComponent(o.name),
        "content-type": o.mime ?? "application/octet-stream",
      },
      body: o.bytes,
      signal: AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) throw new MediaHttpError(`첨부 올리기 실패 ${res.status}`, res.status);
    const parsed = Attachment.safeParse(await res.json());
    if (!parsed.success) throw new MediaHttpError("첨부 올리기 응답이 계약과 다르다");
    return parsed.data;
  };
  let left = o.retries ?? 1;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof MediaHttpError || left <= 0) throw err;
      left--;
    }
  }
}

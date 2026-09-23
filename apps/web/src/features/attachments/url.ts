import { type Attachment, parseArtifactUrl } from "@dodok/shared";

/** 서버 첨부 → 같은 출처 경로(쿠키 인증). `artifact://<id>` 가 아니면 undefined */
export function attachmentHref(
  a: Pick<Attachment, "url">,
  opts: { download?: boolean } = {},
): string | undefined {
  const id = parseArtifactUrl(a.url);
  return id ? `/api/v1/attachments/${id}${opts.download ? "?download=1" : ""}` : undefined;
}

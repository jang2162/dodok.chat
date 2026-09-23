import type { Attachment, ComponentsV1 } from "@dodok/shared";

export type Resolved =
  | { kind: "attachment"; attachment: Attachment }
  | { kind: "https"; url: string }
  | { kind: "missing" }
  | { kind: "blocked" };

const PREFIX = "artifact://";

function decode(ref: string): string {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

/**
 * 카드의 URL 한 개를 **그 메시지의** 첨부로 푼다(스펙 6.3): 이름이 같은 첫 첨부, 없으면 id 가 같은 첨부.
 * 접두사로만 가른다 — 대문자·앞 공백·가운데 품은 값·`artifact:/` 는 blocked
 */
export function resolveRef(url: string, attachments: readonly Attachment[]): Resolved {
  if (url.startsWith("https://")) return { kind: "https", url };
  if (!url.startsWith(PREFIX)) return { kind: "blocked" };
  const ref = url.slice(PREFIX.length);
  if (!ref) return { kind: "missing" };
  const names = [ref, decode(ref)];
  const found =
    attachments.find((a) => names.includes(a.name)) ?? attachments.find((a) => a.id === ref.toLowerCase());
  return found ? { kind: "attachment", attachment: found } : { kind: "missing" };
}

/** 카드(media·file·링크 버튼)가 가리킨 첨부 id — 카드 아래에 다시 그리지 않는다(스펙 6.3) */
export function referencedAttachmentIds(
  components: ComponentsV1 | undefined,
  attachments: readonly Attachment[],
): Set<string> {
  const ids = new Set<string>();
  if (!components) return ids;
  const see = (url: string | undefined) => {
    if (!url) return;
    const r = resolveRef(url, attachments);
    if (r.kind === "attachment") ids.add(r.attachment.id);
  };
  for (const b of components.blocks) {
    if (b.type === "media") for (const i of b.items) see(i.url);
    else if (b.type === "file") see(b.url);
    else if (b.type === "actions") for (const i of b.items) if (i.type === "button") see(i.url);
  }
  return ids;
}

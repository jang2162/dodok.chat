import { type Attachment, type ComponentsV1, sanitizeAttachmentName } from "@dodok/shared";

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

/** 뒤에 16진 두 자리가 없는 `%` 는 글자 그대로의 `%` 로 보고 디코드한다 — `50%%20할인.pdf` → `50% 할인.pdf` */
function lenientDecode(ref: string): string {
  return decode(ref.replace(/%(?![0-9a-f]{2})/gi, "%25"));
}

/** 저장 규칙으로 다듬으면 빈 이름(폴백 `file` 이 되는 것)인가 — 뒤에 글자 하나를 붙여 다듬어 그 글자만 남는지 본다 */
function sanitizesToBlank(name: string): boolean {
  return sanitizeAttachmentName(`${name}Z`) === "Z";
}

/**
 * 카드의 URL 한 개를 **그 메시지의** 첨부로 푼다(스펙 6.3): 이름으로 먼저, 없으면 id 가 같은 첨부.
 * 이름 후보는 우선순위대로 하나씩 첨부 전체에 맞춘다(첨부 순서가 아니다): ref 그대로 → 디코드 →
 * 관대한 디코드 → 각각을 저장 규칙(`sanitizeAttachmentName`)으로 다듬은 것. 후보와 첨부 이름은 NFC 로 맞춰 견준다. 플러그인이 공백류를 인코딩해 보내고
 * 서버는 제어 문자를 뺀 이름으로 저장하기 때문이다(a3-c1 리뷰 2절). 다듬어 빈 후보는 건너뛴다 — 폴백 `file` 로
 * 풀면 이름 정보가 없는 ref(`artifact://%09`)가 그 이름의 첨부를 짚는다(a3-c2 리뷰 3절).
 * 접두사로만 가른다 — 대문자·앞 공백·가운데 품은 값·`artifact:/` 는 blocked
 */
export function resolveRef(url: string, attachments: readonly Attachment[]): Resolved {
  if (url.startsWith("https://")) return { kind: "https", url };
  if (!url.startsWith(PREFIX)) return { kind: "blocked" };
  const ref = url.slice(PREFIX.length);
  if (!ref) return { kind: "missing" };
  // 서버는 이름을 NFC 로 맞춘 뒤 다듬어 저장한다(옛 행은 백필) — 같은 순서로 맞추고, 첨부 쪽도 NFC 로 견준다
  const decoded = [ref, decode(ref), lenientDecode(ref)].map((d) => d.normalize("NFC"));
  const sanitized = decoded.filter((d) => !sanitizesToBlank(d)).map(sanitizeAttachmentName);
  for (const name of new Set([...decoded, ...sanitized])) {
    const found = attachments.find((a) => a.name.normalize("NFC") === name);
    if (found) return { kind: "attachment", attachment: found };
  }
  const byId = attachments.find((a) => a.id === ref.toLowerCase());
  return byId ? { kind: "attachment", attachment: byId } : { kind: "missing" };
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

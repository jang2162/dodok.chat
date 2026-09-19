import { MENTION_TOKEN_RE } from "@dodok/shared";

/** MessageBody 가 해시 링크를 멘션 칩으로 바꿀 때 쓰는 접두사 — `#mention-<a|u>-<id>` */
export const MENTION_HREF_PREFIX = "#mention-";

/**
 * 저장 본문의 멘션 토큰(`<@a:id>`·`<@u:id>`)을 해시 링크 `[@handle](#mention-a-<id>)` 로 바꾼다(스펙 5.2).
 * 렌더러(Streamdown)가 링크로 만들면 MessageBody 가 그 자리에 MentionChip 을 끼운다. 모르는 id 는 「@알 수 없음」
 */
export function mentionsToMarkdown(
  bodyMd: string,
  resolve: (kind: "a" | "u", id: string) => string | undefined,
): string {
  return bodyMd.replace(new RegExp(MENTION_TOKEN_RE.source, "g"), (_, kind: "a" | "u", id: string) => {
    const handle = resolve(kind, id);
    return `[@${handle ?? "알 수 없음"}](${MENTION_HREF_PREFIX}${kind}-${id})`;
  });
}

import { MENTION_TOKEN_RE } from "@dodok/shared";

/**
 * MessageBody 가 해시 링크를 멘션 칩으로 바꿀 때 쓰는 접두사 — `#mention-<nonce>-<a|u>-<id>`. nonce 는 페이지를 열 때마다
 * 새로 뽑는다: 본문에 손으로 쓴 해시 링크(`](#mention-…`·`](<#mention-…>)`·문자 참조 등 어떤 표기든)는 이 값을 알 수 없어
 * 칩이 되지 않는다 — 칩은 서버가 릴레이하는 진짜 토큰만(web-t7 리뷰 m1). 보안 경계가 아니라 표시 구분이라 암호 강도는 필요 없다
 */
export const MENTION_HREF_PREFIX = `#mention-${crypto.getRandomValues(new Uint32Array(2)).join("")}-`;

/**
 * 저장 본문의 멘션 토큰(`<@a:id>`·`<@u:id>`)을 해시 링크 `[@handle](<접두사>a-<id>)` 로 바꾼다(스펙 5.2).
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

import { memo, useMemo } from "react";
import { type Components, defaultRehypePlugins, Streamdown } from "streamdown";
import { MENTION_HREF_PREFIX, mentionsToMarkdown } from "./mentionMarkdown";
import { MentionChip } from "./MentionChip";
import { useAuthors } from "./useAuthors";

/**
 * 원시 HTML 을 끈다 — Streamdown 기본 rehype 목록의 `raw`(rehype-raw)를 빼면 HTML 은 글자 그대로 남는다.
 * sanitize(허용 목록)·harden(javascript: 등 위험한 링크 차단, 해시 링크는 통과)은 그대로 둔다
 */
const REHYPE = [defaultRehypePlugins.sanitize, defaultRehypePlugins.harden].filter(
  (p): p is NonNullable<typeof p> => p !== undefined,
);
const CONTROLS = { code: { copy: true, download: false }, table: false, mermaid: false, image: false };
const TRANSLATIONS = { copyCode: "코드 복사", copied: "복사됨" };

const COMPONENTS: Components = {
  a: ({ href, children }) =>
    href?.startsWith(MENTION_HREF_PREFIX) ? (
      <MentionChip
        kind={href.slice(MENTION_HREF_PREFIX.length, MENTION_HREF_PREFIX.length + 1) as "a" | "u"}
        id={href.slice(MENTION_HREF_PREFIX.length + 2)}
        label={children}
      />
    ) : (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
        {children}
      </a>
    ),
};

/**
 * 메시지 본문(스펙 5.2) — Streamdown 으로만 그린다. 멘션 토큰은 해시 링크로 바꿔 넣고, 그 링크를 MentionChip 으로 그린다.
 * 링크는 새 탭. `streaming` 은 태스크 8 버블(미완성 마크다운 보정), 확정 메시지는 static
 */
export const MessageBody = memo(function MessageBody({
  bodyMd,
  streaming = false,
}: {
  bodyMd: string;
  streaming?: boolean;
}) {
  const { mention } = useAuthors();
  const markdown = useMemo(() => mentionsToMarkdown(bodyMd, mention), [bodyMd, mention]);
  return (
    <Streamdown
      className="text-[15px] leading-normal break-words"
      mode={streaming ? "streaming" : "static"}
      rehypePlugins={REHYPE}
      components={COMPONENTS}
      controls={CONTROLS}
      translations={TRANSLATIONS}
      linkSafety={{ enabled: false }}
    >
      {markdown}
    </Streamdown>
  );
});

import { createContext, memo, useContext, useMemo } from "react";
import { type Components, defaultRehypePlugins, defaultRemarkPlugins, Streamdown } from "streamdown";
import { MENTION_HREF_PREFIX, mentionsToMarkdown } from "./mentionMarkdown";
import { MentionChip } from "./MentionChip";
import { remarkSoftBreaks } from "./softBreaks";
import { useAuthors } from "./useAuthors";

/**
 * 원시 HTML 을 끈다 — Streamdown 기본 rehype 목록의 `raw`(rehype-raw)를 빼면 HTML 은 글자 그대로 남는다.
 * sanitize(허용 목록)·harden(javascript: 등 위험한 링크 차단, 해시 링크는 통과)은 그대로 둔다
 */
const REHYPE = [defaultRehypePlugins.sanitize, defaultRehypePlugins.harden].filter(
  (p): p is NonNullable<typeof p> => p !== undefined,
);
/** Streamdown 기본(gfm·코드 메타) 뒤에 단일 개행 → 줄바꿈 */
const REMARK = [...Object.values(defaultRemarkPlugins), remarkSoftBreaks];
const CONTROLS = { code: { copy: true, download: false }, table: false, mermaid: false, image: false };
const TRANSLATIONS = { copyCode: "코드 복사", copied: "복사됨" };

/** 링크 안인가 — 링크 안 이미지(`[![배지](…)](…)`)가 `<a>` 안에 `<a>` 를 또 만들지 않게 */
const InLink = createContext(false);

/**
 * 마크다운 이미지는 불러오지 않는다(추적 픽셀·프라이버시. 첨부·이미지는 Phase 2 — web-t7 리뷰 m12). 대신 새 탭으로
 * 여는 링크 「이미지: <alt 또는 주소>」. 링크 안이면 바깥 링크가 있으니 글자만
 */
function MarkdownImage({ src, alt }: { src?: unknown; alt?: string }) {
  const inLink = useContext(InLink);
  const url = typeof src === "string" && src ? src : undefined;
  const label = `이미지: ${alt || url || "주소 없음"}`;
  if (!url || inLink) return <span className="text-muted-foreground">{label}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline">
      {label}
    </a>
  );
}

const COMPONENTS: Components = {
  a: ({ href, children }) =>
    href?.startsWith(MENTION_HREF_PREFIX) ? (
      <MentionChip
        kind={href.slice(MENTION_HREF_PREFIX.length, MENTION_HREF_PREFIX.length + 1) as "a" | "u"}
        id={href.slice(MENTION_HREF_PREFIX.length + 2)}
      />
    ) : (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
        <InLink.Provider value>{children}</InLink.Provider>
      </a>
    ),
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
};

/**
 * 메시지 본문(스펙 5.2) — Streamdown 으로만 그린다. 멘션 토큰은 해시 링크로 바꿔 넣고, 그 링크를 MentionChip 으로 그린다.
 * 링크는 새 탭, 이미지는 불러오지 않고 링크로만, 단일 개행은 줄바꿈.
 * `streaming` 은 태스크 8 버블(미완성 마크다운 보정), 확정 메시지는 static
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
      remarkPlugins={REMARK}
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

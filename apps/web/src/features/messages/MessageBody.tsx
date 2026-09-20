import { type ReactNode, createContext, memo, useContext, useMemo } from "react";
import { cn } from "@/lib/utils";
import { cjk } from "@streamdown/cjk";
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
/**
 * 한국어 강조(`**"인용"**은`)를 살린다 — CommonMark 의 좌우 플랭킹 규칙은 한글을 「구두점도 공백도 아닌 글자」로 보아
 * 닫는 `**` 뒤에 조사가 붙으면 강조를 풀어 버린다. remark-cjk-friendly 는 gfm 앞에, 취소선·자동 링크 보정은 gfm 뒤에
 * 와야 해서 remarkPlugins 배열에 직접 끼우지 않고 Streamdown 의 plugins 로 넘긴다 — 그쪽이 앞뒤를 갈라 끼운다
 */
const PLUGINS = { cjk };
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

/** 메시지 한 덩어리 — 해시 링크는 이 안에서 대상을 찾는다(각주는 메시지마다 같은 id 를 쓴다) */
const MESSAGE_ROOT = "article, [role='note'], [data-run-id]";

/**
 * 같은 메시지 안을 가리키는 해시 링크(각주 `#user-content-fn-1`·되돌아가기 `#…-fnref-1`).
 * 새 탭으로 열지 않고 그 자리로 옮긴다 — 주소(라우터 상태)는 건드리지 않는다. 대상이 없으면 브라우저에 맡긴다
 */
function HashLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="text-primary underline"
      onClick={(e) => {
        const id = decodeURIComponent(href.slice(1));
        const root = e.currentTarget.closest(MESSAGE_ROOT) ?? document;
        const target = [...root.querySelectorAll("[id]")].find((el) => el.id === id);
        if (!id || !target) return;
        e.preventDefault();
        target.scrollIntoView({ block: "center" });
      }}
    >
      <InLink.Provider value>{children}</InLink.Provider>
    </a>
  );
}

const COMPONENTS: Components = {
  a: ({ href, children }) => {
    if (href?.startsWith(MENTION_HREF_PREFIX)) {
      return (
        <MentionChip
          kind={href.slice(MENTION_HREF_PREFIX.length, MENTION_HREF_PREFIX.length + 1) as "a" | "u"}
          id={href.slice(MENTION_HREF_PREFIX.length + 2)}
        />
      );
    }
    if (href?.startsWith("#")) return <HashLink href={href}>{children}</HashLink>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
        <InLink.Provider value>{children}</InLink.Provider>
      </a>
    );
  },
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
};

/**
 * 메시지 본문(스펙 5.2) — Streamdown 으로만 그린다. 멘션 토큰은 해시 링크로 바꿔 넣고, 그 링크를 MentionChip 으로 그린다.
 * 링크는 새 탭, 이미지는 불러오지 않고 링크로만, 단일 개행은 줄바꿈.
 * `streaming` 은 태스크 8 버블(미완성 마크다운 보정), 확정 메시지는 static.
 * `caret` 이면 Streamdown 이 마지막 블록 끝에 커서 글자를 붙인다(코드·표가 마지막이면 스스로 끈다) — 한 줄을 더 차지하지 않는다
 */
export const MessageBody = memo(function MessageBody({
  bodyMd,
  streaming = false,
  caret = false,
}: {
  bodyMd: string;
  streaming?: boolean;
  caret?: boolean;
}) {
  const { mention } = useAuthors();
  const markdown = useMemo(() => mentionsToMarkdown(bodyMd, mention), [bodyMd, mention]);
  return (
    <Streamdown
      className={cn(
        "text-[15px] leading-normal break-words",
        // 커서는 Streamdown 이 마지막 블록의 ::after 로 그린다 — 깜빡임만 우리가 얹는다(모션 허용일 때만)
        caret &&
          "[&>*:last-child]:after:text-muted-foreground motion-safe:[&>*:last-child]:after:animate-pulse",
      )}
      mode={streaming ? "streaming" : "static"}
      {...(caret ? { caret: "block" as const, isAnimating: true } : {})}
      remarkPlugins={REMARK}
      rehypePlugins={REHYPE}
      plugins={PLUGINS}
      components={COMPONENTS}
      controls={CONTROLS}
      translations={TRANSLATIONS}
      linkSafety={{ enabled: false }}
    >
      {markdown}
    </Streamdown>
  );
});

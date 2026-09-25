import { SEARCH_SNIPPET_CLOSE, SEARCH_SNIPPET_OPEN } from "@dodok/shared";

export type SnippetPart = { text: string; mark: boolean };

/**
 * 서버 스니펫(일치 부분을 STX·ETX 로 감싼 평문, 스레드·검색 스펙 5.2)을 글자 조각으로 나눈다. 표시 문자는 조각에 남기지 않는다 —
 * 짝이 맞지 않으면 여는 표시는 끝까지 강조, 짝 없는 닫는 표시는 버린다. 이웃한 같은 종류 조각은 하나로 합친다
 */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let mark = false;
  let text = "";
  const flush = () => {
    if (text === "") return;
    const last = parts.at(-1);
    if (last && last.mark === mark) last.text += text;
    else parts.push({ text, mark });
    text = "";
  };
  for (const ch of snippet) {
    if (ch === SEARCH_SNIPPET_OPEN || ch === SEARCH_SNIPPET_CLOSE) {
      flush();
      mark = ch === SEARCH_SNIPPET_OPEN;
    } else text += ch;
  }
  flush();
  return parts;
}

/** 스니펫을 글자로 그린다 — HTML 로 해석하지 않는다(`dangerouslySetInnerHTML` 없음). 일치 부분은 `<mark>` */
export function Snippet({ text }: { text: string }) {
  return (
    <>
      {snippetParts(text).map((p, i) =>
        p.mark ? (
          <mark key={i} className="rounded-sm bg-yellow-200/70 px-0.5 text-inherit dark:bg-yellow-500/30">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

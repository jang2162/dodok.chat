/** mdast 에서 쓰는 만큼만 — 텍스트는 value, 부모는 children */
type MdNode = { type: string; value?: string; children?: MdNode[] };

const NEWLINE = /\r\n|\r|\n/;

/**
 * 문단 안 단일 개행(soft break)을 줄바꿈(`break` → `<br>`)으로 보인다 — 메신저 관습(작성기 Shift+Enter·에이전트 답,
 * web-t9 리뷰 R1). 텍스트 노드만 바꾼다: 코드 블록(`code`)·인라인 코드(`inlineCode`)는 value 만 가진 노드라 그대로이고,
 * 빈 줄로 나눈 문단도 그대로다. bodyMd 원문은 건드리지 않는다
 */
export function remarkSoftBreaks() {
  return (tree: MdNode): void => {
    splitText(tree);
  };
}

function splitText(node: MdNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type !== "text" || !child.value || !NEWLINE.test(child.value)) {
      splitText(child);
      return [child];
    }
    return child.value
      .split(NEWLINE)
      .flatMap((part, i) => [
        ...(i > 0 ? [{ type: "break" }] : []),
        ...(part ? [{ type: "text", value: part }] : []),
      ]);
  });
}

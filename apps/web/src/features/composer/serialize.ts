import type { JSONContent } from "@tiptap/core";

/**
 * Tiptap 문서 → 서버가 받는 토큰 본문(bodyMd, 스펙 5.1). 멘션은 `<@a:id>`/`<@u:id>`(shared MENTION_TOKEN_RE),
 * 나머지는 마크다운. 빈 블록은 버리고 앞뒤 공백을 자른다 — 공백뿐이면 `""`(작성기는 보내지 않는다)
 */
export function toBodyMd(doc: JSONContent): string {
  return blocks(doc.content).trim();
}

const blocks = (content?: JSONContent[]): string =>
  (content ?? [])
    .map(block)
    .filter((s) => s.trim() !== "")
    .join("\n\n");

function block(n: JSONContent): string {
  switch (n.type) {
    case "codeBlock":
      return `\`\`\`${(n.attrs?.language as string | null | undefined) ?? ""}\n${plain(n.content)}\n\`\`\``;
    case "bulletList":
      return (n.content ?? []).map((li) => `- ${item(li)}`).join("\n");
    case "orderedList": {
      const start = (n.attrs?.start as number | undefined) ?? 1;
      return (n.content ?? []).map((li, i) => `${start + i}. ${item(li)}`).join("\n");
    }
    case "blockquote":
      return blocks(n.content)
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    default:
      return escapeBlockStarts(inline(n.content));
  }
}

/**
 * 줄 머리의 블록 시작 표시(`#`·`>`·`-`·`+`·`*`·`1.`·`1)`)를 이스케이프한다. 작성기는 제목 확장이 꺼져 있어
 * 사용자가 친 `# 제목` 은 평문인데 받은 쪽에서 H1 로 커졌다(브라우저 검증 결함 3).
 * 목록·인용·코드 블록은 실제 노드에서 나오므로(위 `block`) 여기를 지나지 않고, 인라인 코드는 백틱으로
 * 시작해 줄 머리에 걸리지 않는다. 표시 문자 하나만 막으면 나머지 줄은 그대로 평문이 된다
 */
const BLOCK_START = /^([ \t]{0,3})(?:(#{1,6}(?=[ \t]|$)|>|[-+*](?=[ \t]|$))|(\d{1,9})([.)](?=[ \t]|$)))/;

const escapeBlockStarts = (s: string): string =>
  s
    .split("\n")
    .map((line) =>
      line.replace(BLOCK_START, (_m, indent: string, mark?: string, num?: string, delim?: string) =>
        mark === undefined ? `${indent}${num}\\${delim}` : `${indent}\\${mark}`,
      ),
    )
    .join("\n");

/** 목록 항목 안의 블록은 줄로 잇고, 둘째 줄부터 들여 쓴다(안에 든 목록 포함) */
const item = (li: JSONContent) => (li.content ?? []).map(block).join("\n").replace(/\n/g, "\n  ");
const plain = (content?: JSONContent[]) => (content ?? []).map((n) => n.text ?? "").join("");
const inline = (content?: JSONContent[]): string => (content ?? []).map(node).join("");

function node(n: JSONContent): string {
  if (n.type === "mention") {
    const id = String(n.attrs?.id ?? "");
    // 후보 목록에서 온 멘션만 토큰이 된다. 밖에서 붙여 넣은 멘션 모양은 평문으로 둔다
    return /^[au]:/.test(id) ? `<@${id}>` : `@${String(n.attrs?.label ?? id)}`;
  }
  if (n.type === "hardBreak") return "\n";
  if (n.type === "text") return (n.marks ?? []).reduce((s, m) => wrap(s, m.type), n.text ?? "");
  return inline(n.content);
}

const EMPHASIS: Record<string, string> = { bold: "**", italic: "*", strike: "~~" };

function wrap(s: string, mark: string): string {
  if (mark === "code") return `\`${s}\``;
  const marker = EMPHASIS[mark];
  if (!marker) return s;
  // 강조 표시 안쪽이 공백으로 시작·끝나면 마크다운이 강조로 보지 않는다 — 공백은 밖으로 뺀다
  const [, lead = "", core = "", trail = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(s) ?? [];
  return core ? `${lead}${marker}${core}${marker}${trail}` : s;
}

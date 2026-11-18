import type { JSONContent } from "@tiptap/core";

/**
 * 초안이 부르는 에이전트 id — `mention` 노드의 `attrs.id` 가 `a:<id>` 인 것(목록·인용 안 중첩 포함). 사람(`u:`)과 손으로 친
 * `@글자` 는 뺀다. 작성기 알약의 「이 글에서 부름」 강조가 쓴다(작성기 도구 줄 스펙 T6)
 */
export function mentionedAgentIds(doc: JSONContent): ReadonlySet<string> {
  const ids = new Set<string>();
  const walk = (node: JSONContent) => {
    if (node.type === "mention") {
      const id = node.attrs?.["id"];
      if (typeof id === "string" && id.startsWith("a:")) ids.add(id.slice(2));
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return ids;
}

/** 두 집합이 같은가 — 같으면 작성기가 상태를 바꾸지 않는다(입력마다 다시 그리지 않게) */
export function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

import type { JSONContent } from "@tiptap/core";

export type SlashCommand =
  | { kind: "stop" }
  | { kind: "new"; agentId: string }
  | { kind: "invalid"; message: string }
  | null;

/**
 * 슬래시 커맨드(스펙 5.1) — 문서 첫 문단의 첫 텍스트가 `/stop`·`/new` 로 시작할 때만. 알 수 없는 `/…` 는 null 이라
 * 일반 메시지로 보낸다(경로·URL 을 막지 않게). 둘 다 메시지로 보내지 않는다
 */
export function parseSlash(doc: JSONContent): SlashCommand {
  const first = doc.content?.[0];
  if (first?.type !== "paragraph") return null;
  const nodes = first.content ?? [];
  const head = nodes[0];
  if (head?.type !== "text" || !head.text?.startsWith("/")) return null;
  const word = head.text.split(/\s/, 1)[0];
  if (word === "/stop") return { kind: "stop" };
  if (word !== "/new") return null;
  const target = nodes.find((n) => n.type === "mention");
  const id = String(target?.attrs?.id ?? "");
  return id.startsWith("a:")
    ? { kind: "new", agentId: id.slice(2) }
    : { kind: "invalid", message: "/new 뒤에 @에이전트를 붙이세요" };
}

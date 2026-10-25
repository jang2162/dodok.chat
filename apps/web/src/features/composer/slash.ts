import type { JSONContent } from "@tiptap/core";

export type SlashCommand = { kind: "stop" } | null;

/**
 * 슬래시 커맨드(스펙 5.1) — 문서 첫 문단의 첫 텍스트가 `/stop` 으로 시작할 때만. 알 수 없는 `/…` 는 null 이라
 * 일반 메시지로 보낸다(경로·URL 을 막지 않게). `/stop` 은 메시지로 보내지 않는다
 */
export function parseSlash(doc: JSONContent): SlashCommand {
  const first = doc.content?.[0];
  if (first?.type !== "paragraph") return null;
  const head = first.content?.[0];
  if (head?.type !== "text" || !head.text?.startsWith("/")) return null;
  return head.text.split(/\s/, 1)[0] === "/stop" ? { kind: "stop" } : null;
}

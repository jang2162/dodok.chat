/**
 * 인바운드 첨부 → OpenClaw media facts(스펙 5.1). SDK 는 deps 로 받는다 — `openclaw` 를 import 하지 않는다.
 * 이미지만 받아 Gateway 미디어 저장소에 두고, 이미지가 아닌 첨부와 실패는 본문 끝 줄로 알린다. 런은 막지 않는다.
 */
import { type Attachment, parseArtifactUrl } from "@dodok/shared";

/** `toInboundMediaFacts` 입력. `url` 은 넣지 않는다 — 전사에 남는다 */
export type InboundFact = { path: string; contentType: string; fileName: string; kind: "image" };
export type InboundMediaDeps = {
  download(id: string): Promise<{ bytes: Buffer; mime: string }>;
  save(bytes: Buffer, mime: string, name: string): Promise<{ path: string; contentType?: string }>;
};

export async function prepareInboundMedia(
  atts: readonly Attachment[],
  deps: InboundMediaDeps,
): Promise<{ facts: InboundFact[]; notes: string[] }> {
  const facts: InboundFact[] = [];
  const notes: string[] = [];
  for (const a of atts) {
    if (a.kind !== "image") {
      notes.push(`[첨부 파일: ${a.name}]`);
      continue;
    }
    const id = parseArtifactUrl(a.url);
    try {
      if (!id) throw new Error("not an attachment id");
      const { bytes } = await deps.download(id);
      // MIME 은 서버 기록(a.mime)이 정본 — 매직 바이트로 정해졌다
      const saved = await deps.save(bytes, a.mime, a.name);
      facts.push({
        path: saved.path,
        contentType: saved.contentType ?? a.mime,
        fileName: a.name,
        kind: "image",
      });
    } catch {
      notes.push(`[이미지를 불러오지 못했습니다: ${a.name}]`);
    }
  }
  return { facts, notes };
}

/** 본문 끝에 알림 줄을 붙인다 — 본문이 비면 줄만, 있으면 빈 줄 하나 뒤에 */
export function appendNotes(body: string, notes: readonly string[]): string {
  if (notes.length === 0) return body;
  return body ? `${body}\n\n${notes.join("\n")}` : notes.join("\n");
}

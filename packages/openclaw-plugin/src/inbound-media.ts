/**
 * 인바운드 첨부 → OpenClaw media facts(스펙 5.1). SDK 는 deps 로 받는다 — `openclaw` 를 import 하지 않는다.
 * 이미지만 받아 Gateway 미디어 저장소에 두고, 이미지가 아닌 첨부와 실패는 본문 끝 줄로 알린다. 런은 막지 않는다.
 */
import { ATTACHMENT_LIMITS, type Attachment, parseArtifactUrl } from "@dodok/shared";
import { MediaHttpError } from "./media-http";

/** `toInboundMediaFacts` 입력. `url` 은 넣지 않는다 — 전사에 남는다 */
export type InboundFact = { path: string; contentType: string; fileName: string; kind: "image" };
export type InboundMediaDeps = {
  download(id: string): Promise<{ bytes: Buffer; mime: string }>;
  save(bytes: Buffer, mime: string, name: string): Promise<{ path: string; contentType?: string }>;
};

/**
 * `saveMediaBuffer(buffer, contentType, subdir, maxBytes, originalFilename)` 인자. maxBytes 를 반드시 준다 — 기본 5 MB 에
 * 기대지 않는다. 릴레이된 에이전트 이미지도 오므로 에이전트 상한으로(6 MiB 넘는 이미지는 Gateway 가 재압축한다, 스파이크 1-12)
 */
export const inboundSaveArgs = (bytes: Buffer, mime: string, name: string) =>
  [bytes, mime, "inbound", ATTACHMENT_LIMITS.agentFileMaxBytes, name] as const;

/** 실패 단계와 경로 없는 종류 — 로그용(`url:…`·`download:http-404`·`save:too-large`·`download:TimeoutError`) */
class InboundStepError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
function kindOf(err: unknown): string {
  if (err instanceof MediaHttpError && err.status !== undefined) return `http-${err.status}`;
  const code = (err as { code?: unknown } | undefined)?.code;
  if (typeof code === "string") return code;
  return err instanceof Error ? err.name : "unknown";
}
async function step<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new InboundStepError(`${stage}:${kindOf(err)}`);
  }
}

async function fetchImage(a: Attachment, deps: InboundMediaDeps): Promise<InboundFact> {
  const id = parseArtifactUrl(a.url);
  if (!id) throw new InboundStepError("url:not-attachment-id");
  const { bytes } = await step("download", () => deps.download(id));
  // MIME 은 서버 기록(a.mime)이 정본 — 매직 바이트로 정해졌다
  const saved = await step("save", () => deps.save(bytes, a.mime, a.name));
  return { path: saved.path, contentType: saved.contentType ?? a.mime, fileName: a.name, kind: "image" };
}

/** 이미지는 한꺼번에 받아 저장한다(인바운드 ack 전에 끝나야 한다). facts·notes 는 첨부 순서 그대로 */
export async function prepareInboundMedia(
  atts: readonly Attachment[],
  deps: InboundMediaDeps,
): Promise<{ facts: InboundFact[]; notes: string[]; reasons: string[] }> {
  const settled = await Promise.allSettled(
    atts.map((a) => (a.kind === "image" ? fetchImage(a, deps) : Promise.resolve(null))),
  );
  const facts: InboundFact[] = [];
  const notes: string[] = [];
  const reasons: string[] = [];
  for (const [i, r] of settled.entries()) {
    const a = atts[i]!;
    if (r.status === "rejected") {
      notes.push(`[이미지를 불러오지 못했습니다: ${a.name}]`);
      reasons.push(r.reason instanceof InboundStepError ? r.reason.reason : "unknown");
    } else if (r.value) facts.push(r.value);
    else notes.push(`[첨부 파일: ${a.name}]`);
  }
  return { facts, notes, reasons };
}

/** 본문 끝에 알림 줄을 붙인다 — 본문이 비면 줄만, 있으면 빈 줄 하나 뒤에 */
export function appendNotes(body: string, notes: readonly string[]): string {
  if (notes.length === 0) return body;
  return body ? `${body}\n\n${notes.join("\n")}` : notes.join("\n");
}

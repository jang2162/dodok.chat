/**
 * 에이전트 미디어 → 서버 첨부(스펙 5.2). SDK 로더·업로더는 deps 로 받는다 — `openclaw` 를 import 하지 않는다.
 * 원천(`src`)은 Gateway 호스트 경로이거나 URL 이다. 경로는 어떤 텍스트에도 싣지 않는다 — 이름은 basename,
 * 채널·툴로 가는 사유는 고정 문구뿐이고 원문(가린 것)은 로그용 `detail` 에만 둔다.
 */
import { ATTACHMENT_LIMITS, sanitizeAttachmentName } from "@dodok/shared";
import { MediaHttpError } from "./media-http";

export type MediaSource = { src: string; name?: string };
/** `reason` 은 채널 본문·툴 오류에 싣는 고정 문구, `detail` 은 로그에만 싣는 원문(호스트 경로를 가린 것) */
export type MediaFailure = { name: string; reason: string; detail: string };

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

function dedupe(items: MediaSource[]): MediaSource[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.src) ? false : (seen.add(i.src), true)));
}

/** `message` 툴 인자 — `mediaUrls` 가 비어 있지 않으면 그것, 아니면 `media`. 표시 이름 `filename` 은 첫 파일에 */
export function collectToolMediaSources(params: Record<string, unknown>): MediaSource[] {
  const urls = Array.isArray(params["mediaUrls"]) ? params["mediaUrls"].flatMap((v) => str(v) ?? []) : [];
  const list = urls.length > 0 ? urls : [str(params["media"])].flatMap((v) => v ?? []);
  const items = dedupe(list.map((src) => ({ src })));
  const filename = str(params["filename"]);
  if (filename && items[0]) items[0] = { ...items[0], name: filename };
  return items;
}

/** 최종 응답 `deliver` payload — `mediaUrls ?? [mediaUrl]`, 이름은 `attachments[i].name` */
export function collectDeliverMediaSources(payload: {
  mediaUrls?: unknown;
  mediaUrl?: unknown;
  attachments?: unknown;
}): MediaSource[] {
  const urls = Array.isArray(payload.mediaUrls)
    ? payload.mediaUrls.flatMap((v) => str(v) ?? [])
    : [str(payload.mediaUrl)].flatMap((v) => v ?? []);
  const meta: unknown[] = Array.isArray(payload.attachments) ? payload.attachments : [];
  return dedupe(
    urls.map((src, i) => {
      const name = str((meta[i] as { name?: unknown } | undefined)?.name);
      return name ? { src, name } : { src };
    }),
  );
}

/** 한 메시지 안에서 겹치는 이름에 확장자 앞 ` (2)`·` (3)` */
export function uniqueNames(names: readonly string[]): string[] {
  const used = new Map<string, number>();
  return names.map((n) => {
    const count = (used.get(n) ?? 0) + 1;
    used.set(n, count);
    if (count === 1) return n;
    const dot = n.lastIndexOf(".");
    return dot > 0 ? `${n.slice(0, dot)} (${count})${n.slice(dot)}` : `${n} (${count})`;
  });
}

/**
 * 오류 원문 속 호스트 경로를 `<경로>` 로 가린다 — 로그 방어용이다. 못 잡는 꼴이 있어(`ENOENT:/x`·백틱 등) 채널·툴 문구에는
 * 원문을 아예 싣지 않는다(`loadFailureReason`·`uploadFailureReason`).
 * 공백·따옴표·괄호 뒤에서 `/`·`\`·`~/`·`C:\`·`file://` 로 시작하면 다음 따옴표나 줄 끝까지 — 경로에 공백이 있어도 꼬리가 새지 않게.
 * `https://…` 의 `//` 는 `:` 뒤라 건드리지 않는다
 */
export function maskHostPaths(text: string): string {
  return text.replace(/(^|[\s'"(=,;])(?:file:\/\/|[A-Za-z]:[\\/]|~[\\/]|[\\/])[^'"\n]*/g, "$1<경로>");
}

const DETAIL_MAX = 120;
const detailOf = (err: unknown): string =>
  maskHostPaths(String((err as Error | undefined)?.message ?? err)).slice(0, DETAIL_MAX);
const basename = (src: string) => src.split("?")[0]!.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
const mib = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MiB`;
const codeOf = (v: unknown): unknown => (v as { code?: unknown } | undefined)?.code;

/**
 * 로더(`loadWebMediaRaw`) 실패 → 고정 문구. 9.4 `LocalMediaAccessError.code` 로만 가른다 — 로더 크기 초과는 코드 없는
 * `Error` 에 `cause.code === "too-large"`(FsSafeError) 로 온다
 */
export function loadFailureReason(err: unknown, maxBytes: number): string {
  const code = codeOf(err);
  if (code === "not-found") return "파일을 찾을 수 없음";
  if (code === "path-not-allowed" || code === "network-path-not-allowed") return "허용되지 않은 경로";
  if (code === undefined && codeOf((err as { cause?: unknown } | undefined)?.cause) === "too-large")
    return `${mib(maxBytes)} 초과`;
  return "파일을 읽지 못함";
}

/** 업로드 실패 → 고정 문구. HTTP 상태만 싣는다 */
export function uploadFailureReason(err: unknown): string {
  if (err instanceof MediaHttpError && err.status !== undefined)
    return err.status === 413 ? "서버 상한 초과" : `서버가 거절함 (${err.status})`;
  return "서버에 올리지 못함";
}

/** `deliver` 가 보낼지 — final 이고 텍스트나 미디어 중 하나라도 있으면(미디어 전용 응답도 보낸다, 스펙 5.2) */
export const shouldDeliverFinal = (kind: string, text: string, sourceCount: number): boolean =>
  kind === "final" && (text.trim() !== "" || sourceCount > 0);

/** 9.4 `OutboundMediaAccess` 와 같은 모양 — SDK 를 import 하지 않으려고 여기 둔다 */
export type MediaAccess = {
  localRoots?: readonly string[];
  readFile?: (filePath: string) => Promise<Buffer>;
  workspaceDir?: string;
};
/** `loadWebMediaRaw` 옵션 — 호스트 정책(`mediaAccess`)의 있는 키만 그대로 넘긴다. fs.readFile 직접 금지 */
export function loaderOptions(
  access: MediaAccess | undefined,
  maxBytes: number,
): MediaAccess & { maxBytes: number } {
  return {
    maxBytes,
    ...(access?.localRoots ? { localRoots: access.localRoots } : {}),
    ...(access?.readFile ? { readFile: access.readFile } : {}),
    ...(access?.workspaceDir ? { workspaceDir: access.workspaceDir } : {}),
  };
}

export type OutboundMediaDeps = {
  load(src: string): Promise<{ bytes: Buffer; contentType?: string; fileName?: string }>;
  upload(bytes: Buffer, name: string, mime?: string): Promise<{ id: string }>;
  maxBytes: number;
};

type Loaded =
  | { ok: true; bytes: Buffer; mime?: string; name: string }
  | { ok: false; name: string; reason: string; detail: string };

/**
 * 원천마다 읽고(크기 검사) 올려 id 를 순서대로 모은다. 실패는 이름·고정 사유(+로그용 detail)로 모으고 나머지는 계속한다.
 * 메시지당 상한을 넘는 원천은 읽지 않는다 — `OutboundMessage.attachmentIds` 가 상한을 넘으면 메시지 전체가 거부된다
 */
export async function uploadOutboundMedia(
  items: readonly MediaSource[],
  deps: OutboundMediaDeps,
): Promise<{ ids: string[]; failures: MediaFailure[] }> {
  const loaded: Loaded[] = [];
  for (const [i, item] of items.entries()) {
    const guess = sanitizeAttachmentName(item.name ?? basename(item.src));
    if (i >= ATTACHMENT_LIMITS.perMessage) {
      const reason = `메시지당 ${ATTACHMENT_LIMITS.perMessage}개 초과`;
      loaded.push({ ok: false, name: guess, reason, detail: reason });
      continue;
    }
    try {
      const r = await deps.load(item.src);
      const name = sanitizeAttachmentName(item.name ?? r.fileName ?? basename(item.src));
      if (r.bytes.length > deps.maxBytes) {
        const reason = `${mib(deps.maxBytes)} 초과`;
        loaded.push({ ok: false, name, reason, detail: reason });
      } else
        loaded.push({ ok: true, bytes: r.bytes, ...(r.contentType ? { mime: r.contentType } : {}), name });
    } catch (err) {
      loaded.push({
        ok: false,
        name: guess,
        reason: loadFailureReason(err, deps.maxBytes),
        detail: detailOf(err),
      });
    }
  }
  const names = uniqueNames(loaded.map((l) => l.name));
  const ids: string[] = [];
  const failures: MediaFailure[] = [];
  for (const [i, l] of loaded.entries()) {
    const name = names[i] ?? l.name;
    if (!l.ok) {
      failures.push({ name, reason: l.reason, detail: l.detail });
      continue;
    }
    try {
      ids.push((await deps.upload(l.bytes, name, l.mime)).id);
    } catch (err) {
      failures.push({ name, reason: uploadFailureReason(err), detail: detailOf(err) });
    }
  }
  return { ids, failures };
}

/** `message` 툴 실패 — 모델이 보고 고칠 수 있게 툴 오류로 돌려준다 */
export const toolFailureMessage = (f: readonly MediaFailure[]): string =>
  `dodok: 첨부를 보내지 못했습니다 — ${f.map((x) => `${x.name}: ${x.reason}`).join(", ")}`;
/** 최종 응답 실패 — 돌려줄 길이 없어 본문 끝에 붙인다 */
export const deliverFailureLine = (f: readonly MediaFailure[]): string =>
  `_첨부 ${f.length}개를 보내지 못했습니다: ${f.map((x) => `${x.name} (${x.reason})`).join(", ")}_`;

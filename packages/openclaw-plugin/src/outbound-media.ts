/**
 * 에이전트 미디어 → 서버 첨부(스펙 5.2). SDK 로더·업로더는 deps 로 받는다 — `openclaw` 를 import 하지 않는다.
 * 원천(`src`)은 Gateway 호스트 경로이거나 URL 이다. 경로는 어떤 텍스트에도 싣지 않는다 — 이름은 basename, 사유는 가린다.
 */
import { ATTACHMENT_LIMITS, sanitizeAttachmentName } from "@dodok/shared";

export type MediaSource = { src: string; name?: string };
export type MediaFailure = { name: string; reason: string };

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
 * 오류 사유 속 호스트 경로를 `<경로>` 로 가린다(Global Constraints — 경로는 어떤 텍스트에도 쓰지 않는다).
 * 공백·따옴표·괄호 뒤에서 `/`·`\`·`~/`·`C:\`·`file://` 로 시작하면 다음 따옴표나 줄 끝까지 — 경로에 공백이 있어도 꼬리가 새지 않게.
 * `https://…` 의 `//` 는 `:` 뒤라 건드리지 않는다
 */
export function maskHostPaths(text: string): string {
  return text.replace(/(^|[\s'"(=,;])(?:file:\/\/|[A-Za-z]:[\\/]|~[\\/]|[\\/])[^'"\n]*/g, "$1<경로>");
}

const REASON_MAX = 120;
const reasonOf = (err: unknown): string =>
  maskHostPaths(String((err as Error | undefined)?.message ?? err)).slice(0, REASON_MAX);
const basename = (src: string) => src.split("?")[0]!.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
const mib = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MiB`;

export type OutboundMediaDeps = {
  load(src: string): Promise<{ bytes: Buffer; contentType?: string; fileName?: string }>;
  upload(bytes: Buffer, name: string, mime?: string): Promise<{ id: string }>;
  maxBytes: number;
};

type Loaded =
  | { ok: true; bytes: Buffer; mime?: string; name: string }
  | { ok: false; name: string; reason: string };

/**
 * 원천마다 읽고(크기 검사) 올려 id 를 순서대로 모은다. 실패는 이름·짧은 사유로 모으고 나머지는 계속한다.
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
      loaded.push({ ok: false, name: guess, reason: `메시지당 ${ATTACHMENT_LIMITS.perMessage}개 초과` });
      continue;
    }
    try {
      const r = await deps.load(item.src);
      const name = sanitizeAttachmentName(item.name ?? r.fileName ?? basename(item.src));
      if (r.bytes.length > deps.maxBytes)
        loaded.push({ ok: false, name, reason: `${mib(deps.maxBytes)} 초과` });
      else loaded.push({ ok: true, bytes: r.bytes, ...(r.contentType ? { mime: r.contentType } : {}), name });
    } catch (err) {
      loaded.push({ ok: false, name: guess, reason: reasonOf(err) });
    }
  }
  const names = uniqueNames(loaded.map((l) => l.name));
  const ids: string[] = [];
  const failures: MediaFailure[] = [];
  for (const [i, l] of loaded.entries()) {
    const name = names[i] ?? l.name;
    if (!l.ok) {
      failures.push({ name, reason: l.reason });
      continue;
    }
    try {
      ids.push((await deps.upload(l.bytes, name, l.mime)).id);
    } catch (err) {
      failures.push({ name, reason: reasonOf(err) });
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

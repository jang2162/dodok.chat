/**
 * 서버가 품은 플러그인 tgz(설정 마법사 스펙 2.1·결정 4·5). 부팅 때 한 번 찾아 파일 sha256·크기와 **안의 번들**
 * (`package/dist/index.js`) sha256 을 잰다 — 플러그인이 hello 로 보내는 bundleSha256 과 비교하는 값은 tgz 전체가 아니라 이것이다.
 * tar 는 의존성 없이 읽는다(gunzip 뒤 512바이트 블록을 훑는다).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { isBundled } from "../../runtime";

/** npm·pnpm pack 이 만든 tgz 안의 번들 경로 */
export const PLUGIN_BUNDLE_ENTRY = "package/dist/index.js";

export type PluginFile = { path: string; sha256: string; bundleSha256: string; bytes: number };

const BLOCK = 512;

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** NUL 에서 끊은 문자열 필드 */
function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

/** pax 확장 헤더(`<len> key=value\n` 반복)에서 path */
function paxPath(body: Buffer): string | undefined {
  let path: string | undefined;
  for (const line of body.toString("utf8").split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(line);
    if (match) path = match[1];
  }
  return path;
}

/** tar(압축 푼 것)에서 이름이 name 인 일반 파일의 내용. 없거나 tar 가 망가졌으면 undefined */
export function tarEntry(tar: Buffer, name: string): Buffer | undefined {
  let offset = 0;
  let nextPath: string | undefined;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) return undefined; // 끝 표시
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) return undefined;
    const type = String.fromCharCode(header[156] ?? 0);
    const start = offset + BLOCK;
    const end = start + size;
    if (end > tar.length) return undefined;
    const body = tar.subarray(start, end);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      nextPath = paxPath(body);
      continue;
    }
    if (type === "g") continue; // 전역 pax — 이름과 무관
    const prefix = field(header, 345, 155);
    const path = nextPath ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    nextPath = undefined;
    if ((type === "0" || type === "\0") && path === name) return body;
  }
  return undefined;
}

/** 한 디렉터리에서 가장 최근 tgz. 디렉터리가 없으면 undefined */
function newestTgz(dir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".tgz"));
  } catch {
    return undefined;
  }
  let best: { path: string; mtime: number } | undefined;
  for (const n of names.sort()) {
    const path = join(dir, n);
    try {
      const st = statSync(path);
      if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { path, mtime: st.mtimeMs };
    } catch {
      // 읽는 사이 사라졌다 — 다음 것
    }
  }
  return best?.path;
}

/**
 * 후보 디렉터리를 차례로 보고 처음 찾은 tgz 를 잰다(한 디렉터리에 여럿이면 가장 최근 것).
 * tgz 가 없거나, gzip 이 아니거나, 안에 번들이 없으면 null — 받기 대신 만드는 법을 보이게 된다
 */
export function readPluginFile(candidates: string[]): PluginFile | null {
  for (const dir of candidates) {
    const path = newestTgz(dir);
    if (!path) continue;
    try {
      const bytes = readFileSync(path);
      const bundle = tarEntry(gunzipSync(bytes), PLUGIN_BUNDLE_ENTRY);
      if (!bundle) return null;
      return { path, sha256: sha256(bytes), bundleSha256: sha256(bundle), bytes: bytes.length };
    } catch {
      return null;
    }
  }
  return null;
}

/** 플러그인 tgz 를 찾을 곳 — DODOK_PLUGIN_DIR(이미지가 /app/plugin), 소스 실행이면 저장소의 플러그인 dist */
export function pluginDirCandidates(
  env: { DODOK_PLUGIN_DIR?: string | undefined },
  bundled = isBundled(),
): string[] {
  const dirs = env.DODOK_PLUGIN_DIR ? [env.DODOK_PLUGIN_DIR] : [];
  // 번들에서는 import.meta.url 기준 상대 경로가 저장소를 가리키지 않는다
  if (!bundled)
    dirs.push(fileURLToPath(new URL("../../../../../packages/openclaw-plugin/dist", import.meta.url)));
  return dirs;
}

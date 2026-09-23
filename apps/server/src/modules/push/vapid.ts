/** VAPID 키(스펙 5.1). 환경변수 둘이 다 있으면 그것, 아니면 <dataDir>/vapid.json(0600). 망가진 파일은 덮어쓰지 않고 던진다 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import { z } from "zod";

const Keys = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) });
export type VapidKeys = z.infer<typeof Keys>;

export function loadVapidKeys(opts: { dataDir: string; publicKey?: string; privateKey?: string }): VapidKeys {
  if (opts.publicKey && opts.privateKey) return { publicKey: opts.publicKey, privateKey: opts.privateKey };
  const path = join(opts.dataDir, "vapid.json");
  let raw: string | undefined;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (raw !== undefined) {
    const parsed = Keys.safeParse(safeJson(raw));
    if (!parsed.success)
      throw new Error(
        `${path}: VAPID 키 파일이 망가졌다 — 지우면 새로 만들지만 모든 푸시 구독이 무효가 된다`,
      );
    return parsed.data;
  }
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(opts.dataDir, { recursive: true });
  writeFileSync(path, JSON.stringify(keys), { mode: 0o600, flag: "wx" });
  return keys;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

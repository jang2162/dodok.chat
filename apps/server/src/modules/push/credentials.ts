/**
 * 네이티브 푸시 자격 증명 — 환경 변수가 파일보다 먼저다(네이티브 푸시 스펙 「자격 증명·설정」 장).
 * 못 쓰면 `{ off: <사유> }` 를 낸다. 사유는 고정 문구라 키·계정 값이 로그에 새지 않고, 부팅을 막지 않는다
 * (VAPID 와 다르다 — 네이티브 푸시가 없어도 서버는 돈다)
 */
import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export type ApnsCredentials = { key: KeyObject; keyId: string; teamId: string };

const ApnsConfigFile = z.object({ keyId: z.string().min(1), teamId: z.string().min(1) });

/** 파일이 없으면 undefined, 읽다 실패하면 던진다 — 없는 것과 못 읽는 것은 사유가 다르다 */
function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function loadApnsCredentials(opts: {
  dataDir: string;
  keyPath?: string;
  keyId?: string;
  teamId?: string;
}): ApnsCredentials | { off: string } {
  let pem: string | undefined;
  try {
    pem = readOptional(opts.keyPath ?? join(opts.dataDir, "apns", "key.p8"));
  } catch {
    return { off: "key unreadable" };
  }
  if (pem === undefined) return { off: "no key" };

  let keyId = opts.keyId;
  let teamId = opts.teamId;
  if (keyId === undefined || teamId === undefined) {
    let raw: string | undefined;
    try {
      raw = readOptional(join(opts.dataDir, "apns", "config.json"));
    } catch {
      return { off: "config unreadable" };
    }
    if (raw !== undefined) {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return { off: "invalid config" };
      }
      const parsed = ApnsConfigFile.safeParse(json);
      if (!parsed.success) return { off: "invalid config" };
      keyId ??= parsed.data.keyId;
      teamId ??= parsed.data.teamId;
    }
  }
  if (keyId === undefined) return { off: "no key id" };
  if (teamId === undefined) return { off: "no team id" };

  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    return { off: "invalid key" };
  }
  // APNs 토큰은 ES256(P-256) 만 받는다 — 다른 곡선·RSA 키는 첫 발송에서야 403 이 되므로 여기서 거른다
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    return { off: "invalid key" };
  return { key, keyId, teamId };
}

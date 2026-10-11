/** FCM 서비스 계정 로더(네이티브 푸시 스펙 「자격 증명·설정」 장) — 파일 하나를 읽어 키까지 검증한다 */
import { type KeyObject, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export type FcmCredentials = {
  projectId: string;
  clientEmail: string;
  privateKey: KeyObject;
  tokenUri: string;
};

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

const ServiceAccount = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
  token_uri: z.url().default(DEFAULT_TOKEN_URI),
});

/**
 * 환경 변수 경로가 파일(`DATA_DIR/fcm/service-account.json`)보다 우선한다. 못 읽거나 깨졌으면 `{ off }` — 네이티브 푸시가
 * 없어도 서버는 돌아야 해서 VAPID 와 달리 부팅을 막지 않는다. 사유는 고정 문구라 로그에 그대로 실어도 이메일·키 원문이 새지 않는다
 */
export function loadFcmCredentials(opts: {
  dataDir: string;
  path?: string;
}): FcmCredentials | { off: string } {
  const file = opts.path ?? join(opts.dataDir, "fcm", "service-account.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { off: "no service account" };
  }
  try {
    const sa = ServiceAccount.parse(JSON.parse(raw));
    const privateKey = createPrivateKey(sa.private_key);
    if (privateKey.asymmetricKeyType !== "rsa") return { off: "invalid service account" };
    return { projectId: sa.project_id, clientEmail: sa.client_email, privateKey, tokenUri: sa.token_uri };
  } catch {
    return { off: "invalid service account" };
  }
}

import { join } from "node:path";
import { Handle } from "@dodok/shared";
import { z } from "zod";

const Raw = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  APP_ORIGIN: z.url(),
  // 리버스 프록시 뒤면 "true" — 레이트리밋 키(request.ip)가 X-Forwarded-For 를 따른다
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  DATA_DIR: z.string().default("./data"),
  DB_PATH: z.string().optional(),
  // 첨부 블롭 디렉터리(스펙 4.1). 없으면 DATA_DIR/attachments
  ATTACHMENTS_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DODOK_WORKSPACE_NAME: z.string().min(1).max(80).default("dodok"),
  OWNER_HANDLE: Handle.default("owner"),
  LOCAL_AUTH_TOKEN: z.string().min(16),
  BETTER_AUTH_SECRET: z.string().min(32),
  OPENCLAW_TARGET: z.enum(["remote", "dev"]).default("remote"),
  OPENCLAW_GATEWAY_URL: z.url().optional(),
  OPENCLAW_GATEWAY_TOKEN: z.string().min(1).optional(),
  OPENCLAW_DEV_GATEWAY_URL: z.url().optional(),
  OPENCLAW_DEV_GATEWAY_TOKEN: z.string().min(1).optional(),
  OPENCLAW_DEVICE_IDENTITY_PATH: z.string().optional(),
  // 진단용 — 있으면 어댑터가 받은 Gateway chat·agent·session.message 프레임을 이 파일에 JSONL 로 append(본문 포함)
  OPENCLAW_FRAME_DUMP_PATH: z.string().optional(),
  BRIDGE_TOKEN: z.string().min(16),
  BRIDGE_PUBLIC_URL: z.url().optional(),
  // 웹 푸시(스펙 5.1). 키 둘이 다 있어야 쓰고, 아니면 DATA_DIR/vapid.json(없으면 만든다)
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  // 푸시 서비스가 연락할 주체 — web-push 가 mailto: 또는 https: 를 요구한다. 기본값은 개발용(isLocalVapidSubject)
  VAPID_SUBJECT: z
    .string()
    .refine(
      (s) => /^mailto:\S+$/.test(s) || /^https:\/\/\S+$/.test(s),
      "mailto: 또는 https:// 로 시작해야 한다",
    )
    .default("mailto:dodok@localhost"),
});

export type ServerConfig = z.infer<typeof Raw> & {
  dbPath: string;
  attachmentsDir: string;
  deviceIdentityPath: string;
  gateway: { url: string; token: string };
  vapid: { publicKey?: string; privateKey?: string; subject: string };
};

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  // .env 의 `KEY=` 는 빈 문자열로 들어온다. 설정하지 않은 것으로 봐야 기본값·optional 이 먹는다.
  const parsed = Raw.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    throw new Error(`설정 오류:\n${lines.join("\n")}`);
  }
  const c = parsed.data;
  const pair =
    c.OPENCLAW_TARGET === "dev"
      ? {
          url: c.OPENCLAW_DEV_GATEWAY_URL,
          token: c.OPENCLAW_DEV_GATEWAY_TOKEN,
          names: "OPENCLAW_DEV_GATEWAY_URL / OPENCLAW_DEV_GATEWAY_TOKEN",
        }
      : {
          url: c.OPENCLAW_GATEWAY_URL,
          token: c.OPENCLAW_GATEWAY_TOKEN,
          names: "OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN",
        };
  if (!pair.url || !pair.token) {
    throw new Error(`설정 오류: OPENCLAW_TARGET=${c.OPENCLAW_TARGET} 에는 ${pair.names} 가 필요하다`);
  }
  const suffix = c.OPENCLAW_TARGET === "dev" ? "-dev" : "";
  return {
    ...c,
    dbPath: c.DB_PATH ?? join(c.DATA_DIR, "dodok.sqlite"),
    attachmentsDir: c.ATTACHMENTS_DIR ?? join(c.DATA_DIR, "attachments"),
    deviceIdentityPath: c.OPENCLAW_DEVICE_IDENTITY_PATH ?? join(c.DATA_DIR, `openclaw-device${suffix}.json`),
    gateway: { url: pair.url, token: pair.token },
    vapid: { publicKey: c.VAPID_PUBLIC_KEY, privateKey: c.VAPID_PRIVATE_KEY, subject: c.VAPID_SUBJECT },
  };
}

/**
 * VAPID 주체가 개발용 자리값인가 — 호스트(mailto: 는 @ 뒤, https: 는 URL 호스트)가 localhost·127.0.0.1·*.local.
 * Apple Push 는 이런 주체를 403 BadJwtToken 으로 거부한다(web-push#947·#988) — 앱이 시작 때 warn 한 줄
 */
export function isLocalVapidSubject(subject: string): boolean {
  const host = vapidSubjectHost(subject)?.toLowerCase();
  if (!host) return false;
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
}

function vapidSubjectHost(subject: string): string | undefined {
  if (subject.startsWith("mailto:")) {
    const address = subject.slice("mailto:".length).split("?")[0] ?? "";
    const at = address.lastIndexOf("@");
    return at === -1 ? undefined : address.slice(at + 1);
  }
  try {
    return new URL(subject).hostname;
  } catch {
    return undefined;
  }
}

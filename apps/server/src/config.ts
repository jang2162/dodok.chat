import { join } from "node:path";
import { Handle } from "@dodok/shared";
import { z } from "zod";
import { parseTrustProxy } from "./http/client-address";

const Raw = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  APP_ORIGIN: z.url(),
  // 리버스 프록시 뒤면 그 프록시 주소(IP·CIDR 쉼표 목록 — 프록시 하나면 /32) — 레이트리밋 키(request.ip)·소켓 주소가 그 프록시가
  // 보낸 X-Forwarded-For 를 따른다. 비우거나 false 면 아무도 믿지 않는다, true 는 설정 오류(http/client-address.ts)
  TRUST_PROXY: z
    .string()
    .optional()
    .superRefine((raw, ctx) => {
      try {
        parseTrustProxy(raw);
      } catch (err) {
        ctx.addIssue({ code: "custom", message: (err as Error).message });
      }
    }),
  DATA_DIR: z.string().default("./data"),
  DB_PATH: z.string().optional(),
  // 첨부 블롭 디렉터리(스펙 4.1). 없으면 DATA_DIR/attachments
  ATTACHMENTS_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DODOK_WORKSPACE_NAME: z.string().min(1).max(80).default("dodok"),
  OWNER_HANDLE: Handle.default("owner"),
  LOCAL_AUTH_TOKEN: z.string().min(16),
  BETTER_AUTH_SECRET: z.string().min(32),
  // OpenClaw Gateway 주소·토큰은 .env 가 아니라 DB(연결 페이지)에 둔다(멀티 Gateway 스펙 「.env」 절)
  // 진단용 — 있으면 어댑터가 받은 Gateway chat·agent·session.message 프레임을 Gateway 마다 이 경로 + .<Gateway id> 파일에 JSONL 로
  // append(본문 포함)
  OPENCLAW_FRAME_DUMP_PATH: z.string().optional(),
  BRIDGE_PUBLIC_URL: z.url().optional(),
  // 서버가 품은 플러그인 tgz 디렉터리(이미지가 /app/plugin). 없으면 소스 실행에서 packages/openclaw-plugin/dist
  DODOK_PLUGIN_DIR: z.string().optional(),
  // 서버가 품은 러너 tgz 디렉터리(이미지가 /app/runner). 없으면 소스 실행에서 packages/claude-runner/dist
  DODOK_RUNNER_DIR: z.string().optional(),
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
  // FCM 서비스 계정 JSON 경로(없으면 DATA_DIR/fcm/service-account.json — 스펙 「자격 증명·설정」 장)
  FCM_SERVICE_ACCOUNT_PATH: z.string().min(1).optional(),
  // 테스트·개발 전용 — 통합 테스트가 가짜 FCM 으로 돌린다. 운영 문서에는 싣지 않는다(계획 판정 PN3)
  FCM_HOST: z.url().optional(),
  FCM_TOKEN_URI: z.url().optional(),
  // 네이티브 푸시 — APNs 키(.p8)·키 id·팀 id. 없으면 DATA_DIR/apns/ 의 파일(스펙 「자격 증명·설정」 장), 둘 다 없으면 iOS 통로는 꺼진다
  APNS_KEY_PATH: z.string().min(1).optional(),
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_TEAM_ID: z.string().min(1).optional(),
  // 중계 자리 — 아직 구현되지 않았다. 값이 있으면 부팅 때 warn 후 무시
  PUSH_RELAY_URL: z.string().min(1).optional(),
  // 테스트·개발 전용 — 가짜 APNs 로 보낸다(deploy.md 에 싣지 않는다). APNS_HOST 는 호스트[:포트], APNS_CA_PATH 는 그 서버의 인증서(PEM)
  APNS_HOST: z.string().min(1).optional(),
  APNS_CA_PATH: z.string().min(1).optional(),
});

export type ServerConfig = z.infer<typeof Raw> & {
  dbPath: string;
  attachmentsDir: string;
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
  return {
    ...c,
    dbPath: c.DB_PATH ?? join(c.DATA_DIR, "dodok.sqlite"),
    attachmentsDir: c.ATTACHMENTS_DIR ?? join(c.DATA_DIR, "attachments"),
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

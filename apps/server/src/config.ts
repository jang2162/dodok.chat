import { join } from "node:path";
import { Handle } from "@dodok/shared";
import { z } from "zod";

const Raw = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  APP_ORIGIN: z.url(),
  DATA_DIR: z.string().default("./data"),
  DB_PATH: z.string().optional(),
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
  BRIDGE_TOKEN: z.string().min(16),
  BRIDGE_PUBLIC_URL: z.url().optional(),
});

export type ServerConfig = z.infer<typeof Raw> & {
  dbPath: string;
  deviceIdentityPath: string;
  gateway: { url: string; token: string };
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
    deviceIdentityPath: c.OPENCLAW_DEVICE_IDENTITY_PATH ?? join(c.DATA_DIR, `openclaw-device${suffix}.json`),
    gateway: { url: pair.url, token: pair.token },
  };
}

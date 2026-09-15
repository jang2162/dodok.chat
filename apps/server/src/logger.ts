import pino, { type Logger } from "pino";

const SECRET_KEYS = new Set([
  "token",
  "LOCAL_AUTH_TOKEN",
  "BRIDGE_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_DEV_GATEWAY_TOKEN",
  "BETTER_AUTH_SECRET",
  "password",
  "authorization",
  "cookie",
]);

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: { paths: [...SECRET_KEYS].flatMap((k) => [k, `*.${k}`, `*.*.${k}`]), censor: "***" },
  });
}

export type { Logger };

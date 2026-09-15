/** 네트워크·파일 없이 loadConfig 를 통과하는 최소 env. DB 는 인메모리, 포트는 임의, 로그는 warn 이상. */
export const testEnv: Record<string, string | undefined> = {
  APP_ORIGIN: "http://localhost:5173",
  LOCAL_AUTH_TOKEN: "x".repeat(16),
  BETTER_AUTH_SECRET: "s".repeat(32),
  BRIDGE_TOKEN: "b".repeat(16),
  OPENCLAW_TARGET: "dev",
  OPENCLAW_DEV_GATEWAY_URL: "ws://127.0.0.1:19001",
  OPENCLAW_DEV_GATEWAY_TOKEN: "t",
  DB_PATH: ":memory:",
  PORT: "0",
  DATA_DIR: "./test-data-unused",
  LOG_LEVEL: "warn",
};

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 네트워크·파일 없이 loadConfig 를 통과하는 최소 env. DB 는 인메모리, 포트는 임의, 로그는 warn 이상.
 * 첨부 디렉터리는 앱이 부팅 때 만들므로 저장소 밖 임시 디렉터리(테스트 파일마다 하나)로 둔다 — 업로드하는 테스트는 자기 것을 준다
 */
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
  ATTACHMENTS_DIR: mkdtempSync(join(tmpdir(), "dodok-test-attachments-")),
};

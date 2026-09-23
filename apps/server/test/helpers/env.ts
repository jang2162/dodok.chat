/**
 * 네트워크·파일 없이 loadConfig 를 통과하는 최소 env. DB 는 인메모리, 포트는 임의, 로그는 warn 이상.
 *
 * ATTACHMENTS_DIR 은 일부러 만들 수 없는 경로다 — createApp 이 부팅 때 mkdir 하다 ENOTDIR 로 실패한다. 첨부 디렉터리는
 * **앱마다 따로** 있어야 한다: 부팅·주기 정리가 자기 db 에 행이 없는 블롭을 고아로 보고 지우므로, 두 앱이 한 디렉터리를
 * 쓰면 서로의 블롭을 지운다. 그래서 앱은 헬퍼로 띄운다 — bootTestApp(helpers/app.ts)·bootLiveApp(helpers/live-app.ts) 이
 * 앱마다 새 임시 디렉터리를 만들고 close() 뒤 지운다. createApp 을 직접 부를 때는 자기 임시 디렉터리를 ATTACHMENTS_DIR 로
 * 주고 스스로 지운다
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
  ATTACHMENTS_DIR: "/dev/null/dodok-test-attachments-use-bootTestApp",
};

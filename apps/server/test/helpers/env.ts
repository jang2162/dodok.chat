import webpush from "web-push";

// 앱마다 DATA_DIR/vapid.json 을 만들지 않게(저장소에 키 파일이 생기지 않게) 테스트 프로세스마다 한 쌍을 만들어 환경변수로 준다.
// 파일 경로를 재는 테스트만 VAPID_PUBLIC_KEY·VAPID_PRIVATE_KEY 를 빈 값으로 덮고 임시 DATA_DIR 을 준다
const vapid = webpush.generateVAPIDKeys();

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
  DB_PATH: ":memory:",
  PORT: "0",
  DATA_DIR: "./test-data-unused",
  LOG_LEVEL: "warn",
  ATTACHMENTS_DIR: "/dev/null/dodok-test-attachments-use-bootTestApp",
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  // 기본값(mailto:dodok@localhost)이면 앱마다 「로컬 자리값」 warn 이 찍힌다 — 그 warn 을 재는 테스트만 빈 값으로 덮는다
  VAPID_SUBJECT: "mailto:dodok-test@example.com",
};

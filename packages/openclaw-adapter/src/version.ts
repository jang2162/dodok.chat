/**
 * 저장소가 검증한 OpenClaw 버전 — package.json 의 OpenClaw 패키지 정확 핀과 같아야 한다(test/version.test.ts 가 본다).
 * 서버는 접속한 Gateway 버전이 이것과 다르면 운영 사건 gateway_version_untested 를 남긴다
 */
export const OPENCLAW_PINNED_VERSION = "2026.9.4";

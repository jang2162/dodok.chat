import { config } from "zod";

/**
 * zod 를 jitless 로 — CSP `script-src 'self'`(infra/Caddyfile)는 문자열 코드 실행을 막는다. jitless 가 아니면 zod 는 객체 스키마를
 * 만드는 순간 `Function("")` 으로 떠보고(막혀도 삼킨다) 파서를 문자열로 컴파일하는데, 브라우저는 그 시도를 CSP 위반으로 보고한다.
 * zod 는 이 값을 스키마를 만들 때 읽는다 — 그래서 앱(main.tsx)과 서비스 워커(sw.ts)의 **첫 import** 여야 한다(zodJitless.test 가 건다)
 */
config({ jitless: true });

# 프로필·접속 상태 — 2026-11-02 `dev:fake` 브라우저 확인 결과 (모델 런 0회)

> 프로필·접속 상태(기본 메신저 하위 프로젝트 B)를 `dev:fake` 위 두 계정으로 잰 기록 — 계획 `docs/superpowers/plans/2026-11-02-profiles-presence.md` 태스크 10, 스펙 `docs/superpowers/specs/2026-11-02-profiles-presence-design.md` 5장 「`dev:fake` 위 브라우저」. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다.

**판정: 확인 항목 17/17 통과, 결함 0.** 실제 Gateway·모델·러너는 쓰지 않았다(가짜 Gateway·가짜 러너·대본).

## 환경

| 항목 | 값 |
| --- | --- |
| 서버 | `PORT=3417 APP_ORIGIN=http://messenger-basics.localhost:5317 LOG_LEVEL=debug pnpm -F @dodok/server dev:fake`(새 DB) |
| 웹 | `DODOK_API_ORIGIN=http://127.0.0.1:3417 pnpm -F @dodok/web dev --port 5317 --strictPort`, 연 주소 `http://messenger-basics.localhost:5317`(쿠키를 다른 인스턴스와 가르려고 호스트를 갈랐다 — `docs/guides/browser-verification.md`) |
| 브라우저 | 독립 헤드리스 Chromium(`playwright-core` 1.62.1, 컨텍스트 둘). neo 는 쓰지 않았다 — 탭이 백그라운드라 `visibilityState` 가 `hidden` 이고, 접속 점은 「보이는 탭」을 본다(같은 문서의 presence 함정) |
| 계정 | owner(로컬 토큰), mia(고정 member) — 세션 토큰은 `POST /api/v1/auth/local` 로 받아 `dodok.session` 쿠키로 실었다 |
| 채널 | 씨앗 채널 「세션」(dev·coder), 세션 「dev:fake 새 세션」 |

## 확인한 것

| # | 항목 | 결과 |
| --- | --- | --- |
| 1 | owner 창의 mia 프로필 — 「접속 중」 | 통과 |
| 2 | mia 창의 owner 프로필 — 「접속 중」 | 통과 |
| 3 | mia 탭을 숨김(`visibilitychange` → `presence.update` visible false) → owner 창 「자리 비움」 | 통과 |
| 4 | mia 「오프라인으로 보이기」(`PUT /me/status`) → owner 창 「오프라인」 | 통과 |
| 5 | mia 자기 패널은 「오프라인으로 보이기」 | 통과 |
| 6 | mia 방해 금지 → owner 패널에 「방해 금지 중」 | 통과 |
| 7 | owner 가 mia 를 멘션(패널 「멘션」 → 작성기 칩) → 서버 debug `push skipped — dnd`, `userId` = mia | 통과 — 줄은 찍혔다. 스크립트는 2.5초 뒤 셌을 때 아직 없어 FAIL 로 적었고, 로그 파일에서 줄(`kind: "mention"`)을 확인했다 |
| 8 | coder 「응답 가능」 | 통과 |
| 9 | `POST /__devfake/runner {"connected":false}` → coder 「연결 끊김」 | 통과 |
| 10 | 다시 붙이면 「응답 가능」 | 통과 |
| 11 | coder 멘션(「오래」 대본, 약 15초) → 「작업 중」 | 통과 |
| 12 | 런이 끝나면 「응답 가능」 | 통과 |
| 13 | member 의 coder 패널에 권한 모드·허용·금지 도구·기본 프롬프트가 없다 | 통과 |
| 14 | member 의 coder 패널에 연결(`dev-fake · Claude Code`)·모델(「기본」)·소유자(`@owner`)·DM 허용 | 통과 |
| 15 | owner 가 「내 계정」에서 300×200 PNG 를 골라 저장 → `avatarUrl` = `/api/v1/avatars/<sha256>.webp`, GET 200 `image/webp` | 통과 — 브라우저가 가운데 정사각형 256px webp 로 만들었다 |
| 16 | mia 창(이미 열린 세션) 타임라인의 owner 아바타가 곧바로 새 사진 | 통과 |
| 17 | 새로 연 페이지가 스냅숏으로 점을 받는다 — mia 의 coder 패널 「응답 가능」, owner 창 없을 때 owner 「오프라인」 | 통과 |

두 컨텍스트의 콘솔 오류 0건.

## 본 것 — 결함 아님

- 첫 실행에서 mia 의 coder 패널이 「알 수 없음」으로 읽혔다 — 스크립트가 패널이 그려지자마자(스냅숏 도착 전) 읽었다. 항목 17 로 다시 재어 스냅숏으로 채워지는 것을 확인했다.
- 첫 실행 끝의 owner 스크린숏에 coder 답이 없었다 — 페이지를 새로 연 직후 찍었다. 2초 뒤 같은 화면에 답이 있다.

## 재지 않은 것

- 실기기 푸시 도착(방해 금지의 승인 예외 포함) — 거르기는 단위·통합 시험(`apps/server/test/push.service.test.ts`·`dms.test.ts`)이 본다.
- 좁은 화면(시트) 모양.

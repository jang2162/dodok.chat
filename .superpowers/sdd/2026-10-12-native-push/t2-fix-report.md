# 태스크 2 수정 보고 (np-t2)

B1·B2·R1·R2 를 고쳤다. R3 은 태스크 3 몫이라 건드리지 않았다.

## 고친 것
- **B1** members/service.ts deactivateMember 트랜잭션이 push_devices 도 지운다. 테스트: 세션 지우기 실패 사례에서 `listDevices` 0.
- **B2** shared `IosToken`(regex + toLowerCase transform)을 PushDeviceInput iOS 가지에 쓴다. `removeDevice` 도 같은 파서로 정규화해 찾는다. 테스트: 대문자·소문자 다른 사용자 등록이 한 행으로 이동, 대문자 DELETE 가 소문자 행을 지움.
- **R1** appId `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` + max(200), iOS·Android 둘 다. 테스트: 줄바꿈·공백·점 시작·슬래시 거절.
- **R2** upsertDevice 가 같은 세션의 다른 토큰 행을 지운다(같은 호출, 트랜잭션 아님: better-sqlite3 동기 두 문장). 테스트: 토큰 A 뒤 B → B 하나.

## 계획과 달라진 판단
- **PN5 — 세션당 기기 1행.** 코디네이터 결정. 토큰 회전·거절돼 남은 옛 토큰이 세션에 쌓이지 않는다. 스펙 「구현과 맞춘 것」 은 태스크 6 이 쓴다. 이 때문에 기존 push.devices 테스트 둘(같은 세션에 iOS+Android·두 행)을 세션 분리로 고쳤다.

## 검증 (캐시 0, `pnpm test --force`)
- shared 431 · web 1911 · server 2244 · openclaw-adapter 315 · claude-runner 235 · plugin 149 · runner-adapter 81 통과.
- typecheck 0 · lint 0 · fmt:check 0 · server build 0 · bundle:smoke 0.
- 변이: B1 줄 삭제(실패 1), toLowerCase 제거(서버 1·shared 1), R2 조건을 eq 로(실패 2) — 모두 잡힘, 원복.

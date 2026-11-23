# 러너·플러그인 원격 업데이트 Implementation Plan

> **For agentic workers:** 이 저장소에서는 Orca 워커가 태스크를 맡는다(`AGENTS.md` 「작업 방식」). 브리프가 이 계획의 태스크를 가리키고, 워커는 이 계획과 스펙을 함께 읽는다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 웹 러너·Gateway 상세에 「판 X · 최신 Y [업데이트]」를 두고, 기본 허용·로컬 거부 가능한 원격 업데이트를 러너(npm)와 플러그인(서버 번들)에 더한다.

**Architecture:** 서버가 npm latest 를 캐시하고 ack 요청 `runner.update`·브리지 `plugin.update` 를 보낸다. 러너는 자기 npm 전역 자리에 설치하고 스스로 다시 띄우며, 플러그인은 Gateway 밖 분리 스크립트로 내리기·설치·올리기를 한다. 둘 다 hello 에 `remoteUpdate`·마지막 업데이트 결과를 싣는다.

**Tech Stack:** Zod, Fastify, Socket.IO, Node `child_process`(execFile·spawn detached), OpenClaw CLI.

**Spec:** `docs/superpowers/specs/2026-11-23-remote-update-design.md` — U1~U9.

## Global Constraints

- 기본 허용, 로컬 `remoteUpdate: false` 면 거부(U1). 능력 이름 `remoteUpdate`(U8).
- 러너는 npm 레지스트리의 정확한 판·지금보다 높은 판만(U3), 진행 중인 런이 있으면 거절 「런이 끝난 뒤 다시 시도하세요」. npm 전역 설치가 아니면 「이 설치 방식은 원격 업데이트를 지원하지 않습니다」.
- 플러그인은 서버 번들 tgz 의 sha256 이 서버가 알려 준 값과 같을 때만 설치(U5). 실패하면 Gateway 를 다시 올린다.
- npm latest 캐시 1시간(U2). 다시 붙기 상한 러너 3분·플러그인 5분(U9).
- 누르는 사람 owner·admin·연결 주인(U7).
- 병렬 작업: `runner-bots` 워크트리가 같은 파일(`packages/shared/src/runner/index.ts` 의 `RunnerCapability`·hello, `packages/claude-runner/src/config.ts`·`connection.ts`)에 `bots`·`botsDir` 를 더한다. 이 작업은 `remoteUpdate` 관련만 더하고 그쪽 키를 건드리지 않는다. 나중에 병합되는 쪽이 리베이스한다.
- 실제 npm publish·실제 원격 Gateway 를 건드리지 않는다. 시험의 npm·openclaw 는 가짜 실행 파일. 공통: Conventional Commits, 경로 명시 stage.

## Review Focus

1. **서버가 `version` 에 `latest`·범위·`../x`·URL·`file:` 를 보내도 러너는 정확한 semver 만 받는다.** (Task 2)
2. **`remoteUpdate: false` 머신은 서버가 보내도 업데이트하지 않는다**(서버 쪽 단추 잠금과 별개로 러너·플러그인이 스스로 거부). (Task 2·3)
3. **플러그인 스크립트가 tgz 받기·sha 불일치·설치 실패 어느 단계에서 실패해도 Gateway 가 다시 올라온다.** (Task 3)
4. **업데이트를 두 번 연타해도 한 번만 돈다.** (Task 2·3·4)
5. **npm 레지스트리에 닿지 않으면 「최신을 알 수 없음」이고 단추가 잠긴다.** (Task 4)

---

### Task 1: 계약
**Files:** `packages/shared/src/runner/index.ts`(능력 `remoteUpdate`, hello `remoteUpdate: boolean`·`lastUpdate?: { ok; version?; message? }`, `runner.update` 요청·응답 `{ ok: true } | { ok: false; reason: "disabled"|"busy"|"unsupported"|"invalid_version"|"failed"; message? }`), `packages/shared/src/bridge/index.ts`(플러그인 hello 같은 두 필드·능력, `plugin.update { sha256 }` 응답 같은 꼴), `packages/shared/src/control/runner-bodies.ts`·Gateway 상세 응답(`latestVersion`·`remoteUpdate`·`lastUpdate`). Test: `packages/shared/test/runner.test.ts`, `bridge.test.ts`, `runner-rest.test.ts`.
- [ ] 시험 → 실패 → 구현 → 통과 → 커밋 `feat(shared): remote update contracts`

### Task 2: 러너
**Files:** `packages/claude-runner/src/config.ts`(`remoteUpdate` 기본 true), Create `packages/claude-runner/src/self-update.ts`(`selfUpdate(opts: { version: string; busy: () => boolean; enabled: boolean; argv: string[]; execPath: string; npm?: Runner; spawn?: Spawner }): Promise<RunnerUpdateResult>` — semver `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`·지금보다 높음, `npm root -g` 아래 `@dodok/runner` 인지, `npm i -g @dodok/runner@<v>`, 성공이면 분리된 자식으로 같은 argv 다시 띄우고 `process.exit`), `packages/claude-runner/src/connection.ts`(이벤트·hello). Test: Create `packages/claude-runner/test/self-update.test.ts`, `connection.test.ts`, `config.test.ts`, `adapter-integration.test.ts`.
- [ ] 시험(Review Focus 1·2·4, busy 거절, npm 실패 → failed·재시작 없음, 전역 아님 → unsupported, 성공 → spawn 인자·exit) → 실패 → 구현 → 통과 → 커밋 `feat(runner): remote self-update from npm`

### Task 3: 플러그인
**Files:** `packages/openclaw-plugin/src/config.ts`(`remoteUpdate`), Create `packages/openclaw-plugin/src/self-update.ts`(분리 스크립트 쓰기·띄우기 — 스크립트 본문은 `apps/server/src/modules/setup/plugin-install-script.ts` 의 설치 단계와 같은 명령, 설정 패치 없음, 모든 실패에서 `gateway start`, 결과를 상태 디렉터리 파일에), `packages/openclaw-plugin/src/channel.ts`(hello·`plugin.update`), `apps/server/src/modules/setup/plugin-install-script.ts`(공통 단계를 함수로 뽑으면). Test: Create `packages/openclaw-plugin/test/self-update.test.ts`(스크립트를 가짜 `openclaw`·`curl` 로 실제 실행 — Review Focus 3), `bridge-client.test.ts`, `channel.test.ts`.
- [ ] 시험 → 실패 → 구현 → 통과 → 커밋 `feat(plugin): remote self-update from the server bundle`

### Task 4: 서버·웹
**Files:** Create `apps/server/src/modules/runners/latest.ts`(npm latest 1시간 캐시 — 레지스트리 URL `https://registry.npmjs.org/@dodok%2frunner/latest`, 실패면 null), `apps/server/src/modules/runners/routes.ts`(`POST /api/v1/runners/:id/update`), Gateway 쪽 라우트(`POST /api/v1/gateways/:id/update` — 플러그인 번들 sha 실음), `packages/runner-adapter/src/runner-adapter.ts`·`packages/openclaw-adapter/src/bridge/server.ts`(보내기), 진행 중 표시(메모리, 연타 409), `apps/web/src/features/connections/RunnerDetail.tsx`·`GatewayDetail.tsx`·`apps/web/src/features/setup/GatewayCard.tsx`(판 줄·단추·확인 대화상자 「진행 중인 런 N개가 끊깁니다」·상태·실패 사유·끈 머신 안내·옛 판 명령 한 줄), dev:fake(가짜 러너·플러그인이 업데이트에 답하는 훅). Test: `apps/server/test/runners.routes.test.ts`, Gateway 라우트 시험, `apps/server/test/roles.matrix.test.ts`, `apps/web/src/features/connections/runnerDetail.test.tsx`, `gatewayDetail.test.tsx`, `apps/server/test/dev-fake.test.ts`.
- [ ] 시험(권한, 연타 409, 레지스트리 실패 → 잠금, 끈 머신 안내, 옛 판 명령, 상한 지나면 「응답이 없습니다」) → 실패 → 구현 → 통과 → 브라우저(dev:fake, 워크트리 전용 포트) → 커밋 `feat(server,web): version check and remote update buttons`

### Task 5: 손 확인·문서
- [ ] 러너: 임시 npm prefix 에 이 브랜치 tgz 를 전역 설치한 러너를 dev 서버에 붙이고, 로컬 가짜 레지스트리(또는 `npm_config_registry` 로 가리킨 정적 서버)에 더 높은 판 tgz 를 두어 웹 단추로 업데이트·재접속 확인. 플러그인: 스크래치 dev Gateway(글로벌 설치 금지)에서 업데이트 한 바퀴 — 못 하면 그렇다고. 문서 `docs/manual/user-guide.md`·`docs/guides/docker-deploy.md`·`docs/guides/runner-release.md`·`docs/guides/plan.md`. 커밋 `docs: remote update`

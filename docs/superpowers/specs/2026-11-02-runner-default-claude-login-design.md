# 러너가 기본으로 평소 claude 로그인을 쓰게 — 설계

2026-11-02 · 슬러그 `runner-default-claude-login` · 상태: 승인됨(2026-11-02)

## 1. 의도

> 러너가 기본적으로 CLAUDE_CONFIG_DIR 설정 없이 기존 환경에 붙은 claude 를 사용하고 싶어. 따로 쓰고 싶은 경우에만 설정해서 전용 로그인을 사용하고.

지금 러너는 설정 `programs.claude.configDir` 이 필수라, 러너를 붙이려면 `~/.dodok-runner/claude` 에서 `/login` 을 한 번 더 해야 한다(`CLAUDE_CONFIG_DIR` 이 있으면 CLI 가 키체인 항목 이름에 경로 해시를 붙여 평소 로그인이 안 보인다 — ADR 0007 5.2). 사람이 정한 것:

- **로그인과 대화 기록 둘 다 평소 것을 쓴다.** 평소 `~/.claude` 를 그대로 — 러너 런의 전사가 평소 자리에 남아 `claude --resume` 목록에도 보인다. 「설정을 분리할 이유가 없다」.
- **계정 이메일이 에이전트 문맥에 들어가는 것(ADR 0007 5.6)은 감수한다.** 「중요하지 않다」.
- 전용 로그인은 **원하는 사람만** 설정(`configDir`)으로 쓴다.

## 2. 목표 · 비목표 · 반목표

- 목표: `configDir` 을 적지 않은 러너가 평소 `claude` 로그인과 `~/.claude` 로 돈다. 설치 안내가 전용 로그인 단계 없이 끝난다.
- 목표: `configDir` 을 적은 설정(옛 설정 파일 포함)은 지금과 똑같이 그 디렉터리의 전용 로그인으로 돈다 — 이전 작업이 필요 없다.
- 비목표: 자격 증명을 읽어 로그인 여부를 확정하는 것(`detect` 는 지금처럼 디렉터리만 본다 — plan.md 8장 「이월」의 「로그인 모름」 줄은 그대로).
- 비목표: 이메일을 문맥에서 빼는 것(방법이 없다 — ADR 0007 8의 5).
- 반목표: 러너 프로세스와 CLI 가 서로 다른 설정 자리를 보는 것. SDK 세션 헬퍼(`getSessionInfo`)는 러너 프로세스의 `process.env.CLAUDE_CONFIG_DIR` 을, CLI 는 넘겨받은 env 를 읽는다(ADR 0007 5.2). 둘이 갈리면 「새 세션 / resume」 판정이 틀린다.
- 반목표: 이번 일을 핑계로 다른 격리를 푸는 것. `ANTHROPIC_*` 미전달·env 허용 목록·`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`·`settingSources: []`·`strictMcpConfig: true` 는 그대로다(코드 `packages/claude-runner/src/drivers/claude/run.ts` `buildQueryOptions` 에서 확인).

## 3. 접근

| 길 | 판단 |
| --- | --- |
| **A. `configDir` 을 선택 항목으로** — 없으면 `CLAUDE_CONFIG_DIR` 을 넣지 않는다 | **고름.** 옛 설정이 손대지 않아도 돌고, 바뀌는 코드가 적다 |
| B. `configDir: "~/.claude"` 로 평소 자리를 가리킨다 | 안 된다. 번들 CLI(2.1.283)는 `CLAUDE_CONFIG_DIR` 이 **있기만 하면** 값과 무관하게 키체인 이름에 sha256 앞 8자를 붙인다(바이너리 정적 조회: `t = !process.env.CLAUDE_CONFIG_DIR`, `o = t ? "" : "-<해시>"`) |
| C. 전용 디렉터리는 두고 `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` 로 로그인만 공유 | 로그인은 한 번으로 줄지만 「대화 기록도 평소 자리에」를 못 채운다. (참고: 바이너리 정적 조회로 빈 값이면 키체인 이름에 해시가 붙지 않고 자격 파일 자리도 `~/.claude` 임을 확인했다 — 실행으로는 재지 않았다) |
| D. `login: "default" \| "dedicated"` 모드 키를 따로 | `configDir` 유무와 뜻이 겹쳐 어긋나는 설정만 생긴다 |

사람이 A 를 골랐다.

## 4. 정한 동작

### 4.1 설정 (`packages/claude-runner/src/config.ts`)

- `ProgramCeiling.configDir` 을 `z.string().min(1).optional()` 로. 빈 문자열은 지금처럼 거절한다(「기본을 쓰려면 줄을 지운다」가 하나의 길이 되게).
- 적었으면 지금처럼 `expandHome` 으로 푼다. 안 적었으면 해석된 설정에도 없다(`undefined`).

### 4.2 어느 자리를 쓰나 — 「유효 설정 자리」

| 설정 | 러너를 띄운 셸의 `CLAUDE_CONFIG_DIR` | 러너 프로세스 env | CLI env | 로그인 종류 |
| --- | --- | --- | --- | --- |
| `configDir` 있음 | 무엇이든 | `configDir` 로 덮는다 | `configDir` | 전용(`dedicated`) |
| `configDir` 없음 | 비었거나 없음 | 지운다(`delete`) | 넣지 않는다 | 평소(`default`) — `~/.claude` |
| `configDir` 없음 | 값 있음 | 그대로 둔다 | **같은 값**을 넣는다 | 평소(`default`) — 그 사람에게는 그 값이 「평소 claude」다 |

- 불변식: **러너 프로세스의 `process.env.CLAUDE_CONFIG_DIR` 과 CLI env 의 `CLAUDE_CONFIG_DIR` 은 둘 다 없거나 같은 값이다.** 지금은 셸에 export 된 값이 env 허용 목록에 걸러져 CLI 에 안 가므로, `configDir` 이 선택이 되면 이 틈이 열린다 — 셋째 줄이 그것을 막는다.
- 빈 문자열(`CLAUDE_CONFIG_DIR=`)은 없는 것으로 친다 — `main.ts` 가 지운다(SDK 헬퍼가 빈 값을 경로로 쓰지 않게).
- `main.ts` 가 프로세스 env 를 맞추고, `run.ts` `buildQueryOptions` 는 `spec.configDir` 이 있으면 그 값, 없으면 `deps.baseEnv.CLAUDE_CONFIG_DIR`(비어 있지 않을 때만)을 CLI env 에 넣는다. `baseEnv` 기본값은 `process.env` 라 둘째·셋째 줄이 저절로 맞는다. `CLAUDE_CONFIG_DIR` 을 `ENV_ALLOWLIST` 에 더하지는 않는다 — 한 곳에서 명시로 넣는 지금 꼴을 유지한다.
- `HOME` 은 지금처럼 허용 목록으로 넘어간다 — 기본 길에서 CLI 가 `~/.claude`·`~/.claude.json`·키체인을 찾는 근거다.

### 4.3 로그인 상태와 「평소/전용」 표시

- `detect` (`drivers/claude/index.ts`)는 지금처럼 자격 증명을 읽지 않고 **유효 설정 자리의 디렉터리**가 있는지만 본다 — 전용이면 `configDir`, 평소면 `process.env.CLAUDE_CONFIG_DIR` 또는 `~/.claude`(`HOME` 기준). 있으면 `unknown`, 없으면 `missing`.
  - `missing` 사유(경로 원문 없이): 전용은 지금 문구 그대로 「로그인 디렉터리가 없습니다 — 러너 머신에서 그 디렉터리로 claude /login 하세요」, 평소는 「Claude Code 로그인 디렉터리가 없습니다 — 러너 머신에서 claude 로 /login 하세요」.
- 와이어: shared `RunnerProgramStatus`(`packages/shared/src/runner/index.ts`)에 선택 필드 `login: z.enum(["default", "dedicated"]).optional()` 을 더한다. 러너가 hello 로 싣고, 서버·어댑터는 그대로 통과시킨다(`connections.ts` 가 통째로 복제한다). 옛 러너는 안 실으므로 선택이고, 옛 서버는 `z.object` 가 모르는 키를 버리므로 새 러너가 옛 서버에 붙어도 깨지지 않는다.
- 웹 러너 카드(`apps/web/src/features/runners/RunnersPage.tsx` `ProgramLine`, 문구는 `copy.ts`): 로그인 상태 뒤에 괄호로 「(평소 로그인)」/「(전용 로그인)」. 필드가 없으면(옛 러너) 아무것도 붙이지 않는다. 예: `Claude Code 2.1.283 · 로그인 모름 (평소 로그인) · 권한 상한 default`.

### 4.4 설치 안내 — 2단계(로그인)의 내용

배치(설치 안내를 어느 탭·어느 자리에 두나)는 `settings-connect-merge` 몫이다. 여기서는 그 단계의 **명령과 문구**만 정한다.

- 웹 `RunnerSection.tsx` 설치 2단계:
  - 본문: 「러너는 이 머신의 평소 Claude Code 로그인을 씁니다. `claude` 로 로그인돼 있으면 건너뜁니다. 아니면 `claude` 를 열어 `/login` 을 마치고 나옵니다.」
  - `claude` 가 없을 때의 번들 CLI 명령은 남기되 `CLAUDE_CONFIG_DIR=` 접두사를 뗀다(평소 자리에 로그인).
  - 접힌 「러너 전용 로그인을 따로 쓰려면」: 지금의 `CLAUDE_CONFIG_DIR=~/.dodok-runner/claude claude`(와 번들 CLI 판) + 「설정의 `programs.claude` 에 `"configDir": "~/.dodok-runner/claude"` 를 적습니다. 전용 로그인이면 대화 기록도 그 디렉터리에 따로 남습니다.」
  - 경고 한 줄(본문 아래, 흐리게): 「러너 런은 평소 계정으로 돌기 때문에 계정 이메일이 에이전트에게 보이고, 대화 기록이 이 머신의 `claude --resume` 목록에도 남습니다.」
- 설정 예시(`runnerConfig.ts` `runnerConfigExample`, 서버 llms.txt 예시와 같은 값): `configDir` 줄을 뺀다. `RUNNER_CLAUDE_DIR` 상수는 접힌 전용 로그인 안내가 계속 쓴다.
- 서버 `llms.txt`(`apps/server/src/modules/setup/llms.ts`) 3단계: 「러너는 이 머신의 평소 Claude Code 로그인을 쓴다. `claude auth status` 로(없으면 번들 CLI 로) 로그인돼 있는지 보고, 안 돼 있으면 사람에게 `claude` 를 열어 `/login` 하게 하고 마쳤다고 할 때까지 멈춘다. 사람이 전용 로그인을 원한다고 하면 그때만 `CLAUDE_CONFIG_DIR=~/.dodok-runner/claude` 로 로그인하게 하고 설정에 `configDir` 을 적는다.」 AI 가 먼저 묻지는 않는다(기본 길을 짧게). `auth status` 는 번들 CLI 2.1.283 에 있다(바이너리의 `command("status").description("Show authentication status")`, JSON 에 `loggedIn`). 4단계 예시 JSON 에서 `configDir` 이 빠진다.

### 4.5 같은 세션을 두 곳에서 이어 쓸 때

러너 세션이 평소 `--resume` 목록에 보이므로, 채널 런이 도는 중에 같은 세션을 터미널에서 이어 쓰면 두 CLI 가 한 전사에 쓴다. **막지 않는다** — 문서(docker-deploy.md 「러너 설치」)에 주의 한 줄만 둔다: 「채널에서 쓰는 러너 세션을 터미널에서 이어 쓰지 않는다 — 대화가 섞인다.」

## 5. 바뀌는 자리

러너:
- `packages/claude-runner/src/config.ts` — `configDir` 선택, 해석.
- `packages/claude-runner/src/main.ts` — 프로세스 env 맞추기(4.2 표).
- `packages/claude-runner/src/driver.ts` — `RunSpec.configDir` 을 선택으로, detect 결과에 `login`.
- `packages/claude-runner/src/connection.ts` — 427행 근처, `configDir` 이 없을 수 있는 값을 넘긴다. hello 프로그램 상태에 `login` 이 실리는지.
- `packages/claude-runner/src/drivers/claude/run.ts` — `buildQueryOptions` 의 CLI env.
- `packages/claude-runner/src/drivers/claude/index.ts` — `detect`.
- `packages/claude-runner/README.md` — 설치 순서의 로그인 줄·설정 예시.

계약·서버·웹:
- `packages/shared/src/runner/index.ts` — `RunnerProgramStatus.login`.
- `apps/server/src/modules/setup/llms.ts` — 3·4단계.
- `apps/server/scripts/dev-fake.ts`·`apps/server/test/fakes/fake-runner.ts` — 가짜 러너 hello 에 `login` (dev-fake 는 「dev-fake」 = `default`, 「dev-fake 제한」 = `dedicated` 로 두 표시를 손으로 볼 수 있게).
- `apps/web/src/features/setup/RunnerSection.tsx`·`runnerConfig.ts` — 4.4.
- `apps/web/src/features/runners/RunnersPage.tsx`·`copy.ts` — 4.3.

시험(같은 이름으로):
- `packages/claude-runner/test/config.test.ts` — `configDir` 없음 통과·빈 문자열 거절·있으면 풀림.
- `packages/claude-runner/test/connection.test.ts` — 530행 근처 CLI env 단언, detect·hello `login`.
- `packages/claude-runner/test/run.test.ts`·`packages/claude-runner/test/helpers/fixtures.ts`·`packages/claude-runner/test/adapter-integration.test.ts` — 픽스처의 `configDir` 과 hello 통째 단언.
- `packages/shared/test/runner-v2.test.ts` — `login` 받기·없어도 받기.
- `packages/runner-adapter/test/runner-adapter.test.ts`·`packages/runner-adapter/test/helpers/fake-runner-client.ts` — 프로그램 상태 통째 단언이 있으면.
- `apps/server/test/setup.llms.test.ts` — 예시가 `RunnerConfig` 로 파싱되는지(`configDir` 없이), 안내 문구.
- `apps/server/test/integration/runner-projects.test.ts` — 프로그램 상태 단언이 있으면.
- `apps/web/src/features/setup/runner.test.tsx` — 2단계 문구·예시.
- `apps/web/src/features/runners/runners.test.tsx`·`apps/web/test/runnersServer.tsx`·`apps/web/src/features/agents/agentsProvider.test.tsx` — 「(평소 로그인)」 표시, 필드 없는 옛 러너.

문서:
- `docs/guides/docker-deploy.md` 「러너 설치」 3·4번 — 기본은 평소 로그인, 전용 로그인은 선택, 4.5 주의, 설정 예시와 `programs` 설명의 `configDir`.
- `docs/manual/user-guide.md` — 486행(「러너 전용 Claude 로그인」 → 「Claude 로그인」), 531행 표의 조치(「러너 머신의 Claude Code 로그인을 다시 한 뒤」), 458행 러너 카드 프로그램 줄에 「(평소 로그인|전용 로그인)」.
- `docs/guides/live-smoke.md` 「Claude 러너 런 0회 하네스」 — 하네스는 스크래치 `configDir` 을 계속 **적는다**(사람의 `~/.claude` 를 건드리지 않게). 949행 근처 실제 API 런 절의 「`configDir` 은 러너 전용 로그인」을 「평소 로그인이면 `configDir` 을 빼고, 전용이면 적는다」로.
- `docs/adr/0007-claude-agent-sdk-spike.md` 9절 「구현이 고른 것」 8 격리 줄에 덧붙임: 「`CLAUDE_CONFIG_DIR` 은 기본이 평소 자리(넘기지 않음), 설정 `configDir` 을 적으면 전용 — 2026-11-02 이 설계」. 6절 8번 본문은 스파이크 당시의 추천이므로 고치지 않는다.
- `docs/guides/plan.md` 10장 결정 표에 24번: 「러너의 Claude 로그인 — 기본은 평소 로그인(`~/.claude`, 이메일·전사 공유 감수), `configDir` 은 전용 로그인을 원할 때만」.

`docs/guides/runner-release.md` 에는 로그인 관련 문장이 없어 고치지 않는다.

## 6. 새 ADR 이 필요한가

**쓰지 않는다**(설계자의 판단). ADR 0007 은 스파이크로 잰 사실의 기록이고 이번 일은 새로 잰 것 없이 기본값 선택만 바꾼다. 결정은 plan.md 10장 24번에, ADR 0007 에는 9절 줄 덧붙임으로 남긴다.

## 7. 확인

- 런 0회: 단위·통합 시험(위 목록)과 웹 손 확인(dev:fake 의 두 가짜 러너 카드에 「(평소 로그인)」·「(전용 로그인)」).
- 모델 호출 없이 기본 길이 실제로 로그인을 찾는지: `configDir` 없는 설정으로 러너를 띄우고, 사용자 메시지 없이 `query()` 를 열어 `accountInfo()` 의 `subscriptionType` 이 나오는지만 본다(ADR 0007 7의 8과 같은 방법, 이메일·조직은 적지 않는다). 이것은 **사람의 실제 로그인**을 읽으므로 실행 직전 사람 승인을 받는다. 모델 런은 하지 않는다.

## 8. 빌더에게 남긴 것

- `detect` 가 쓰는 유효 자리 계산을 어디에 둘지(드라이버 안 / 설정 해석) — 4.2 불변식만 지키면 된다.
- 웹 문구의 미세 조정(띄어쓰기·강조), 접힘 컴포넌트는 기존 「서버와 같은 빌드로 설치」의 접힘 꼴을 따른다.

## 9. 다른 워커와 겹치는 자리

- `settings-connect-merge` — 같은 `RunnerSection.tsx` 설치 안내를 옮기거나 다시 짠다. 이 설계는 2단계의 **내용**만 정하므로, 병합 순서에 따라 한쪽이 다른 쪽 위에 문구를 다시 얹어야 한다. `docs/manual/user-guide.md` 486행 근처도 둘 다 고친다.
- `plugin-install-cmd` — `llms.txt`(`llms.ts`)를 함께 고칠 수 있다(플러그인 절 vs 러너 절, 같은 파일).

# 러너 기본 평소 claude 로그인 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 저장소에서 Orca 가 살아 있으면 태스크는 `scripts/orca-worker.sh` 워커가 실행한다(AGENTS.md 「작업 방식」).

**Goal:** 러너 설정의 `programs.claude.configDir` 을 선택 항목으로 바꿔, 적지 않으면 러너가 평소 `claude` 로그인과 `~/.claude` 로 돌게 한다.

**Architecture:** 유효 설정 자리 계산을 러너의 작은 모듈 하나(`drivers/claude/config-dir.ts`)에 모으고, `main.ts`(러너 프로세스 env)·`run.ts`(CLI env)·`detect`(로그인 상태)가 그것을 쓴다. hello 프로그램 상태에 선택 필드 `login` 을 더해 웹 러너 카드에 「(평소 로그인)/(전용 로그인)」을 붙인다. 설치 안내(웹·llms.txt·문서)는 전용 로그인 단계를 접힌 선택으로 내린다.

**Tech Stack:** TypeScript, Zod 4, Vitest, React(웹), Fastify(서버). pnpm 모노레포.

**Spec:** `docs/superpowers/specs/2026-11-02-runner-default-claude-login-design.md`

## Global Constraints

- 러너 CLI env 는 허용 목록(`ENV_ALLOWLIST`) — `ANTHROPIC_*` 를 넘기지 않는다. `CLAUDE_CONFIG_DIR` 을 `ENV_ALLOWLIST` 에 더하지 않는다(명시로 넣는다).
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`·`settingSources: []`·`strictMcpConfig: true` 는 그대로.
- 불변식: 러너 프로세스 `process.env.CLAUDE_CONFIG_DIR` 과 CLI env `CLAUDE_CONFIG_DIR` 은 **둘 다 없거나 같은 값**.
- `configDir: ""` 은 거절(`z.string().min(1).optional()`).
- `detect` 는 자격 증명을 읽지 않는다 — 디렉터리 유무만.
- hello·사유 문구에 경로 원문을 싣지 않는다.
- 모델 런 0회. 사람 로그인을 읽는 확인(태스크 7 의 `accountInfo`)은 실행 직전 사람 승인.
- 문구(그대로 쓴다):
  - 평소 `missing` 사유: `Claude Code 로그인 디렉터리가 없습니다 — 러너 머신에서 claude 로 /login 하세요`
  - 전용 `missing` 사유(지금 그대로): `로그인 디렉터리가 없습니다 — 러너 머신에서 그 디렉터리로 claude /login 하세요`
  - 러너 카드 꼬리: ` (평소 로그인)` / ` (전용 로그인)`
- 커밋: 경로 명시 stage, Conventional Commits + 패키지 스코프, 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `pnpm test` 를 typecheck·build 와 동시에 돌리지 않는다. 통과 보고에는 실행 수를 적는다.

## Review Focus

1. **셸에 `CLAUDE_CONFIG_DIR` 이 export 된 채 `configDir` 없이 러너를 띄움** — CLI 와 SDK 헬퍼가 같은 값을 봐야 한다(그러지 않으면 resume 판정이 틀린다). 태스크 2 의 `resolveClaudeConfigDir`·`buildQueryOptions` 시험이 잡는다.
2. **`CLAUDE_CONFIG_DIR=`(빈 값)이 셸에 있음** — 없는 것으로 쳐서 프로세스 env 에서 지우고 CLI 에 넣지 않는다. 태스크 2 시험.
3. **`configDir` 이 있는 옛 설정 파일** — 지금과 똑같이 전용(`login: "dedicated"`), CLI env 에 그 값. 태스크 2·3 시험.
4. **옛 러너(hello 에 `login` 없음)가 새 서버에 붙음** — 카드에 괄호가 붙지 않고 깨지지 않는다. 태스크 1(스키마)·태스크 4(웹) 시험.
5. **`configDir` 없고 `~/.claude` 도 없는 새 머신** — `auth: "missing"` 과 평소 사유 문구. 태스크 3 시험.

---

### Task 1: 와이어 — `RunnerProgramStatus.login`

**Files:**
- Modify: `packages/shared/src/runner/index.ts` (`RunnerProgramStatus`, 186행 근처)
- Test: `packages/shared/test/runner-v2.test.ts`

**Interfaces:**
- Produces: `RunnerProgramStatus.login?: "default" | "dedicated"` (shared 에서 `RunnerProgramLogin` 타입도 export).

- [ ] **Step 1: 실패하는 시험** — `runner-v2.test.ts` 에 둘:
  - `"hello 프로그램 상태 — login 은 default·dedicated 를 받고 없어도 받는다"`: 기존 hello 픽스처의 프로그램에 `login: "default"` 를 얹어 `RunnerHello.parse` 결과의 `programs[0].login` 이 `"default"`, `"dedicated"` 도 같게, 필드를 뺀 픽스처는 `login` 이 `undefined`.
  - `"hello 프로그램 상태 — 모르는 login 값은 거절"`: `login: "shared"` 이면 `safeParse(...).success === false`.
- [ ] **Step 2:** `pnpm -F @dodok/shared test -- runner-v2` → 첫 시험 FAIL(`login` 이 벗겨짐).
- [ ] **Step 3:** `RunnerProgramLogin = z.enum(["default", "dedicated"])` 를 export 하고 `RunnerProgramStatus` 에 `login: RunnerProgramLogin.optional()` — 주석: 「러너가 쓰는 Claude 로그인 — 평소(`~/.claude`)·전용(설정 configDir). 옛 러너는 싣지 않는다」.
- [ ] **Step 4:** 같은 명령 → PASS, 실행 수 확인.
- [ ] **Step 5: 커밋** `feat(shared): carry runner program login kind in hello`

### Task 2: 러너 설정 — `configDir` 선택, 프로세스·CLI env

**Files:**
- Create: `packages/claude-runner/src/drivers/claude/config-dir.ts`
- Modify: `packages/claude-runner/src/config.ts:23-29`(스키마), `:141-145`(해석)
- Modify: `packages/claude-runner/src/main.ts:69-71`
- Modify: `packages/claude-runner/src/driver.ts:19-20` (`RunSpec.configDir?: string`)
- Modify: `packages/claude-runner/src/connection.ts:427` (값이 없을 수 있음 — 키를 빼고 넘긴다)
- Modify: `packages/claude-runner/src/drivers/claude/run.ts` `buildQueryOptions` (85행)
- Test: `packages/claude-runner/test/config.test.ts`, `packages/claude-runner/test/config-dir.test.ts`(새 파일), `packages/claude-runner/test/run.test.ts`, `packages/claude-runner/test/connection.test.ts`(530행 근처), `packages/claude-runner/test/helpers/fixtures.ts`, `packages/claude-runner/test/adapter-integration.test.ts`

**Interfaces:**
- Produces (`config-dir.ts`):
  - `resolveClaudeConfigDir(ceiling: Pick<ProgramCeiling, "configDir">, env: NodeJS.ProcessEnv): { login: "default" | "dedicated"; dir: string | undefined }` — `configDir` 있으면 `{ "dedicated", configDir }`, 없으면 `{ "default", env.CLAUDE_CONFIG_DIR || undefined }`(빈 문자열은 `undefined`).
  - `applyClaudeConfigDirEnv(env: NodeJS.ProcessEnv, ceiling: Pick<ProgramCeiling, "configDir"> | undefined): void` — 전용이면 `env.CLAUDE_CONFIG_DIR = configDir`, 평소면 값이 빈 문자열일 때 `delete`, 값이 있으면 둔다. `ceiling` 이 `undefined`(claude 프로그램을 안 켬)면 아무것도 안 한다.
- Consumes: 없음(태스크 1 과 독립).

- [ ] **Step 1: 실패하는 시험**
  - `config.test.ts`: `"programs.claude.configDir 이 없어도 받는다 — 해석된 값에도 없다"`(`programs: { claude: {} }` → `config.programs.claude?.configDir === undefined`), `"configDir 빈 문자열은 거절"`(오류 문구에 `programs.claude.configDir`). 기존 「있으면 홈으로 풀린다」 시험은 그대로 둔다.
  - `config-dir.test.ts`(새): `resolveClaudeConfigDir` 네 갈래 — 전용 / 평소+env 없음 → `dir: undefined` / 평소+`CLAUDE_CONFIG_DIR: "/x"` → `"/x"` / 평소+`""` → `undefined`. `applyClaudeConfigDirEnv` 넷 — 전용이면 셸 값 `/x` 를 `configDir` 로 덮음 / 평소+`""` 이면 키가 사라짐(`"CLAUDE_CONFIG_DIR" in env === false`) / 평소+`/x` 면 그대로 / `undefined` ceiling 이면 env 불변.
  - `run.test.ts`: 기존 122행 시험은 `spec.configDir` 있는 전용 길 그대로. 더한다 — `"configDir 이 없으면 baseEnv 의 CLAUDE_CONFIG_DIR 을 CLI 에 — 러너 프로세스와 같은 자리"`(`runStart({ configDir: undefined })` 꼴로 키를 뺀 spec, `BASE_ENV.CLAUDE_CONFIG_DIR` `/home/u/.claude` → `env.CLAUDE_CONFIG_DIR === "/home/u/.claude"`), `"configDir 도 baseEnv 값도 없으면 CLAUDE_CONFIG_DIR 을 넣지 않는다"`(`"CLAUDE_CONFIG_DIR" in env === false`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY` 는 `"1"` 그대로).
- [ ] **Step 2:** `pnpm -F @dodok/runner test` → 새 시험 FAIL. (패키지 이름은 `packages/claude-runner/package.json` 의 `name` — `@dodok/runner`.)
- [ ] **Step 3: 구현**
  - `config.ts`: `configDir: z.string().min(1).optional()`; 해석에서 `configDir` 이 있을 때만 `expandHome`(없으면 키를 만들지 않는다 — 조건부 전개).
  - `config-dir.ts`: 위 두 함수. 파일 머리 주석에 ADR 0007 5.2(두 자리를 같게)와 바이너리 사실(`CLAUDE_CONFIG_DIR` 이 있기만 하면 키체인 이름에 해시)을 한 줄씩.
  - `main.ts`: 71행을 `applyClaudeConfigDirEnv(process.env, config.programs.claude)` 로. 주석 갱신.
  - `driver.ts`: `configDir?: string` — 주석 「없으면 평소 로그인(러너 프로세스의 CLAUDE_CONFIG_DIR 또는 ~/.claude)」.
  - `connection.ts`: `...(programCeiling.configDir === undefined ? {} : { configDir: programCeiling.configDir })`.
  - `run.ts`: `const dir = spec.configDir ?? (deps.baseEnv.CLAUDE_CONFIG_DIR || undefined); if (dir) env.CLAUDE_CONFIG_DIR = dir;` 꼴. 주석에 불변식.
  - `fixtures.ts`·`adapter-integration.test.ts`·`connection.test.ts`: 타입이 바뀐 자리만 맞춘다(전용 픽스처 `AGENT.configDir` 는 그대로 둔다 — 전용 길 회귀 시험).
- [ ] **Step 4:** `pnpm -F @dodok/runner test` → PASS(실행 수 적기), `pnpm -F @dodok/runner typecheck`.
- [ ] **Step 5: 커밋** `feat(runner): make programs.claude.configDir optional and default to the usual claude login`

### Task 3: 러너 `detect` — 유효 자리·`login`

**Files:**
- Modify: `packages/claude-runner/src/driver.ts:30` (`ProgramDetection` 에 `"login"`)
- Modify: `packages/claude-runner/src/drivers/claude/index.ts:34-45`
- Test: `packages/claude-runner/test/connection.test.ts`(264행 「hello — 로그인 디렉터리가 있으면 …」 근처, 255행 경로 비노출 단언)

**Interfaces:**
- Consumes: 태스크 1 `RunnerProgramStatus.login`, 태스크 2 `resolveClaudeConfigDir`.
- Produces: hello `programs[]` 의 claude 줄에 늘 `login` 이 실린다.

- [ ] **Step 1: 실패하는 시험** (`createClaudeDriver({ …, baseEnv })` 로 env 를 준다)
  - `"hello — configDir 이 있으면 login dedicated"`: 기존 264행 시험에 `login: "dedicated"` 단언을 더한다.
  - `"hello — configDir 이 없으면 login default, 평소 자리(HOME/.claude)가 있으면 auth unknown"`: `baseEnv: { HOME: <임시 디렉터리> }` 이고 그 안에 `.claude/` 를 만든다 → `auth: "unknown"`, `login: "default"`, `reason` 없음.
  - `"hello — configDir 이 없고 평소 자리가 없으면 missing 과 평소 사유"`: `.claude/` 없음 → `auth: "missing"`, `reason` 이 전역 제약의 평소 사유 문구와 같다.
  - `"hello — configDir 이 없고 CLAUDE_CONFIG_DIR 이 있으면 그 디렉터리를 본다"`: `baseEnv: { HOME: h, CLAUDE_CONFIG_DIR: <있는 임시 디렉터리> }`, `h/.claude` 없음 → `auth: "unknown"`.
  - 255행 경로 비노출 단언 루프에 임시 HOME 경로도 넣는다.
- [ ] **Step 2:** `pnpm -F @dodok/runner test -- connection` → FAIL.
- [ ] **Step 3: 구현** — `detect(ceiling)`: `const { login, dir } = resolveClaudeConfigDir(ceiling, opts.baseEnv ?? process.env)`; 본 자리는 `dir ?? join(env.HOME || homedir(), ".claude")`. 있으면 `{ available, version, auth: "unknown", login }`, 없으면 `auth: "missing"` + 갈래별 사유(전역 제약 문구). 34행 주석 갱신.
- [ ] **Step 4:** `pnpm -F @dodok/runner test` → PASS(실행 수), typecheck.
- [ ] **Step 5: 커밋** `feat(runner): report usual or dedicated claude login in hello`

### Task 4: 웹 러너 카드·가짜 러너

**Files:**
- Modify: `apps/web/src/features/runners/copy.ts:61-62` (새 `LOGIN_LABEL`)
- Modify: `apps/web/src/features/runners/RunnersPage.tsx:175` (`ProgramLine`)
- Modify: `apps/server/scripts/dev-fake.ts` (「dev-fake」 Claude 줄 `login: "default"`, 「dev-fake 제한」 Claude 줄 `login: "dedicated"`)
- Modify: `apps/server/test/fakes/fake-runner.ts:202-209` (`FAKE_CLAUDE_PROGRAM` 은 `login` 없이 둔다 — 옛 러너 꼴 회귀)
- Test: `apps/web/src/features/runners/runners.test.tsx`, `apps/web/test/runnersServer.tsx`

**Interfaces:**
- Consumes: 태스크 1 `RunnerProgramStatus.login`.
- Produces: `LOGIN_LABEL = { default: "평소 로그인", dedicated: "전용 로그인" } as const`.

- [ ] **Step 1: 실패하는 시험** (`runners.test.tsx` 68행 근처 꼴)
  - `"프로그램 줄 — login default 면 로그인 상태 뒤에 (평소 로그인)"`: 텍스트 `Claude Code 2.1.283 · 로그인됨 (평소 로그인) · 권한 상한 default …`.
  - `"프로그램 줄 — login dedicated 면 (전용 로그인)"`.
  - 기존 68행 시험(필드 없음)은 괄호 없는 문구 그대로 통과해야 한다 — 옛 러너 회귀.
  - `runnersServer.tsx` 는 시험이 `login` 을 고를 수 있게 프로그램 줄 덮어쓰기를 받는지 보고, 없으면 더한다.
- [ ] **Step 2:** `pnpm -F @dodok/web test -- runners` → FAIL.
- [ ] **Step 3: 구현** — `{AUTH_LABEL[program.auth]}{program.login && <> ({LOGIN_LABEL[program.login]})</>}`. dev-fake 두 줄.
- [ ] **Step 4:** `pnpm -F @dodok/web test`·`pnpm -F @dodok/server test`(혼자, 실행 수) → PASS. 서버 시험 중 프로그램 상태를 통째 단언하는 것(`apps/server/test/integration/runner-projects.test.ts`, `packages/runner-adapter/test/runner-adapter.test.ts`)이 깨지면 그 자리만 맞춘다.
- [ ] **Step 5: 커밋** `feat(web): show whether a runner uses the usual or a dedicated claude login`

### Task 5: 설치 안내 2단계·설정 예시·llms.txt

**Files:**
- Modify: `apps/web/src/features/setup/runnerConfig.ts:22-29` (예시에서 `configDir` 줄 삭제, `RUNNER_CLAUDE_DIR` 주석을 「전용 로그인을 원할 때의 디렉터리」로)
- Modify: `apps/web/src/features/setup/RunnerSection.tsx:18-24, 124-131`
- Modify: `apps/server/src/modules/setup/llms.ts:30-31, 120-125, 150-154`
- Test: `apps/web/src/features/setup/runner.test.tsx`, `apps/server/test/setup.llms.test.ts`

**Interfaces:**
- Produces (`RunnerSection.tsx`): `RUNNER_LOGIN_COMMAND = "claude"`, `RUNNER_LOGIN_BUNDLED_COMMAND` 은 지금 값에서 `CLAUDE_CONFIG_DIR=${RUNNER_CLAUDE_DIR} ` 접두사를 뗀 것, 새 `RUNNER_DEDICATED_LOGIN_COMMAND = \`CLAUDE_CONFIG_DIR=${RUNNER_CLAUDE_DIR} claude\``.

- [ ] **Step 1: 실패하는 시험**
  - `runner.test.tsx`: `"설치 2단계 — 평소 로그인을 쓰고 로그인돼 있으면 건너뛴다"`(본문 `러너는 이 머신의 평소 Claude Code 로그인을 씁니다.` 와 `claude 로 로그인돼 있으면 건너뜁니다.` 가 보이고, 복사 블록 `claude`), `"설치 2단계 — 전용 로그인은 접힌 안내 안에"`(「러너 전용 로그인을 따로 쓰려면」을 펼치면 `CLAUDE_CONFIG_DIR=~/.dodok-runner/claude claude` 와 `"configDir": "~/.dodok-runner/claude"`), `"설치 2단계 — 이메일·--resume 경고"`(`계정 이메일이 에이전트에게 보이고` 포함). 152행 근처 설정 예시 단언에서 `configDir` 기대를 빼고 `programs.claude` 에 `configDir` 키가 **없음**을 단언.
  - `setup.llms.test.ts`: 예시 JSON 을 `RunnerConfig` 로 파싱(있는 시험 — `configDir` 없이 통과해야 함) + `programs.claude.configDir === undefined`. 3단계 문구에 `claude auth status` 와 `CLAUDE_CONFIG_DIR=~/.dodok-runner/claude` 가 **「전용 로그인을 원한다고 하면」 뒤에만** 나오는지(첫 등장 위치가 그 구절 뒤).
- [ ] **Step 2:** `pnpm -F @dodok/web test -- runner.test` · `pnpm -F @dodok/server test -- setup.llms` → FAIL.
- [ ] **Step 3: 구현** — 문구는 스펙 4.4 를 그대로 옮긴다. 접힘은 같은 파일의 「서버와 같은 빌드로 설치」(`SameBuildInstall`) 꼴을 따른다. 경고 줄은 `text-muted-foreground`. llms 3단계는 스펙 4.4 의 서술 그대로(AI 가 먼저 묻지 않는다), 번들 CLI 줄은 접두사 없이.
- [ ] **Step 4:** 두 패키지 시험 PASS(실행 수), `pnpm typecheck`, `pnpm lint`, `pnpm fmt`.
- [ ] **Step 5: 커밋** `feat(web,server): install guide uses the usual claude login by default`

### Task 6: 문서

**Files:**
- Modify: `docs/guides/docker-deploy.md` 「러너 설치」 3·4번(417-448행 근처)
- Modify: `docs/manual/user-guide.md` 458·486·531행 근처
- Modify: `docs/guides/live-smoke.md` 949행 근처(실제 API 런 절) — 하네스 절(836-943행)은 스크래치 `configDir` 을 계속 적는 것이 맞으니 문장만 확인
- Modify: `packages/claude-runner/README.md` 20-35행 근처
- Modify: `docs/adr/0007-claude-agent-sdk-spike.md` 9절 표 「8 격리」 줄
- Modify: `docs/guides/plan.md` 10장 결정 표(23번 뒤에 24번) · 1장 판본 표에 이 변경 한 줄이 관례면 더한다

- [ ] **Step 1:** docker-deploy 3번을 「러너는 평소 Claude Code 로그인을 쓴다 — 로그인돼 있으면 건너뛴다. 전용 로그인을 원하면 `CLAUDE_CONFIG_DIR=~/.dodok-runner/claude claude` 로 로그인하고 4번 설정에 `configDir` 을 적는다(전사도 그 디렉터리에 따로)」로, 스펙 4.5 주의 한 줄(「채널에서 쓰는 러너 세션을 터미널에서 이어 쓰지 않는다 — 대화가 섞인다.」)과 이메일·`--resume` 안내, 4번 예시에서 `configDir` 삭제·`programs` 설명에 「`configDir` 은 선택 — 적으면 전용 로그인」.
- [ ] **Step 2:** user-guide 세 자리(스펙 5장 「문서」 그대로), README, live-smoke 949행, ADR 0007 9절(덧붙임 문장은 스펙 5장 그대로), plan.md 24번(`| 24 | 러너의 Claude 로그인 | **기본은 평소 로그인**(`~/.claude` — 이메일·전사 공유 감수), `configDir` 은 전용 로그인을 원할 때만. 셸의 `CLAUDE_CONFIG_DIR` 은 평소 자리로 따른다 | 2026-11-02 (runner-default-claude-login 설계) |`).
- [ ] **Step 3:** `grep -rn 'dodok-runner/claude' docs packages/claude-runner/README.md apps` 로 남은 자리를 다시 세고, 남은 것이 「전용 로그인」 문맥뿐인지 표본을 연다. 표 줄과 `---` 앞 빈 줄을 눈으로 본다(oxfmt 는 md 를 안 본다).
- [ ] **Step 4: 커밋** `docs: describe the usual claude login as the runner default`

### Task 7: 전체 확인

- [ ] **Step 1:** `pnpm typecheck` → `pnpm lint` → `pnpm fmt:check` → 혼자 `pnpm exec turbo run test --continue` — 패키지별 실행 수를 보고에 적는다.
- [ ] **Step 2: 웹 손 확인** — `pnpm -F @dodok/server dev:fake` + `pnpm -F @dodok/web dev`, `http://localhost:5173` 의 러너 탭에서 「dev-fake」 카드에 `(평소 로그인)`, 「dev-fake 제한」에 `(전용 로그인)`, 설정의 러너 설치 2단계 문구·접힘. 브라우저 도구는 AGENTS.md 「BrowserOS neo」 절, 연 탭은 닫는다.
- [ ] **Step 3: (사람 승인 뒤에만) 평소 로그인이 잡히는지** — `configDir` 없는 설정으로 러너 프로세스 env 를 `applyClaudeConfigDirEnv` 꼴로 맞추고, 사용자 메시지 없는 `query()` 를 열어 `accountInfo()` 의 `subscriptionType`·`apiProvider` 만 적고 `close()` (ADR 0007 7의 8). 이메일·조직은 적지 않는다. 모델 런은 하지 않는다. 승인이 없으면 건너뛰고 보고에 「미확인」으로 적는다.

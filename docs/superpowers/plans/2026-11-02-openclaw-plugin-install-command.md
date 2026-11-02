# OpenClaw 플러그인 설치 명령 한 줄로 — 구현계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 저장소에서는 Orca 가 살아 있으면 태스크마다 `scripts/orca-worker.sh` 워커가 한다(AGENTS.md 「작업 방식」).

**Goal:** 브리지 토큰 발급 대화상자의 한 줄(`curl … | DODOK_BRIDGE_TOKEN='…' bash`)이 Gateway 호스트에서 다운로드·sha 대조·Gateway 내리기·설치·번들 대조·계정 설정·Gateway 올리기를 다 한다.

**Architecture:** 서버가 부팅 때 설치 스크립트를 `llms.txt` 처럼 한 번 렌더해 인증 없이 내준다(`GET /api/v1/setup/plugin-install.sh`). 스크립트는 토큰을 환경 변수로만 받아 기존 `plugin.tgz`(브리지 토큰 인증)를 받는다. 웹은 「플러그인 받기」를 없애고 발급 대화상자에 그 한 줄을 보인다. `llms.txt`·문서는 스크립트를 가리킨다.

**Tech Stack:** Fastify(서버)·React(웹)·Zod 공유 상수·bash 스크립트·vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-openclaw-plugin-install-command-design.md`

## Global Constraints

- 스크립트 경로: `/api/v1/setup/plugin-install.sh` — `packages/shared/src/setup/index.ts` 의 `PLUGIN_INSTALL_SCRIPT_PATH` 하나만 쓴다(서버 라우트·웹 명령·llms.txt 가 같은 상수).
- 사람용 한 줄(맨 앞 공백 한 칸 포함): `` ` curl -fsS ${origin}${PLUGIN_INSTALL_SCRIPT_PATH} | DODOK_BRIDGE_TOKEN='${token}' bash` ``.
- 토큰은 환경 변수 `DODOK_BRIDGE_TOKEN` 으로만, 꼴 `^dbt_[A-Za-z0-9_-]{43}$`. 어떤 프로세스의 argv 에도 들어가지 않는다(`curl -K -`·`openclaw config patch --stdin` 의 표준 입력, `printf` 셸 내장).
- 탈출구 환경 변수 `DODOK_GATEWAY_SERVICE=0` — `openclaw gateway stop`·`start` 를 건너뛴다.
- 스크립트 전제: `openclaw gateway stop --force`, `openclaw plugins install <tgz> --force --accept-capabilities`, `openclaw config patch --stdin`, `openclaw gateway start`. `jq` 를 쓰지 않는다(JSON 은 `node -e`). sha256 도구는 `sha256sum`, 없으면 `shasum -a 256`.
- 번들 경로: `${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/extensions/dodok/dist/index.js`.
- 본문은 함수 하나로 감싸고 맨 끝 줄에서만 부른다. 표준 입력을 쓰지 않는 자식 호출은 `</dev/null`.
- 스크립트 엔드포인트: 인증 없음, `/llms.txt` 와 같은 `llmsLimit` 훅, 머리 `content-type: text/plain; charset=utf-8`·`x-content-type-options: nosniff`, 품은 tgz 가 없으면 404 `PLUGIN_FILE_MISSING`.
- 발급 응답의 `pluginConfig` 필드(서버·shared 계약)는 그대로 둔다 — 웹이 그리지 않을 뿐이다.
- 커밋: 경로를 명시해 stage, Conventional Commits(패키지 스코프), 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `pnpm test` 는 typecheck·build 와 동시에 돌리지 않는다. 실행 수를 보고에 적는다.

## Review Focus

1. **스크립트가 도중에 끊겨 받힌다** — 아무것도 하지 않아야 한다(끝의 호출 줄이 없으면 함수만 정의되고 끝). → Task 1 「잘린 본문」 시험.
2. **기본이 아닌 상태 디렉터리(`OPENCLAW_STATE_DIR`)** — 번들 대조가 그 디렉터리의 파일을 봐야 한다(기본 경로를 보면 옛 파일로 「같다」고 잘못 판정). → Task 1 시험.
3. **macOS 호스트(`sha256sum` 없음)** — `shasum -a 256` 으로 대조. → Task 1 시험(PATH 에서 `sha256sum` 을 뺀 실행).
4. **서버가 그새 다시 빌드됨(409)·파일 없음(404)·토큰 거절(401)** — 각각 알아볼 문구로 멈추고 Gateway 는 건드리지 않는다. → Task 1 시험.
5. **Gateway 가 서비스가 아님(`gateway stop` 실패)** — 설치하지 않고 `DODOK_GATEWAY_SERVICE=0` 을 안내한다. → Task 1 시험.

---

### Task 1: 설치 스크립트 렌더러와 동작 시험

**Files:**
- Create: `apps/server/src/modules/setup/plugin-install-script.ts`
- Modify: `packages/shared/src/setup/index.ts`(상수 추가)
- Test: `apps/server/test/setup.plugin-install-script.test.ts`

**Interfaces:**
- Produces: `PLUGIN_INSTALL_SCRIPT_PATH = "/api/v1/setup/plugin-install.sh"`(shared, `export const`).
- Produces: `renderPluginInstallScript(input: { origin: string; bridgeUrl: string; plugin: LlmsFileInfo }): string` — `LlmsFileInfo` 는 `apps/server/src/modules/setup/llms.ts` 의 `{ sha256; bundleSha256 }`.

시험 하네스(이 파일 안의 도우미): 임시 디렉터리에 `bin/` 을 만들고 가짜 `openclaw`·`curl` 셸 스크립트를 둔다. 둘 다 `"$0 $*"` 를 `$LOG` 에 한 줄씩 적는다.
- 가짜 `curl`: 표준 입력을 `$STUB_DIR/curl.stdin` 에 저장, `-o` 다음 인자 자리에 `$STUB_TGZ` 를 복사, `-w` 가 있으면 `${STUB_HTTP:-200}` 을 찍는다.
- 가짜 `openclaw`: `gateway stop` 은 `$STUB_STOP_FAIL` 이면 1, `plugins install` 은 `$STUB_INSTALL_FAIL` 이면 1 아니면 `$STUB_BUNDLE` 을 `${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/extensions/dodok/dist/index.js` 로 복사, `plugins inspect dodok --json` 은 `{"plugin":{"status":"loaded","channelIds":["dodok"]}}`, `config patch --stdin` 은 표준 입력을 `$STUB_DIR/patch.json` 에 두고 `$STUB_PATCH_FAIL` 이면 1.
- 실행: `spawnSync("bash", ["-c", 'bash < "$SCRIPT"'], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, DODOK_BRIDGE_TOKEN: TOKEN, ... } })` — `bash` 의 표준 입력이 본문이라 `curl | bash` 와 같은 조건이다.
- 픽스처: `STUB_TGZ` 는 아무 바이트, `plugin.sha256` 은 그 바이트의 sha256. `STUB_BUNDLE` 도 같은 식.

- [ ] **Step 1: 실패하는 시험을 쓴다** — `describe("plugin-install.sh")` 아래:
  - `"bash -n 으로 문법이 맞다"` — 렌더 결과를 `bash -n` 으로 돌려 종료 코드 0.
  - `"정상 — stop → install → inspect → patch → start 순서, 끝 코드 0"` — `$LOG` 의 `openclaw` 줄이 정확히 `gateway stop --force`, `plugins install <dir>/… --force --accept-capabilities`, `plugins inspect dodok --json`, `config patch --stdin`, `gateway start` 순서. `curl` 줄에 `${origin}/api/v1/setup/plugin.tgz` 가 있다. `patch.json` 을 JSON 으로 읽으면 `{channels:{dodok:{accounts:{default:{bridgeUrl, token: TOKEN}}}}}`. `curl.stdin` 에 `Authorization: Bearer ${TOKEN}`.
  - `"토큰은 어떤 argv 에도 없다"` — `$LOG` 전체에 `TOKEN` 이 없다.
  - `"파일 sha 가 다르면 gateway 를 건드리지 않고 멈춘다"` — `plugin.sha256` 을 다른 값으로 렌더 → 끝 코드 ≠ 0, `$LOG` 에 `gateway` 가 없다.
  - `"401·404·409 면 알아볼 문구로 멈추고 gateway 를 건드리지 않는다"` — `STUB_HTTP` 각각 → 끝 코드 ≠ 0, 표준 오류에 각각 `새로 발급`·`PLUGIN_FILE_MISSING` 또는 `파일이 없습니다`·`재시작` 이 들어 있고 `$LOG` 에 `gateway` 가 없다.
  - `"gateway stop 이 실패하면 설치하지 않고 DODOK_GATEWAY_SERVICE=0 을 알린다"` — 끝 코드 ≠ 0, `plugins install` 없음, 표준 오류에 `DODOK_GATEWAY_SERVICE=0`.
  - `"DODOK_GATEWAY_SERVICE=0 이면 stop·start 없이 설치·patch 하고 직접 올리라고 알린다"`.
  - `"설치가 실패하면 gateway start 를 다시 부르고 실패로 끝난다"` — `STUB_INSTALL_FAIL=1` → `gateway start` 가 `$LOG` 에 있고 끝 코드 ≠ 0.
  - `"번들 sha 가 다르면 gateway 를 다시 올리고 실패로 끝난다"` — `plugin.bundleSha256` 을 다른 값으로.
  - `"patch 가 실패하면 gateway 를 다시 올리고 토큰 폐기를 안내한다"` — 표준 오류에 `폐기`.
  - `"OPENCLAW_STATE_DIR 의 번들을 대조한다"` — env 로 다른 디렉터리를 주면 정상 끝, 기본 `$HOME/.openclaw` 에는 파일이 없다.
  - `"sha256sum 이 없으면 shasum -a 256 으로 대조한다"` — PATH 를 가짜 `bin/` + 필요한 도구만 심볼릭 링크로 둔 디렉터리로 꾸미고(`sha256sum` 은 빼고 `shasum` 은 넣는다) 정상 끝. 이 머신에 `shasum` 이 없으면 `it.skipIf`.
  - `"토큰이 없거나 꼴이 다르면 아무것도 부르지 않는다"` — `$LOG` 가 비어 있다.
  - `"잘린 본문은 아무것도 하지 않는다"` — 렌더 결과의 마지막 비지 않은 줄을 뺀 본문을 돌리면 `$LOG` 가 비어 있다.
- [ ] **Step 2: 돌려 실패를 본다** — `pnpm -F @dodok/server exec vitest run test/setup.plugin-install-script.test.ts` → 모듈이 없어 FAIL.
- [ ] **Step 3: shared 상수와 `renderPluginInstallScript` 를 만든다** — 스펙 「2. 스크립트가 하는 일」 순서 그대로. 내려받기는 `curl -sS -o "$out" -w '%{http_code}' -K - "$url"`(표준 입력으로 `header = "Authorization: Bearer …"`)로 상태 코드를 받아 200 이 아니면 코드별 문구. `trap` 은 임시 디렉터리를 지우고, 5번 뒤 실패 때 Gateway 를 다시 올리는 일은 「내렸는가」 플래그로 가른다. 렌더 값(origin·bridgeUrl·sha)은 셸 작은따옴표 안에 넣는다 — 값에 `'` 가 있으면 렌더가 던진다(공개 주소·hex 라 정상 입력에는 없다).
- [ ] **Step 4: 돌려 통과를 본다** — 같은 명령 → PASS, 실행 수(14 안팎)를 적는다.
- [ ] **Step 5: 커밋** — `git add packages/shared/src/setup/index.ts apps/server/src/modules/setup/plugin-install-script.ts apps/server/test/setup.plugin-install-script.test.ts` → `feat(server): render one-shot OpenClaw plugin install script`.

### Task 2: 스크립트 엔드포인트와 llms.txt 절

**Files:**
- Modify: `apps/server/src/modules/setup/routes.ts`(`SetupRouteContext` 에 `pluginInstallScript: string | null`, 라우트 추가)
- Modify: `apps/server/src/app.ts:666-687`(`registerSetupRoutes` 호출에 렌더 결과 — `pluginFile` 이 없으면 `null`)
- Modify: `apps/server/src/modules/setup/llms.ts`(`gatewaySection`)
- Test: `apps/server/test/setup.routes.test.ts`, `apps/server/test/setup.llms.test.ts`

**Interfaces:**
- Consumes: `renderPluginInstallScript`, `PLUGIN_INSTALL_SCRIPT_PATH`(Task 1).
- Produces: `GET ${PLUGIN_INSTALL_SCRIPT_PATH}` 응답.

- [ ] **Step 1: 실패하는 시험** — `setup.routes.test.ts`:
  - `"GET plugin-install.sh — 로그인 없이 200, text/plain·nosniff, 본문에 bridgeUrl·두 sha·plugin.tgz 주소"`.
  - `"GET plugin-install.sh — llms.txt 와 같은 IP 버킷"`(한도를 넘기면 429 — 기존 llms.txt 레이트 시험의 꼴을 따른다).
  - 「플러그인 파일이 없을 때」 describe 에 `"plugin-install.sh 도 404 PLUGIN_FILE_MISSING"`.
  - `setup.llms.test.ts`: 「OpenClaw Gateway 호스트」 절이 `PLUGIN_INSTALL_SCRIPT_PATH` 를 `-o` 로 받고 `DODOK_BRIDGE_TOKEN="$(cat ~/.dodok-bridge-token)" bash` 로 돌리며, 옛 단계(`openclaw plugins install`·`openclaw config patch` 를 AI 가 직접 치는 줄)가 없다. 절 제목·`llmsHandoffLine("bridge", …)` 대조는 그대로 통과.
- [ ] **Step 2: 돌려 실패를 본다** — `pnpm -F @dodok/server exec vitest run test/setup.routes.test.ts test/setup.llms.test.ts`.
- [ ] **Step 3: 라우트·배선·`gatewaySection` 을 고친다** — `gatewaySection` 은 스펙 「5. llms.txt」: ① 토큰을 0600 파일에(지금 1번 그대로) ② `mktemp -d` 자리에 스크립트를 `-o` 로 받아 읽는다 ③ `DODOK_BRIDGE_TOKEN="$(cat ~/.dodok-bridge-token)" bash "$dir/install.sh"; rm -f ~/.dodok-bridge-token` ④ 스크립트가 `DODOK_GATEWAY_SERVICE=0` 을 말하면 멈추고 사람에게 Gateway 를 어떻게 돌리는지 묻는다 ⑤ 끝 확인(연결 페이지 카드·페어링 승인)은 지금 5번 그대로. 파일 sha·번들 sha 목록 줄은 두되 「스크립트가 대조한다」로.
- [ ] **Step 4: 돌려 통과를 본다** — 같은 명령, 실행 수를 적는다. 이어서 `pnpm -F @dodok/server typecheck`.
- [ ] **Step 5: 커밋** — 위 다섯 경로 → `feat(server): serve plugin install script and point llms.txt at it`.

### Task 3: 웹 — 발급 대화상자 한 줄, 블록 머리·카드 문구, 받기 제거

**Files:**
- Modify: `apps/web/src/features/setup/sections.tsx`(`PluginDownload` → `PluginInstall`, `installCommands`·`downloadError` 제거, `pluginInstallCommand` 추가)
- Modify: `apps/web/src/features/setup/ConnectionPage.tsx:10,37`(이름 바꿈)
- Modify: `apps/web/src/features/setup/IssueTokenDialog.tsx`(`IssueTokenDialog` 에 `pluginFileAvailable: boolean` prop, 「플러그인 설정」 → 「설치 명령」)
- Modify: `apps/web/src/features/setup/GatewayCard.tsx:170-190,223-226`(`BuildMatch` 문구, `PluginStatus` 주석, prop 전달 `status.pluginFile.available`)
- Modify: `apps/web/src/features/setup/mutations.ts:207-212`(`downloadPluginFile`·`useDownloadPlugin` 제거 — `downloadPackedFile` 은 러너가 쓰므로 남긴다)
- Test: `apps/web/src/features/setup/issueToken.test.tsx`, `apps/web/src/features/setup/connection.test.tsx`

**Interfaces:**
- Consumes: `PLUGIN_INSTALL_SCRIPT_PATH`(Task 1, `@dodok/shared`).
- Produces: `pluginInstallCommand(origin: string, token: string): string` — `sections.tsx` 에서 export. 값은 Global Constraints 의 한 줄.

- [ ] **Step 1: 실패하는 시험**
  - `issueToken.test.tsx` 첫 시험을 바꾼다: `getByTestId("plugin-install-command").textContent` 가 `pluginInstallCommand(publicOriginOf(PUBLIC_URL), RAW_TOKEN)` 와 같고, `" curl -fsS "` 로 시작하며 `DODOK_BRIDGE_TOKEN='${RAW_TOKEN}' bash` 로 끝난다. `queryByTestId("plugin-config")` 없음. 「설치 명령 복사」 버튼이 그 문자열을 복사. 두 번째 시험(좁은 화면)은 `plugin-config` 대신 `plugin-install-command` 블록이 `whitespace-pre`·`overflow-x-auto`·부모 `min-w-0`.
  - 새 시험 `"서버에 플러그인 파일이 없으면 설치 명령 대신 만드는 명령"` — `stubSetupServer` 의 상태를 `pluginFile: { available: false }` 로 → 대화상자에 `PACK_COMMAND`, `plugin-install-command` 없음, 원문·「AI 에게 맡기기」는 그대로.
  - `connection.test.tsx` 「플러그인」 describe: 첫 시험은 머리 region 이름 「플러그인 설치」, 버튼 「플러그인 받기」·sha·`plugin-install-commands` 가 **없고** 「새 토큰 발급」을 가리키는 안내 한 줄이 있다. 「docker-deploy.md [B] 블록과 글자 그대로」 시험은 지운다(Task 4 가 새 대조를 넣는다). 「다른 빌드면」 시험의 문구를 `/다른 빌드입니다 — 새 토큰을 발급해 설치 명령을 다시 돌리세요/` 로.
- [ ] **Step 2: 돌려 실패를 본다** — `pnpm -F @dodok/web exec vitest run src/features/setup/issueToken.test.tsx src/features/setup/connection.test.tsx`.
- [ ] **Step 3: 구현**
  - 대화상자 「설치 명령」 칸: 제목 「설치 명령」, 설명은 스펙 「3. 웹 — 발급 대화상자」의 제안 문구, `CopyBlock`(label 「설치 명령 복사」, testId `plugin-install-command`, `wrap` 없음).
  - `BuildMatch` 문구: `false` → 「다른 빌드입니다 — 새 토큰을 발급해 설치 명령을 다시 돌리세요」, 번들 sha 모름 → 「빌드를 알 수 없습니다 — 새 토큰을 발급해 설치 명령을 다시 돌리세요」.
  - `PluginInstall`: 제목 「플러그인 설치」, 파일이 있으면 「설치·업데이트는 각 Gateway 카드의 「새 토큰 발급」이 주는 명령 한 줄로 합니다. Gateway 가 여럿이면 호스트마다 그 카드에서 발급해 돌립니다.」, 없으면 지금 문구 + `PACK_COMMAND`.
- [ ] **Step 4: 돌려 통과를 본다** — 같은 명령, 이어서 `pnpm -F @dodok/web typecheck`·`pnpm lint`. 실행 수를 적는다. `pnpm -F @dodok/web test` 전체도 혼자 한 번(다른 검사와 동시에 돌리지 않는다).
- [ ] **Step 5: 커밋** — 위 일곱 경로 → `feat(web): show one-line plugin install command in bridge token dialog`.

### Task 4: 문서와 문서 대조 시험

**Files:**
- Modify: `docs/guides/docker-deploy.md`(체크리스트 4 「[웹 → B] 플러그인 설치·브리지 토큰」, 「브리지 토큰 교체」, 업데이트 절 724행 근처, 문제 표 802·804행, 「사람이 한 번 따라 한 결과」 표 875행)
- Modify: `docs/manual/user-guide.md:476-480`
- Modify: `docs/guides/plan.md`(8장 완료 한 줄, 「이월」 689·692행 문구)
- Test: `apps/web/src/features/setup/connection.test.tsx`

**Interfaces:**
- Consumes: `pluginInstallCommand`(Task 3).

- [ ] **Step 1: 실패하는 시험** — `connection.test.tsx` 에 `"docker-deploy.md 의 설치 한 줄은 대화상자의 한 줄과 같은 꼴이다"`: 문서에서 `` ` curl -fsS https://<도메인>/api/v1/setup/plugin-install.sh | DODOK_BRIDGE_TOKEN='<브리지 토큰>' bash`` 줄(코드 블록 안, 맨 앞 공백 포함)을 찾아 `pluginInstallCommand("https://<도메인>", "<브리지 토큰>")` 와 글자 그대로 같다.
- [ ] **Step 2: 돌려 실패를 본다**.
- [ ] **Step 3: 문서를 고친다** — 스펙 「6. 문서」. 체크리스트 4 는 ① Gateway 카드에서 「새 토큰 발급」 ② 대화상자의 「설치 명령」을 [B] 에 붙여 넣기 ③ 스크립트가 하는 일 목록(스펙 2절 0~9를 사람 말로) ④ 맨 앞 공백·셸 히스토리 ⑤ `DODOK_GATEWAY_SERVICE=0` ⑥ 지금의 `--accept-capabilities`·`security.installPolicy`·첨부 주의 ⑦ 「AI 에게 맡기는 길」은 그대로. 옛 「플러그인 받기」·[PC] `shasum`·`scp`·「플러그인 설정」 붙여 넣기·[B] 블록은 지운다. 토큰 교체 절은 「새 토큰 발급 → 설치 명령 → 「지금 접속 중」 이동 확인 → 옛 토큰 폐기」(플러그인도 다시 설치된다는 것을 적는다). `**/*.md` 는 oxfmt 가 보지 않으니 `---` 앞 빈 줄과 표 줄을 눈으로 본다.
- [ ] **Step 4: 돌려 통과를 본다** — `pnpm -F @dodok/web exec vitest run src/features/setup/connection.test.tsx`. `grep -nE '플러그인 받기|plugin-config|플러그인 설정' docs/guides/docker-deploy.md docs/manual/user-guide.md` 가 의도한 줄(옛 흐름을 설명하는 이력 문장 외)만 남는지 본다.
- [ ] **Step 5: 커밋** — 위 네 경로 → `docs: describe one-line plugin install command`.

### Task 5: 실연 — dev Gateway 에 스크립트 한 번(모델 런 0)

검증 워커(verify) 몫. 제품 코드는 고치지 않는다 — 실패하면 무엇이 어긋났는지 보고한다.

**Files:**
- Create: `docs/superpowers/reports/2026-11-02-plugin-install-script-live-smoke-report.md`

- [ ] **Step 1:** `docs/guides/live-smoke.md` 「전제」·「3. 절차」의 (a)·(c)·(d) 로 스크래치 CLI(2026.9.4 — AGENTS.md 핀)와 dev Gateway·서버를 띄운다. 플러그인 tgz 는 `pnpm -F @dodok/openclaw-plugin run pack:plugin` 으로 만들고 서버를 재시작한다(끝나면 `packages/openclaw-plugin/dist` 를 지운다 — live-smoke 197행).
- [ ] **Step 2:** 연결 페이지에서 그 Gateway 카드의 「새 토큰 발급」 → 대화상자의 「설치 명령」을 복사해, dev Gateway 는 서비스가 아니므로 `DODOK_GATEWAY_SERVICE=0` 을 붙이고 `OCBIN` 을 PATH 에 둔 셸에서 돌린다(Gateway 는 live-smoke (c) 대로 직접 내리고 올린다). 기대: 끝 코드 0, 카드 「접속됨」·「서버와 같은 빌드입니다」, 옛 토큰 줄에 「이제 폐기해도 됩니다」.
- [ ] **Step 3:** 같은 명령을 틀린 토큰으로 → 401 문구, Gateway·설치본 그대로.
- [ ] **Step 4:** 보고서에 명령·끝 코드·화면 문구를 적고(토큰 원문은 적지 않는다) 커밋 `docs(report): plugin install script live smoke`.

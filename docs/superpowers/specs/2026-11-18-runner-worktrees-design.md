# 러너 프로젝트의 git 워크트리 — 설계

상태: 승인 대기(2026-11-18) · 결정: 사용자와의 대화(2026-11-18), 빌더 확인 1회

## 1. 왜

러너 에이전트는 프로젝트(러너 루트 안의 디렉터리 하나)에 묶여 그 디렉터리에서만 돈다. 같은 git 프로젝트에서 **다른 목적의 일**(기능 A, 버그 B)을 에이전트 여럿에게 맡기면 한 작업 트리를 함께 고쳐 서로 덮어쓴다(사용자). 목적마다 git 워크트리·브랜치를 따로 두고, 에이전트는 그 워크트리에서 돌게 한다. 사용자가 Orca 로 하는 흐름(작업 하나 = 워크트리·브랜치 하나, 합치기는 사람)과 같다.

## 2. 목표 · 하지 않을 것

**목표**
- git 프로젝트에서 워크트리를 만들고, 그 워크트리를 **하위 프로젝트**로 둔다. 에이전트는 지금처럼 프로젝트(= 워크트리) 아래에 만든다 — 한 워크트리에 여러 에이전트(구현·리뷰)를 둘 수 있다.
- 에이전트 만들기 폼에 「새 워크트리에서」 지름길 — 워크트리와 에이전트를 한 번에.
- 워크트리를 보관하면 러너가 워크트리 폴더를 지운다. 브랜치는 남긴다.

**하지 않을 것**
- 병합·PR·rebase(사용자 A — 합치기는 사람이 터미널·IDE 에서). 에이전트에게 채널에서 시키는 것은 막지 않지만 앱 기능은 없다.
- 워크트리를 다른 러너로 옮기는 것.
- 워크트리 안의 워크트리, git 이 아닌 프로젝트의 워크트리.
- OpenClaw 에이전트(러너 에이전트만).

**실패로 볼 것(돌아가도)**
- 보관이 커밋하지 않은 변경을 지우는 것.
- 사람이 입력한 브랜치 이름·경로가 git 옵션이나 셸로 해석되거나, 러너 루트 밖에 폴더가 생기는 것.
- 워크트리를 만들었다고 저장소의 추적 파일(`.gitignore` 등)이 바뀌는 것.
- 옛 러너(이 기능 전 판)에 붙은 프로젝트에서 단추가 눌려 아무 답 없이 멈추는 것.

## 3. 결정

| # | 결정 | 출처 |
| --- | --- | --- |
| W1 | 끝난 뒤 — 브랜치만 남기고 합치기는 사람이 한다. 보관하면 러너가 `git worktree remove` 로 폴더만 지운다 | 사용자(A) |
| W2 | 워크트리 = 하위 프로젝트(부모 프로젝트를 가리키는 `runner_projects` 행). 에이전트는 그 아래에 여럿 | 사용자(1) |
| W3 | 기본 위치 `<저장소 경로>/.worktrees/<이름>` | 사용자 |
| W4 | 만들 때 위치를 고를 수 있다 — 기본값이 채워진 「위치」 칸, 바꾸면 「프로젝트 추가」와 같은 둘러보기·직접 입력(루트 + 경로). 그 러너의 허용 루트 안이어야 한다(런의 천장 검사가 루트 밖을 거절) | 사용자, 루트 제약은 조율자 |
| W5 | `.worktrees/` 를 저장소 파일에 쓰지 않는다 — 저장소의 무시 규칙이 이미 덮지 않으면 `.git/info/exclude` 에 `/.worktrees/` 한 줄. 사람이 고른 다른 위치가 저장소 안이면 그 경로도 같은 식 | 조율자(사용자 이의 없음) |
| W6 | 브랜치 — 기본 `dodok/<이름>`, 바꿀 수 있다. 없는 이름이면 부모 프로젝트의 지금 HEAD 에서 새로 만든다. 있는 이름이면 그 브랜치를 체크아웃한다(다른 워크트리가 이미 쓰고 있으면 git 이 거절 — 그 사유를 보인다) | 조율자(사용자 이의 없음) |
| W7 | 보관 때 커밋하지 않은 변경·추적 안 된 파일이 있으면 지우지 않고 409 「정리하지 못했습니다 — 커밋하지 않은 변경이 있습니다」. **강제 삭제는 없다.** 무시된 파일(`node_modules`·복사한 `.env`·빌드 산출물)은 git 기본대로 함께 지워진다 — 보관 확인 대화상자에 그 한 줄을 적는다. 폴더가 이미 없으면 `git worktree prune` 뒤 보관 | 조율자(사용자 이의 없음), 무시된 파일은 조율자(빌더 확인 Q4) |
| W8 | 사람이 고른 위치도 보관 때 같은 방식(W7)으로 지운다 | 조율자(사용자 이의 없음) |
| W9 | 보관하지 않은 워크트리가 있는 부모 프로젝트는 보관·러너 옮기기를 막는다(「워크트리를 먼저 보관하세요」). 워크트리 프로젝트 자체에는 「옮기기」가 없다 | 조율자 |
| W10 | 만들기·보관 권한은 지금 그 러너의 프로젝트를 만들고 보관할 수 있는 사람과 같다 | 조율자 |
| W11 | 보관하지 않은 에이전트가 있거나 런이 도는 워크트리는 보관을 409 「에이전트를 먼저 보관하세요」로 막는다(폴더를 지우면 남은 에이전트의 다음 런이 천장 검사 `path` 로 깨진다). 보관한 워크트리의 에이전트는 되살리기를 막는다(`restoreAgent` 가 프로젝트가 보관된 워크트리면 409). 일반 프로젝트의 보관 동작(목록 정리뿐)은 그대로 | 조율자(빌더 확인 Q1) |
| W12 | 정리가 실패하면(W7 의 변경 있음·러너 끊김·러너 폐기·git 실패·서브모듈) 그 줄에 사유와 「폴더를 남기고 보관」 단추를 보인다 — 폴더·브랜치를 그대로 두고 행만 보관하므로 잃는 것이 없다. 러너가 폐기됐으면 처음부터 이 단추만 | 조율자(빌더 확인 Q2·Q4) |
| W13 | 러너가 만들었는데 서버가 행을 못 만든 잔해 — 다시 만들 때 `target` 이 **같은 저장소에 등록된 워크트리이고 같은 브랜치**면 러너가 `ok`(`adopted: true`)로 답하고 서버가 행으로 받아들인다. 다른 경우는 `target_exists` | 조율자(빌더 확인 Q3) |
| W14 | git 여부는 프로젝트 행에 저장한다(`is_git` — 저장소의 **주 작업 트리 맨 위**일 때만 참: `git rev-parse --show-toplevel` 이 그 디렉터리이고 `--git-dir` 와 `--git-common-dir` 가 같음). 프로젝트를 만들 때와 「확인」(`/check`) 때 갱신한다. 사람이 다른 도구로 만든 워크트리·저장소의 하위 디렉터리는 거짓 — 워크트리 만들기 단추가 잠긴다(워크트리 안의 워크트리 막기) | 조율자(빌더 확인 Q5) |

## 4. 방법(고른 것과 버린 것)

1. **하위 프로젝트(고름, W2).** 워크트리는 `rootId`·`relPath` 를 가진 디렉터리이므로 지금 프로젝트 행의 꼴에 그대로 맞는다. 천장 검사·세션·「루트 없음」·에이전트 목록·이름 바꾸기를 그대로 다시 쓰고, 한 브랜치에 에이전트 여럿을 둘 수 있다.
2. **에이전트 옵션(버림).** 에이전트 하나 = 워크트리 하나라 화면은 단순하지만 구현·리뷰 에이전트가 한 브랜치를 함께 쓸 수 없고, 정리 수명이 에이전트 보관과 엉켜 프로젝트 쪽 기능을 에이전트 쪽에 다시 만든다.

## 5. 설계

### 5.1 데이터(`apps/server`)

`runner_projects` 에 열 넷(마이그레이션): `parent_project_id`(nullable, 같은 표를 가리킴 — 있으면 워크트리), `branch`(nullable, 워크트리면 그 브랜치 이름), `is_git`(boolean, W14 — 기존 행은 false 로 두고 다음 「확인」·러너 재접속 뒤 첫 목록 때 채운다: 빌더가 정한다), `worktree_cleanup`(nullable — 마지막 보관 시도가 실패했을 때의 사유 코드, 화면 표시용). 같은 자리 부분 유니크(`runnerTokenId, rootId, relPath WHERE archived_at IS NULL`)가 있으므로 서버는 **러너에 묻기 전에** 그 자리가 비었는지 본다. 워크트리 행의 `rootId`·`relPath` 는 워크트리 폴더다. 부모의 부모는 없다(W2 하지 않을 것 — 부모가 워크트리면 만들기 400).

### 5.2 계약(`packages/shared`)

- `RunnerProject` 에 `parentProjectId: Id | null`, `branch: string | null`, `isGit: boolean`, `cleanupIssue: string | null`.
- `RunnerProjectCheckResult` 의 ok 에 `isGitTop: boolean`(W14 — 러너가 `git rev-parse` 로 판단).
- REST
  - `POST /api/v1/runner-projects/:id/worktrees` 본문 `{ label: string; branch?: string; location?: { rootId; relPath } }` → 201 `RunnerProject`. `location` 이 없으면 W3 기본.
  - 보관은 지금 `POST /api/v1/runner-projects/:id/archive` 가 워크트리면 러너에 지우기를 묻고 성공해야 보관(W7 실패면 409 `details.reason`). 본문 `{ keepFolder?: true }` 면 러너에 묻지 않고 행만 보관(W12).
- 러너 wire(서버 → 러너 ack 요청, 지금 `fs.list`·`project.check` 와 같은 꼴, 상한은 git 이 오래 걸릴 수 있어 30초):
  - `worktree.create` `{ repo: RunnerProjectRef; target: RunnerProjectRef; branch: string }` → `{ ok: true; created: boolean /* 새 브랜치였나 */; adopted: boolean /* W13 */; base: string /* 기준 커밋 짧은 해시 */ } | { ok: false; reason: "not_git" | "is_worktree" | "target_exists" | "outside_root" | "root_missing" | "branch_in_use" | "invalid_branch" | "git_failed"; message?: string }`
  - `worktree.remove` `{ repo: RunnerProjectRef; target: RunnerProjectRef }` → `{ ok: true } | { ok: false; reason: "dirty" | "not_worktree" | "git_failed"; message?: string }`
  - `message` 는 git stderr 를 경로 가림(`mask`)하고 200자로 자른 것.
- 러너 hello `capabilities` 에 `"worktrees"` — shared `RunnerCapability` enum 에 값을 더해야 서버가 버리지 않는다(`packages/runner-adapter/src/connections.ts` 가 모르는 값을 거른다). ack 상한은 새 상수 `RUNNER_GIT_ACK_TIMEOUT_MS = 30_000`(지금 `RUNNER_FS_ACK_TIMEOUT_MS` 10초와 따로). 서버는 이 능력이 없는 러너면 만들기를 400 「러너를 업데이트하세요(워크트리는 0.7.0 부터)」로 막고, 웹은 단추를 사유와 함께 잠근다(2장 실패 넷째). 옛 서버는 모르는 능력 문자열을 버린다(지금 규칙).

### 5.3 러너(`packages/claude-runner`)

- git 은 `execFile("git", [...])` 로만 부른다(셸 없음). 브랜치는 `git check-ref-format --branch` 로 먼저 검사하고, 인자 앞에 `--` 를 둬 옵션으로 읽히지 않게 한다. 경로는 `resolveProject` 와 같은 풀이로 루트 안인지 보고, `target` 은 아직 없거나 빈 디렉터리여야 한다.
- 만들기: 브랜치가 있으면 `git -C <repo> worktree add -- <target> <branch>`, 없으면 `git -C <repo> worktree add -b <branch> -- <target> HEAD`. 그 뒤 W5 의 exclude 줄(이미 있으면 그대로) — `git check-ignore` 로 덮였는지 먼저 본다. `.git/info/exclude` 는 `git rev-parse --git-path info/exclude` 로 찾는다(저장소 자체가 워크트리·서브모듈이어도 맞게).
- 지우기: `git -C <repo> worktree remove -- <target>`(`--force` 없음 — git 이 변경 있는 워크트리를 거절하는 것을 W7 의 `dirty` 로). 폴더가 없으면 `git worktree prune` 뒤 ok.
- 러너 머신에 `git` 이 없으면 `git_failed`(「러너 머신에 git 이 없습니다」).

### 5.4 서버

- 만들기: 부모가 보관되지 않은 git 프로젝트(`project.check` 의 `isGitRepo`)이고 워크트리가 아닌지, 러너가 붙어 있고 `worktrees` 능력이 있는지 본 뒤 `worktree.create`. 성공하면 행을 만든다(실패면 행 없음). 기본 위치는 부모 `relPath` + `/.worktrees/<이름 슬러그>`.
- 보관: 워크트리 행이면 W11 검사 → `worktree.remove` 성공 뒤 `archivedAt`. 러너가 끊겨 있으면 409 「러너가 연결되어 있어야 정리할 수 있습니다」(W12 단추로 이어진다). 부모 보관·옮기기(`POST /runner-projects/:id/move`)는 W9.
- 워크트리 아래 에이전트의 런은 지금 그대로(워크트리 `rootId`·`relPath` 가 런의 프로젝트).

### 5.5 웹

```
설정 → 연결 → 러너 상세
  프로젝트 dodok.chat            src/dodok.chat · git        [워크트리 만들기] [에이전트 만들기] …
    └ 워크트리 feat-login        dodok/feat-login · src/dodok.chat/.worktrees/feat-login   [에이전트 만들기] [보관]
```

- 「워크트리 만들기」 대화상자: 이름(필수), 브랜치(기본 `dodok/<이름 슬러그>`), 위치(기본 `<부모 경로>/.worktrees/<이름 슬러그>` 를 보여 주고 「바꾸기」로 둘러보기·직접 입력 — 둘러보기는 부모 디렉터리를 고르고 마지막 이름을 붙인다, 둘러보기를 끈 러너는 직접 입력만). git 이 아닌 프로젝트·옛 러너·끊긴 러너는 단추를 잠그고 사유 한 줄.
- 에이전트 만들기 폼(git 프로젝트에서 열었을 때): 「작업 위치」 라디오 — 「이 프로젝트」(기본) / 「새 워크트리」(위 칸 셋이 펼쳐진다). 만들기를 누르면 워크트리 → 에이전트 차례로, 에이전트 만들기가 실패하면 워크트리는 남기고(하위 프로젝트로 보인다) 사유를 보인다.
- DM 머리·에이전트 상세의 프로젝트 표시는 워크트리면 `<부모 이름> · <브랜치>`.
- 보관 409(W7)는 그 줄에 사유를 남긴다(`worktree_cleanup`).

## 6. 남은 것(빌더 몫)

- 이름 슬러그 규칙(한글 이름이면 브랜치·폴더 이름을 어떻게 — 사람이 바꿀 수 있으니 안전한 기본이면 된다), 상한 길이.
- `worktree.create` 의 경쟁(같은 이름 두 번 누름) 처리.
- 러너 판본 0.7.0 은 조율자가 배포한다(`docs/guides/runner-release.md`).
- 시험: 러너(실제 임시 git 저장소로 만들기·있는 브랜치·사용 중 브랜치·변경 있는 지우기·없는 폴더·exclude 한 번만·이미 무시됨·루트 밖·옵션처럼 생긴 브랜치 `-x`·셸 문자), shared, 서버(권한·능력 없음·끊김·부모 보관/옮기기 막기·실패 시 행 없음), 웹(대화상자·폼 지름길·잠금 사유). `dev:fake` 가짜 러너가 `worktree.*` 에 답하게 한다.
- 문서: `docs/manual/user-guide.md`(러너 프로젝트 절), `docs/guides/plan.md` 8장.

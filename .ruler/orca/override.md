# orca 바꿈 — 이 프로젝트에서 바꾸는 규칙

## Orca 가 만드는 워크트리의 자리는 `.worktrees/` 로 고정하지 않는다
바꾸는 절: `orca/05-switch.md` 「Orca 가 살아 있으면 워크트리도 Orca 로 만든다」

그 절이 바꾸는 것 중 **위치(`.worktrees/`)만** 다시 바꾼다. Orca 로 만드는 워크트리의 자리는 Orca 설정(앱의 worktree 경로 — 기본 `~/orca/workspaces/<저장소>/<슬러그>`, repo 별 `worktreeBasePath` 가 있으면 그것)이 정한 대로 둔다 — 저장소 밖이어도 된다. 스크립트(`scripts/orca-worker.sh`)는 Orca 응답(`orca worktree create --json` 의 `.result.worktree`)과 목록(`orca worktree list`·`ps`)으로 찾는다. 생성 명령(`orca worktree create`)·환경 확인·하나의 작업 = 하나의 워크트리·브랜치·정리 규칙은 그 절과 `base/06-worktree-setup.md` 를 따른다. Orca 없이 손으로 만들 때만 `.worktrees/<슬러그>`.

- **Why:** 자리를 고정하면 스크립트가 Orca 앱 설정에 묶인다. 설정이 기본값으로 바뀌자(2026-11-11) Orca 는 워크트리를 만들었는데 `.worktrees/dodok.chat/<슬러그>` 를 조립해 id 를 찾던 `spawn` 이 「워크트리 생성 실패」로 멈췄고, 엉뚱한 자리에 잔해가 남았다. 반환 JSON 에 id·경로가 들어 있으니(그 절의 Why ①) 자리를 가정할 까닭이 없다.
- **How to apply:**
  - 워크트리 경로가 필요하면 반환 JSON 의 `.result.worktree.path` 나 `scripts/orca-worker.sh status` 로 본다. 경로 문자열을 조립하지 않는다.
  - 자리를 바꾸려고 CLI 로 우회하지 않는다 — `orca worktree create` 에는 생성 위치를 받는 옵션이 없고, 자리는 앱 설정만 바꾼다.

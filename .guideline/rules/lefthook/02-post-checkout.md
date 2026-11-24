---
load: reference
when: "lefthook 의 post-checkout·post-merge·post-rewrite 훅을 쓰거나 고칠 때"
---

# post-checkout·post-merge·post-rewrite

## post-checkout 은 런타임을 맞춘 뒤에 의존성을 설치한다 — `parallel: true` 를 쓰지 않는다

런타임 관리자(mise 등)의 설치 잡을 첫 잡으로 두고, 의존성 설치 잡을 그 뒤에 **순차로** 둔다.

- **Why:** 병렬로 돌거나 순서가 뒤집히면, 의존성 설치가 그 브랜치가 요구하는 런타임이 아니라 **지금 PATH 에 있는 런타임**으로 돈다.
- **How to apply:**
  ```yaml
  # 순차 실행이다 — 런타임이 맞은 뒤에 설치가 돌아야 한다.
  post-checkout:
    piped: true
    jobs:
      - name: runtime
        run: "[ '{3}' = 1 ] || exit 0; if command -v mise >/dev/null; then mise trust && mise install; else echo 'mise 가 없어 런타임 버전을 맞추지 못했다'; fi"
      - name: deps
        run: "[ '{3}' = 1 ] || exit 0; pnpm install"
  ```
  - 새 워크트리의 `mise.toml` 은 아직 신뢰되지 않아 `mise install` 만 부르면 바로 실패한다. `mise trust` 를 먼저 부른다.
  - 런타임 관리자가 없는 환경에서는 첫 잡이 **안내만 찍고 넘어가게** 한다.
  - `piped: true` 를 둔다. 순차 실행만으로는 앞 잡이 실패해도 다음 잡이 돈다 — 런타임 설치가 실패한 채 지금 PATH 의 런타임으로 의존성이 깔린다. `piped` 면 첫 실패에서 나머지를 건너뛴다.
  - 잡마다 `[ '{3}' = 1 ] || exit 0` 으로 **브랜치 체크아웃일 때만** 돌게 한다. git 은 파일 체크아웃(`git checkout -- <파일>`)에도 post-checkout 을 부르고 세 번째 인자로 `0` 을 준다(브랜치 체크아웃과 `git worktree add` 는 `1`). 가드가 없으면 파일 하나를 되돌릴 때마다 의존성 설치가 돈다.

## merge·pull·rebase 뒤에도 같은 설치를 돌린다 — post-merge·post-rewrite 에 걸어 둔다

git 은 merge·pull 뒤에 `post-merge` 를, rebase·`pull --rebase`·`commit --amend` 뒤에 `post-rewrite` 를 부르고 `post-checkout` 은 부르지 않는다. 두 훅에도 post-checkout 과 같은 런타임·의존성 설치 잡을 같은 순서로 건다.

- **Why:** 받은 커밋이 런타임 버전이나 lockfile·패치를 바꿨을 수 있다. post-checkout 에만 걸면 pull 한 뒤에도 의존성이 옛 lockfile 상태로 남아, 다음 빌드·시험이 원인과 먼 자리에서 실패한다.
- **How to apply:**
  ```yaml
  post-merge:
    piped: true
    jobs: &after-update
      - name: runtime
        run: "if command -v mise >/dev/null; then mise trust && mise install; else echo 'mise 가 없어 런타임 버전을 맞추지 못했다'; fi"
      - name: deps
        run: "pnpm install"

  post-rewrite:
    piped: true
    jobs: *after-update
  ```
  - **post-checkout 의 `{3}` 가드를 옮기지 않는다.** post-merge 는 인자가 하나(squash 여부)이고 post-rewrite 도 하나(`amend`·`rebase`)라 세 번째 인자가 없다. lefthook 은 없는 인자의 `{3}` 을 치환하지 않고 글자 그대로 남기므로(2.1 에서 확인) 가드가 늘 `exit 0` 으로 설치를 건너뛴다. 그래서 post-checkout 의 잡을 YAML 앵커로 그대로 공유할 수 없다. 가드 없는 잡을 따로 두고, 앵커는 post-merge 와 post-rewrite 사이에서만 쓴다.
  - post-rewrite 는 `git commit --amend` 에도 돌아 amend 마다 설치가 몇 초씩 돈다. 싫으면 post-rewrite 에만 잡을 따로 두고 각 잡 앞에 `[ '{1}' = rebase ] || exit 0` 을 붙여 rebase 에만 돌게 한다. 이 가드를 앵커로 공유한 잡에 넣으면 post-merge 의 `{1}`(`0`·`1`)에 걸려 merge 뒤 설치가 사라진다.
  - 훅 정의를 새로 받은 체크아웃은 아직 `.git/hooks` 에 그 훅이 없다. `lefthook install` 을 한 번 돌려 등록한다(의존성 설치 스크립트가 부르게 해 두었으면 의존성 설치 한 번).

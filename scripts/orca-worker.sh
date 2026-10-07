#!/bin/bash
# Orca 워커 수명주기 관리.
#   spawn <슬러그> <역할> [--model opus|sonnet] [--brief <파일>] [--base <브랜치>]
#     모델·effort: --model 이 있으면 그 값, 없고 tiergear 가 있으면 판단기가 고르고
#     (역할은 범위만 정한다), tiergear 가 없으면 역할 기본값이다.
#   attach <슬러그> <역할> [--model ...] [--brief <파일>] [--terminal <핸들>] [--force]
#     --terminal 이 없으면 살아 있는 에이전트 터미널을 재사용하되, review 는 늘 새로 띄운다
#     (리뷰어는 구현자와 다른 세션이어야 한다).
#   status [--porcelain]
#   wait [--timeout-ms <n>]
#   reap <슬러그> | --all-merged [--base <브랜치>] [--force]
#   stop <슬러그> | --all [--force] [--dry-run]   # 끝난 워커를 회수하고 워크트리의 터미널만 정지
#   keep <슬러그> [--remove]
#   sync-config [<워크트리경로>]   # 최상위 .env 를 워크트리로 복사
#
# 정본: docs/guides/worktree-workflow.md (절차·근거는 그 문서가 갖는다)
# bash 3.2 에서 동작해야 한다 — 연관배열·mapfile·${var^^} 금지.

set -u

# Orca CLI 실행파일. 테스트는 ORCA_CLI_COMMAND 로 스텁을 주입한다.
orca_cli() {
  if [ -n "${ORCA_CLI_COMMAND:-}" ]; then
    printf '%s\n' "$ORCA_CLI_COMMAND"
  elif [ "$(uname -s)" = "Linux" ]; then
    printf 'orca-ide\n'
  else
    printf 'orca\n'
  fi
}

# 역할별 기본 모델을 정하고, 재정의가 있으면 그것을 쓴다.
# 사용: resolve_model <역할> [재정의]
resolve_model() {
  local role="$1"
  local override="${2:-}"
  local default_model

  case "$role" in
    implement|review) default_model=opus ;;
    verify|chore)     default_model=sonnet ;;
    *)
      printf '알 수 없는 역할: %s (implement|review|verify|chore 중 하나)\n' "$role" >&2
      return 1
      ;;
  esac

  if [ -z "$override" ]; then
    printf '%s\n' "$default_model"
    return 0
  fi

  case "$override" in
    opus|sonnet)
      printf '%s\n' "$override"
      ;;
    *)
      printf '허용되지 않은 모델: %s (opus|sonnet 별칭만 쓴다)\n' "$override" >&2
      return 1
      ;;
  esac
}

# tiergear 실행파일. 테스트는 TIERGEAR_COMMAND 로 스텁을 주입한다(ORCA_CLI_COMMAND 와 같은 방식).
tiergear_cli() {
  printf '%s\n' "${TIERGEAR_COMMAND:-tiergear}"
}

# 워커 기동에 쓸 모델·effort 를 고른다. 결과는 전역 WM_MODEL·WM_EFFORT·WM_SOURCE 에 둔다
# (tiergear 의 stderr 를 사용자에게 그대로 보이려면 서브셸로 감쌀 수 없다).
#   --model 재정의            → 그 값. tiergear 를 부르지 않는다
#   tiergear 실행파일 없음     → 역할 기본값(resolve_model), effort 없음
#   tiergear 있음              → `tiergear launch` 가 정한 --model·--effort
#   launch 실패·출력 불량       → 경고 한 줄 + 역할 기본값. 워커 기동을 막지 않는다
# 역할별 범위: review=--min-tier deep, verify·chore=--max-tier standard, implement=없음.
# 사용: select_worker_model <역할> <기본모델> <재정의> <spec> <워크트리경로>
select_worker_model() {
  local role="$1" default_model="$2" override="$3" spec="$4" wt_path="$5"
  WM_MODEL="$default_model"
  WM_EFFORT=""
  WM_SOURCE="역할 기본값 $role"

  if [ -n "$override" ]; then
    WM_SOURCE="--model 재정의, 역할 $role"
    return 0
  fi

  local tg
  tg="$(tiergear_cli)"
  command -v "$tg" >/dev/null 2>&1 || return 0

  local range_args=""
  case "$role" in
    review)       range_args="--min-tier deep" ;;
    verify|chore) range_args="--max-tier standard" ;;
  esac

  local out_file err_file out rc note
  out_file="$(mktemp)"
  err_file="$(mktemp)"
  # spec 은 맨 끝에 `--` 뒤로 둔다 — tiergear 는 parseArgs 라 `---`·`- 항목` 으로 시작하는
  # 브리프를 옵션으로 읽는다. `--` 앞에 두면 그 뒤의 범위 옵션이 위치 인자가 되므로 옵션이 먼저다.
  # shellcheck disable=SC2086  # range_args 는 위 case 의 고정 리터럴이다
  "$tg" launch --worktree "$wt_path" $range_args -- "$spec" >"$out_file" 2>"$err_file"
  rc=$?
  out="$(cat "$out_file")"
  # judged/applied 줄과 경고는 사용자에게 그대로 보인다.
  cat "$err_file" >&2
  note="$(grep -E 'judged .*applied' "$err_file" | tail -1 | sed 's/^tiergear: *//')"
  rm -f "$out_file" "$err_file"

  if [ "$rc" -ne 0 ]; then
    printf '경고: tiergear launch 가 종료코드 %s 로 실패했다 — 역할 기본값(%s)으로 진행한다\n' \
      "$rc" "$default_model" >&2
    return 0
  fi

  # 글롭을 끄고 자른다 — `*`·`[1m]` 가 든 토큰이 cwd 의 파일 이름으로 바뀌지 않게.
  local t_model="" t_effort="" prev="" tok noglob_was_off=no
  case "$-" in *f*) ;; *) noglob_was_off=yes ;; esac
  set -f
  for tok in $out; do
    case "$prev" in
      --model)  t_model="$tok" ;;
      --effort) t_effort="$tok" ;;
    esac
    prev="$tok"
  done
  [ "$noglob_was_off" = yes ] && set +f

  # 값은 worker-start 인자로 그대로 간다. 평범한 토큰이 아니면 쓰지 않는다.
  # 첫 글자는 영문·숫자여야 한다 — `--model --effort high` 에서 `--effort` 가 모델로 잡히지 않게.
  if [ -z "$t_model" ] \
     || ! printf '%s' "$t_model" | grep -Eq '^[A-Za-z0-9][][A-Za-z0-9._:-]*$' \
     || { [ -n "$t_effort" ] && ! printf '%s' "$t_effort" | grep -Eq '^[A-Za-z0-9][][A-Za-z0-9._:-]*$'; }; then
    printf '경고: tiergear launch 출력에서 모델·effort 를 얻지 못했다 — 역할 기본값(%s)으로 진행한다\n' \
      "$default_model" >&2
    return 0
  fi

  WM_MODEL="$t_model"
  WM_EFFORT="$t_effort"
  if [ -n "$note" ]; then
    WM_SOURCE="tiergear: $note, 역할 $role"
  else
    WM_SOURCE="tiergear, 역할 $role"
  fi
}

# 요약에 쓰는 모델 표기. 사용: model_label  (WM_* 를 읽는다)
model_label() {
  if [ -n "$WM_EFFORT" ]; then
    printf '%s/%s (%s)' "$WM_MODEL" "$WM_EFFORT" "$WM_SOURCE"
  else
    printf '%s (%s)' "$WM_MODEL" "$WM_SOURCE"
  fi
}

# 워커가 아직 도는 중인지.
# 2026-08-28 실물 측정: 도는 워커의 agents[].state 는 running 이 아니라 working 이었다.
# 상태 목록이 문서화돼 있지 않으므로 done/none 만 끝난 것으로 보고 나머지는 전부
# 도는 것으로 친다 — 모르는 상태를 만나면 "덜 지우는 쪽"으로 틀린다.
is_worker_live() {
  case "${1:-}" in
    done|none|"") printf 'no\n' ;;
    *)            printf 'yes\n' ;;
  esac
}

# 워크트리 하나의 상태를 판정한다.
# 사용: classify_worktree <워커상태> <살아있는터미널수> <병합여부(yes|no)> <미커밋수>
classify_worktree() {
  local state="$1" live="$2" merged="$3" dirty="$4"

  # 도는 워커가 최우선이다. 기다리는 중에 경고를 내면 신호가 무뎌진다.
  if [ "$(is_worker_live "$state")" = "yes" ]; then
    printf 'waiting\n'
    return 0
  fi

  # 끝났는데 터미널이 남아 있으면 병합 여부와 무관하게 회수 대상이다.
  if [ "$state" = "done" ] && [ "$live" -gt 0 ]; then
    printf 'recover\n'
    return 0
  fi

  # F4: agent 기록이 없는데 터미널이 살아 있으면 폐기 대상이 아니다.
  # 갓 spawn 한 워크트리가 정확히 이 모양이다 — base 와 같은 커밋(merged),
  # 파일 미변경(dirty 0), agent 미등록(none). 세 조건이 두 관문을 그대로
  # 통과해 방금 띄운 워커가 지워진다. 터미널이 붙어 있으면 기다린다.
  if [ "$live" -gt 0 ]; then
    printf 'waiting\n'
    return 0
  fi

  if [ "$merged" = "yes" ]; then
    if [ "$dirty" -gt 0 ]; then
      printf 'blocked\n'
    else
      printf 'reap\n'
    fi
    return 0
  fi

  printf 'active\n'
}

# 워크트리에 보호 표시가 있나.
#
# git 관점의 "정리 가능"(병합됐고 미커밋 없음)과 사람 관점의 "다 썼다"는 다르다.
# 2026-08-28 실측: 커밋이 전부 main 에 들어가고 미커밋도 0인 워크트리 셋을
# reap --all-merged 가 지웠는데, 사용자가 계속 쓰던 작업 환경이었다.
# 코드 손실은 없었지만 체크아웃과 터미널이 사라졌다. 그 판단은 사람만 할 수 있다.
is_kept() {
  [ -f "$1/.orca-keep" ]
}

# 지금 이 명령이 그 경로 안에서 돌고 있는가.
#
# **글자로 비교하면 안 된다.** `$PWD` 는 논리 경로(심링크를 따라가지 않은 표기)이고
# Orca 와 git 이 주는 path 는 실물 경로다. 심링크를 사이에 두면 같은 디렉터리가
# 서로 다른 문자열이 되어 **가드가 통째로 빠진다** — 자기 발밑의 터미널을 끄고
# 자기가 서 있는 워크트리를 지운다. 그래서 양쪽을 실물 경로로 맞춘 뒤 비교한다.
# 두 표기 중 하나만 걸려도 「안에 있다」로 본다 — 모르면 건드리지 않는 쪽으로 틀린다.
is_inside_path() {
  local path="$1" here target
  here="$(cd "$PWD" 2>/dev/null && pwd -P)"
  [ -n "$here" ] || here="$PWD"
  target="$(cd "$path" 2>/dev/null && pwd -P)"
  [ -n "$target" ] || target="$path"
  case "$here/" in
    ("$target"/*) return 0 ;;
  esac
  case "$PWD/" in
    ("$path"/*) return 0 ;;
  esac
  return 1
}

# 판정 토큰이 사람 손을 요구하는 상태인지.
is_unsettled() {
  case "$1" in
    recover|blocked|reap|orphan) printf 'yes\n' ;;
    *)                    printf 'no\n' ;;
  esac
}

# 이 저장소 최상위 경로. 테스트는 ORCA_WORKER_REPO_ROOT 로 주입한다.
repo_root() {
  if [ -n "${ORCA_WORKER_REPO_ROOT:-}" ]; then
    printf '%s\n' "$ORCA_WORKER_REPO_ROOT"
  else
    git rev-parse --show-toplevel
  fi
}

# 이 저장소의 Orca repoId. 최상위 경로와 일치하는 워크트리에서 얻는다.
repo_id() {
  if [ -n "${ORCA_WORKER_REPO_ID:-}" ]; then
    printf '%s\n' "$ORCA_WORKER_REPO_ID"
    return 0
  fi
  "$(orca_cli)" worktree ps --json 2>/dev/null \
    | jq -r --arg root "$(repo_root)" \
        '.result.worktrees[] | select(.path == $root) | .repoId' \
    | head -1
}

# 이 저장소의 비-최상위 워크트리를 탭 구분 행으로 낸다.
#   <슬러그>\t<워커상태>\t<터미널수>\t<경로>\t<브랜치>
# 워커 상태는 agents 중 가장 최근 것을 쓰고, 없으면 none.
# repoId 는 같은 응답 안에서 뽑는다. 예전에는 repo_id() 가 worktree ps 를
# 한 번 더 불러서 호출 한 번에 Orca 왕복이 두 번이었다(실측 0.16초/회).
collect_worktrees() {
  "$(orca_cli)" worktree ps --json 2>/dev/null \
    | jq -r --arg root "$(repo_root)" --arg forced "${ORCA_WORKER_REPO_ID:-}" '
        .result.worktrees as $w
        | ( if $forced != "" then $forced
            else ( first($w[] | select(.path == $root) | .repoId) // "" ) end ) as $repo
        | $w[]
        | select(.repoId == $repo)
        | select(.isMainWorktree != true)
        | [ .displayName,
            # F3: 마지막 원소 하나가 아니라 "살아 있는 agent 가 하나라도 있는가"다.
            # 실물은 한 워크트리에 agent 가 여럿 붙고 순서 보장이 없다.
            ( [ .agents[]? | .state ] as $st
              | ( $st | map(select(. != "done" and . != "none")) | first )
                // ( $st | last ) // "none" ),
            ( .liveTerminalCount // 0 ),
            .path,
            ( .branch | sub("^refs/heads/"; "") )
          ]
        | @tsv'
}

# 워크트리들이 모여 있는 디렉터리. 워크트리 안에서 실행돼도 최상위 체크아웃을
# 기준으로 잡아야 한다 — git-common-dir 은 어느 워크트리에서 불러도 최상위의
# .git 을 가리킨다(2026-08-28 실측).
worktrees_dir() {
  if [ -n "${ORCA_WORKER_WORKTREES_DIR:-}" ]; then
    printf '%s\n' "$ORCA_WORKER_WORKTREES_DIR"
    return 0
  fi
  local main
  main="$(main_checkout)"
  printf '%s/.worktrees/%s\n' "$main" "$(basename "$main")"
}

# 최상위 체크아웃 경로. repo_root 와 달리 **워크트리 안에서 실행돼도 최상위를 낸다** —
# git-common-dir 은 어느 워크트리에서 불러도 최상위의 .git 을 가리킨다(2026-08-28 실측).
# git 이 답하지 못하면(테스트의 가짜 경로 등) repo_root 로 물러난다.
main_checkout() {
  local root common
  root="$(repo_root)"
  common="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  if [ -n "$common" ]; then
    dirname "$common"
  else
    printf '%s\n' "$root"
  fi
}

# Orca 도 git 도 모르는 고아 디렉터리를 낸다. <슬러그>\t<경로>
#
# collect_worktrees 는 Orca 가 보고하는 워크트리만 센다. 이미 제거된 워크트리의
# 껍데기(node_modules·.turbo 같은 산출물만 남은 디렉터리)는 Orca 도 git 도 모르므로 열거되지
# 않았고, 그래서 실제로 쌓인 잔해에 status 도 reap 도 닿지 못했다.
# 사용: collect_orphans [<이미 아는 슬러그 목록(줄바꿈 구분)>]
# 호출자가 collect_worktrees 결과를 이미 갖고 있으면 넘겨라 — 안 넘기면
# Orca 왕복이 한 번 더 생기고, 훅은 이것을 매 프롬프트마다 문다.
collect_orphans() {
  local dir parent live_list known d slug
  dir="$(worktrees_dir)"

  # 워크트리는 두 경로에 쌓인다 — Orca 는 .worktrees/<저장소>/<슬러그> 에,
  # git worktree add 는 .worktrees/<슬러그> 에 만든다(CLAUDE.md 의 대체 절차).
  # 한쪽만 훑으면 옛 경로의 잔해가 영원히 보이지 않는다: 2026-08-28 실측으로
  # .worktrees/ 바로 아래 껍데기 12개가 status·reap 양쪽에서 누락돼 있었다.
  parent="$(dirname "$dir")"

  live_list="$(git -C "$(repo_root)" worktree list --porcelain 2>/dev/null \
    | sed -n 's|^worktree ||p')"
  if [ $# -gt 0 ]; then
    known="$1"
  else
    known="$(collect_worktrees | cut -f1)"
  fi

  for d in "$dir"/* "$parent"/*; do
    [ -d "$d" ] || continue
    # 저장소별 디렉터리 자신은 워크트리가 아니라 상위 묶음이다.
    [ "$d" = "$dir" ] && continue
    # 실물 git 워크트리면 고아가 아니다.
    case "
$live_list
" in
      (*"
$d
"*) continue ;;
    esac
    # Orca 가 알고 있으면 고아가 아니다(collect_worktrees 가 이미 다룬다).
    slug="$(basename "$d")"
    case "
$known
" in
      (*"
$slug
"*) continue ;;
    esac
    printf '%s\t%s\n' "$slug" "$d"
  done
}

# 브랜치가 기준 브랜치에 전부 들어갔는지.
# 사용: git_merged <브랜치> <기준브랜치> [저장소경로]
git_merged() {
  local branch="$1" base="$2" root="${3:-$(repo_root)}"
  if git -C "$root" merge-base --is-ancestor "$branch" "$base" 2>/dev/null; then
    printf 'yes\n'
  else
    printf 'no\n'
  fi
}

# 워크트리의 미커밋 변경 개수(추적되지 않는 파일 포함).
git_dirty_count() {
  local path="$1"
  if [ ! -d "$path" ]; then
    printf '0\n'
    return 0
  fi
  git -C "$path" status --porcelain 2>/dev/null | grep -c '' | tr -d ' '
}

# 사람이 읽는 표에서 토큰별로 붙일 다음 행동.
next_action() {
  case "$1" in
    (recover)
      # F11: recover 가 blocked 보다 먼저 걸리므로 미커밋 정보가 사라졌다.
      # 시킨 대로 reap 을 부르면 게이트가 거부한다 — 그 사실을 여기서 말한다.
      if [ "${3:-0}" -gt 0 ]; then
        printf '회수: 미커밋 %s개를 먼저 커밋하거나 버려야 reap %s 가 통과한다\n' "$3" "$2"
      else
        printf '회수: reap %s\n' "$2"
      fi
      ;;
    (reap)    printf '폐기: reap %s\n' "$2" ;;
    (blocked) printf '미커밋 %s개 — 커밋하거나 버린 뒤 reap %s\n' "$3" "$2" ;;
    (orphan)  printf '잔해 디렉터리 — reap %s 로 제거\n' "$2" ;;
    (orphan-live)
      # 잔해로 보이지만 터미널이 붙어 있다. reap 이 거부하므로 명령을 권하지 않는다.
      printf '잔해 디렉터리인데 터미널 %s개가 붙어 있다 — 그 터미널을 끝내야 제거된다\n' "$3"
      ;;
    (keep)    printf '보호됨(.orca-keep) — 해제는 keep %s --remove\n' "$2" ;;
    (waiting) printf '대기 중\n' ;;
    (*)       printf '작업 중\n' ;;
  esac
}

cmd_status() {
  local porcelain=no base=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --porcelain) porcelain=yes; shift ;;
      --base)      base="${2:-}"; shift 2 ;;
      *)           printf 'status: 알 수 없는 인자 %s\n' "$1" >&2; return 2 ;;
    esac
  done
  [ -n "$base" ] || base="$(git -C "$(repo_root)" branch --show-current)"

  local unsettled=0 printed_header=no rows tl=""
  local slug state live path branch merged dirty token
  rows="$(collect_worktrees)"

  while IFS="$(printf '\t')" read -r slug state live path branch; do
    [ -n "$slug" ] || continue
    merged="$(git_merged "$branch" "$base")"
    dirty="$(git_dirty_count "$path")"
    # 보호 표시는 무엇보다 먼저 본다. 사람이 쓰는 중이라고 밝힌 워크트리다.
    if is_kept "$path"; then
      token=keep
    else
      token="$(classify_worktree "$state" "$live" "$merged" "$dirty")"
    fi
    [ "$(is_unsettled "$token")" = "yes" ] && unsettled=$((unsettled + 1))

    if [ "$porcelain" = "yes" ]; then
      printf '%s\t%s\t%s\t%s\t%s\n' "$token" "$slug" "$state" "$live" "$dirty"
    else
      if [ "$printed_header" = "no" ]; then
        # 한글은 printf 의 %-14s 가 바이트로 세어 열이 어긋난다. 헤더는 ASCII 로 쓴다.
        printf '%-14s %-8s %6s %8s  → %s\n' "SLUG" "WORKER" "TERMS" "BRANCH" "다음 행동"
        printed_header=yes
      fi
      printf '%-14s %-8s %6s %8s  → %s\n' \
        "$slug" "$state" "$live" \
        "$([ "$merged" = yes ] && printf 'merged' || printf 'ahead')" \
        "$(next_action "$token" "$slug" "$dirty")"
    fi
  done <<EOF
$rows
EOF

  # F7: Orca 도 git 도 모르는 잔해 디렉터리. 지금까지 status 에 보이지 않았다.
  # 터미널 수는 세어서 낸다 — 0 을 찍고 넘어가면 워커가 도는 디렉터리가 "제거 대상"으로
  # 보이고, 그 표를 읽은 사람이 reap 을 부른다.
  while IFS="$(printf '\t')" read -r slug path; do
    [ -n "$slug" ] || continue
    # 잔해가 있을 때만 목록을 받는다 — 잔해가 없는 실행(대부분)은 왕복이 0이다.
    # 히어독 루프라 이 대입이 다음 반복까지 살아 있다.
    [ -n "$tl" ] || tl="$("$(orca_cli)" terminal list --json 2>/dev/null)"
    live="$(terminals_at_path "$path" "$tl")"
    if [ "$live" = "0" ]; then
      token=orphan
      unsettled=$((unsettled + 1))
    else
      token=orphan-live
    fi
    if [ "$porcelain" = "yes" ]; then
      printf '%s\t%s\t-\t%s\t0\n' "$token" "$slug" "$live"
    else
      if [ "$printed_header" = "no" ]; then
        # 한글은 printf 의 %-14s 가 바이트로 세어 열이 어긋난다. 헤더는 ASCII 로 쓴다.
        printf '%-14s %-8s %6s %8s  → %s\n' "SLUG" "WORKER" "TERMS" "BRANCH" "다음 행동"
        printed_header=yes
      fi
      printf '%-14s %-8s %6s %8s  → %s\n' "$slug" "-" "$live" "orphan" \
        "$(next_action "$token" "$slug" "$live")"
    fi
  done <<EOF
$(collect_orphans "$(printf '%s' "$rows" | cut -f1)")
EOF

  [ "$unsettled" -eq 0 ]
}

# 폐기해도 되는지 확인한다. 어떤 삭제도 이 함수를 통과한 뒤에만 한다.
# 사용: reap_gate <슬러그> <브랜치> <경로> <기준브랜치> <force(yes|no)>
reap_gate() {
  local slug="$1" branch="$2" path="$3" base="$4" force="$5"
  local merged dirty blocked=no

  merged="$(git_merged "$branch" "$base" "$path")"
  dirty="$(git_dirty_count "$path")"

  if [ "$merged" != "yes" ]; then
    if [ "$force" = "yes" ]; then
      printf '[force] %s: %s 에 들어가지 않은 커밋을 버린다:\n' "$slug" "$base" >&2
      git -C "$path" log --oneline "$base..$branch" 2>/dev/null | sed 's/^/    /' >&2
    else
      printf '%s: %s 에 병합되지 않은 커밋이 있다. --force 로만 지운다\n' "$slug" "$base" >&2
      git -C "$path" log --oneline "$base..$branch" 2>/dev/null | sed 's/^/    /' >&2
      blocked=yes
    fi
  fi

  if [ "$dirty" -gt 0 ]; then
    if [ "$force" = "yes" ]; then
      printf '[force] %s: 미커밋 %s개를 버린다:\n' "$slug" "$dirty" >&2
      git -C "$path" status --porcelain 2>/dev/null | sed 's/^/    /' >&2
    else
      printf '%s: 미커밋 변경 %s개가 있다. 커밋하거나 --force 로만 지운다\n' "$slug" "$dirty" >&2
      git -C "$path" status --porcelain 2>/dev/null | sed 's/^/    /' >&2
      blocked=yes
    fi
  fi

  [ "$blocked" = "no" ]
}

# 커서 페이지를 끝까지 따라가며 응답을 한 장에 한 줄(jq -c)씩 낸다.
# 사용: orca_pages <다음 커서의 jq 경로> <orca 인자...>
#
# **끝까지 읽지 못하면 rc=1 이다.** 첫 장에서 멈추면 뒷장의 항목은 「없다」로 보이고,
# 그 「없다」는 종료코드로 성공과 구별되지 않는다. 그래서 셋을 모두 실패로 친다 —
# 한 장이라도 못 읽었다, 이미 받은 커서가 다시 왔다(끝나지 않는 페이지),
# 장 수가 `ORCA_WORKER_MAX_PAGES`(기본 1000)에 닿았는데 아직 남았다.
orca_pages() {
  local next_path="$1" out cur="" seen=" " pages=0
  local max="${ORCA_WORKER_MAX_PAGES:-1000}"
  shift
  while :; do
    if [ -n "$cur" ]; then
      out="$("$(orca_cli)" "$@" --cursor "$cur" 2>/dev/null)" || return 1
    else
      out="$("$(orca_cli)" "$@" 2>/dev/null)" || return 1
    fi
    printf '%s' "$out" | jq -c -e 'select(type == "object" and .ok != false)' 2>/dev/null || return 1
    pages=$((pages + 1))
    cur="$(printf '%s' "$out" | jq -r "$next_path // empty" 2>/dev/null)"
    [ -n "$cur" ] || return 0
    case "$seen" in
      (*" $cur "*)
        printf '  경고: %s %s 가 이미 받은 커서를 다시 냈다 — 페이지가 끝나지 않는다\n' "$1" "$2" >&2
        return 1
        ;;
    esac
    seen="$seen$cur "
    if [ "$pages" -ge "$max" ]; then
      printf '  경고: %s %s 가 %s장을 넘는다(ORCA_WORKER_MAX_PAGES) — 끝까지 읽지 못했다\n' \
        "$1" "$2" "$max" >&2
      return 1
    fi
  done
}

# 한 워크트리 것이라고 **증명된** 워커만 낸다.
# 한 줄에 탭으로 `<dispatchId> <terminalState> <retainedReason> <증명>` 을 낸다.
#
# **목록을 끝까지, 모든 Run 에서 읽는다.** `worker-list` 는 `--run` 이 없으면 부른 터미널에
# 묶인 Run 만 내고, 묶인 Run 이 없을 때만 모든 Run 을 낸다. 한 번에 최신 100행만 내므로
# 나머지는 `page.nextCursor` 로 이어 받는다 — 첫 페이지만 읽으면 오래된 dispatch 와 다른
# Run 의 dispatch 는 「증명된 dispatch 없음」으로 보인다. 그래서 첫 장의 `scope.source` 가
# `all` 이 아니면(`spawn` 이 Run 을 묶은 조율자 터미널이 그렇다) `run-list` 의 Run 을 하나씩
# `--run` 으로 읽는다. 「모든 Run」을 고르는 옵션은 `worker-list --help` 에 없다 — 그래서
# 묶인 터미널에서는 Run 수만큼 왕복한다. `run-list` 에 없는 Run 은 볼 수 없다.
#
# 목록에는 저장소 경계가 없다 — 모든 프로젝트의 워커가 한 목록에 들어 있고(범위는 Run 이지
# 저장소가 아니다), 항목에는 `worktreeId` 라는 최상위 필드가 **없다**. 그래서 소유를 증명하는
# 길은 둘뿐이고 둘 다 정확 일치다.
#   1) `.resource.worktreeId` 가 이 워크트리와 같다. `resource` 는 워커가 쥔 워크트리
#      자원 기록이라 **터미널이 이미 죽은 뒤에도 남는다** — 회수해야 할 것이 정확히 그것이다.
#   2) `.agentTerminalHandle` 이 `terminal list --worktree <셀렉터>` 가 낸 핸들 집합에 있다.
#      `resource` 가 null 인 항목(비감독 dispatch)을 여기서 줍는다.
#
# **어느 쪽도 대지 못하는 항목은 내지 않는다.** 이 목록을 느슨하게 거르면 남의
# 프로젝트 워커를 회수하게 된다 — 목록에 경계가 없으므로 필터가 유일한 경계다.
#
# **소유 증명과 회수 대상 판정은 다른 일이다.** 여기서는 거르지 않고 상태를 그대로
# 실어 보낸다 — 판정은 `release_workers` 가 한다. 증명된 것을 여기서 지우면
# 「건너뛴 것과 그 이유」를 조율자가 볼 방법이 없어진다.
#
# `terminal list` 의 **평문**을 grep 으로 파싱하지 마라. 전역 목록이고 항목 길이가
# 가변이라 `grep -B/-A` 창이 남의 항목을 통째로 삼킨다. JSON 의 `.handle` 만 읽는다.
#
# 목록을 끝까지 읽지 못하면 **rc=1** 이다 — 한 장이라도 못 읽었거나, 페이지가 끝나지
# 않거나(`orca_pages`), Run 목록을 못 읽었을 때다. 「0건」과 「못 읽었다」는 다르다 —
# 같은 것으로 만들면 필터가 죽은 날 회수가 조용히 생략된다.
owned_workers() {
  local wt_id="$1" handles pages first scope bound runs rid more
  handles="$("$(orca_cli)" terminal list --worktree "id:$wt_id" --json 2>/dev/null \
    | jq -r '.result.terminals[]?.handle // empty' 2>/dev/null)"
  pages="$(orca_pages '.result.page.nextCursor' orchestration worker-list --json)" || return 1
  # 범위는 첫 장의 `scope` 가 말한다. 그것을 싣지 않는 CLI 는 Run 범위가 생기기 전 것이라
  # 늘 모든 dispatch 를 냈다.
  first="$(printf '%s\n' "$pages" | sed -n 1p)"
  scope="$(printf '%s' "$first" | jq -r '.result.scope.source // "all"' 2>/dev/null)"
  if [ "$scope" != "all" ]; then
    # 묶인 Run 은 이미 읽었으니 건너뛴다. 어느 Run 인지 모르면 읽은 것을 버리고 전부 다시
    # 읽는다 — 같은 Run 을 두 번 읽으면 같은 dispatch 를 두 번 회수하고 두 번 센다.
    bound="$(printf '%s' "$first" | jq -r '.result.scope.run // empty' 2>/dev/null)"
    [ -n "$bound" ] || pages=""
    runs="$(orca_pages '.result.nextCursor' orchestration run-list --json)" || return 1
    printf '%s\n' "$runs" | jq -s -e 'all(.[]; .result.runs | type == "array")' >/dev/null 2>&1 \
      || return 1
    for rid in $(printf '%s\n' "$runs" | jq -r '.result.runs[].id // empty'); do
      [ "$rid" != "$bound" ] || continue
      more="$(orca_pages '.result.page.nextCursor' orchestration worker-list --run "$rid" --json)" \
        || return 1
      pages="$pages
$more"
    done
  fi
  printf '%s\n' "$pages" | jq -s -e 'all(.[]; .result.workers | type == "array")' >/dev/null 2>&1 \
    || return 1
  printf '%s\n' "$pages" \
    | jq -r --arg wt "$wt_id" --arg handles "$handles" '
        ($handles | split("\n") | map(select(length > 0))) as $H
        | .result.workers[]?
        | (.resource? | type == "object" and .worktreeId == $wt) as $byres
        | (((.agentTerminalHandle // "") as $h
            | $h != "" and ($H | index($h)) != null)) as $byhandle
        | select($byres or $byhandle)
        | [ (.dispatchId // ""),
            ((.terminalState // "") | if . == "" then "-" else . end),
            ((.resource.retainedReason // "") | if . == "" then "-" else . end),
            (if $byres then "resource" else "handle" end) ]
        | select(.[0] != "")   # dispatchId 없는 항목은 낼 수 없다. `empty` 로 지우면
                               # 배열이 한 칸 밀려 terminalState 가 dispatchId 자리로 온다
        | @tsv' 2>/dev/null
}

# 한 워커를 회수해도 되는지 판정한다. `release` 또는 `skip:<사람이 읽는 이유>` 를 낸다.
#
# 판정은 `worker-list` 의 **`terminalState`** 로 한다. 그것이 런타임 자신의 회수 회계
# 어휘다 — `worker-list --help` 의 `--terminal-state` 가 받는 값이 그대로이고,
# 응답의 `.result.counts` 도 이 값으로 집계된다. 실물 전역 목록에서 관측된 값은
# `retained`·`released`·`reclaimable`·`active` 넷이고, `ownershipState`/`releaseState`
# 와 어긋나지 않는다(`reclaimable` = owned + not_requested, `released` = released + released,
# `retained` = external·user_owned·자원기록 없음·identity_unproven).
#
# `worker-release --help` 가 무엇을 거절하는지 직접 말한다:
#   *Never closes setup terminals, configured tabs, reused or pre-existing terminals,
#    user-taken-over terminals, or unproven identities.*
#   *Idempotent: repeating the call reports already_released.*
# 즉 `retained` 는 서버가 거절하고 `released` 는 이미 끝났다. **둘 다 부르면 no-op 인데
# 「회수 N건」에는 들어간다** — 그것이 이 판정을 넣은 이유다.
#
# `active` 는 아직 settled 가 아니다. `worker-release` 는
# *post-completion cleanup for a settled (succeeded or failed) worker* 이므로 대상이 아니고,
# **도는 워커의 터미널을 끊을 수 있는 자리라 특히 부르지 않는다.**
#
# `release_pending`·`release_unknown` 은 `--help` 의 `--terminal-state` 열거값에서만 왔고
# 이 저장소에서 **관측된 적은 없다**. 그래서 둘 다 회수하지 않는다 —
# **판정할 수 없으면 부르지 않는다(fail closed).** 모르는 값도 같다.
release_disposition() {
  case "$1" in
    reclaimable)     printf 'release\n' ;;
    released)        printf 'skip:이미 회수됐다\n' ;;
    retained)        printf 'skip:회수 대상이 아니다\n' ;;
    active)          printf 'skip:아직 settled 가 아니다(도는 워커)\n' ;;
    release_pending) printf 'skip:회수가 진행 중이다\n' ;;
    release_unknown) printf 'skip:회수 결과를 런타임이 모른다 — 손으로 확인하라\n' ;;
    *)               printf 'skip:터미널 상태를 판정할 수 없다\n' ;;
  esac
}

# `retained` 의 이유를 사람이 읽는 말로 바꾼다. 관측된 값만 이름으로 풀고
# 나머지는 그대로 보여 준다 — 모르는 값을 아는 척 옮기면 그 자리가 거짓이 된다.
retained_reason_text() {
  case "$1" in
    external_terminal) printf '스크립트가 만들지 않은 터미널이다\n' ;;
    user_takeover)     printf '사용자가 넘겨받았다\n' ;;
    user_requested)    printf '사용자가 남겨 두라고 했다\n' ;;
    identity_unproven) printf '터미널 신원이 증명되지 않았다\n' ;;
    legacy_ambiguous)  printf '소유를 가릴 수 없는 옛 기록이다\n' ;;
    -|'')              printf '\n' ;;
    *)                 printf '%s\n' "$1" ;;
  esac
}

# 이 워크트리에 붙은 워커의 터미널을 회수한다.
#
# **출력이 사실이어야 한다.** 실제로 회수를 부른 것과, 부르지 않고 건너뛴 것과 그 이유를
# 나눠 말한다. 뭉뚱그리면 다음 사람이 「회수됐구나」로 읽는데, `retained`·`released` 는
# 부르든 안 부르든 아무 프로세스도 닫히지 않는다.
release_workers() {
  local wt_id="$1" rows dispatch tstate reason proof
  local disposition why rt n=0 skipped=0 failed=0

  if ! rows="$(owned_workers "$wt_id")"; then
    printf '  경고: worker-list 를 읽지 못해 회수 대상을 판정하지 못했다 — 아무것도 회수하지 않았다\n' >&2
    return 0
  fi
  if [ -z "$rows" ]; then
    # 0건은 정상일 수도, 필터가 죽은 것일 수도 있다. 조용히 넘어가면 구별되지 않는다.
    printf '  이 워크트리 것으로 증명된 dispatch 가 없어 worker-release 를 부르지 않았다\n'
    return 0
  fi

  while IFS="$(printf '\t')" read -r dispatch tstate reason proof; do
    [ -n "$dispatch" ] || continue
    disposition="$(release_disposition "$tstate")"
    if [ "$disposition" != "release" ]; then
      why="${disposition#skip:}"
      if [ "$tstate" = "retained" ]; then
        # 자원 기록이 없는 항목(핸들 교집합으로 주운 비감독 dispatch)은 애초에
        # 회수할 터미널 자원이 없다 — `worker-release --help` 가 그것을 retained 로
        # 보고하고 아무 프로세스도 건드리지 않는다고 말한다.
        if [ "$proof" = "handle" ] && [ "$reason" = "-" ]; then
          why="$why(회수할 터미널 자원 기록이 없다)"
        else
          rt="$(retained_reason_text "$reason")"
          [ -n "$rt" ] && why="$why($rt)"
        fi
      fi
      printf '  건너뜀: %s — %s [%s]\n' "$dispatch" "$why" "$tstate"
      skipped=$((skipped + 1))
      continue
    fi
    # `worker-release` 의 응답 JSON 모양은 이 저장소에서 관측된 적이 없다. 그래서
    # 본문을 읽지 않고 종료코드만 본다 — `--help` 기준으로 `release_unknown` 만 1이다.
    if "$(orca_cli)" orchestration worker-release --dispatch "$dispatch" --json >/dev/null 2>&1; then
      printf '  회수: %s [%s]\n' "$dispatch" "$tstate"
      n=$((n + 1))
    else
      printf '  경고: worker-release 가 %s 를 회수하지 못했다(release_unknown)\n' "$dispatch" >&2
      failed=$((failed + 1))
    fi
  done <<EOF
$rows
EOF

  printf '  워커 %s건 회수 · %s건 건너뜀 · %s건 실패(이 워크트리 소유가 증명된 dispatch 만 셌다)\n' \
    "$n" "$skipped" "$failed"
}

# 경로 하나에 붙어 있는 Orca 터미널 수. 판정 불가면 `unknown` 을 낸다.
#
# 잔해(orphan) 디렉터리는 Orca 의 워크트리 목록에 없어 `liveTerminalCount` 를 갖지
# 못한다. 그래서 전역 터미널 목록을 **경로 정확 일치**로 센다. 셀 수 없으면 0 이라고
# 하지 않는다 — 여기서 fail-open 하면 워커가 도는 디렉터리를 `rm -rf` 한다.
#
# 사용: terminals_at_path <경로> [<terminal list --json 응답>]
# 목록을 넘기면 그것을 쓴다. 잔해가 여럿인 루프는 한 번만 받아 돌려 써라 —
# 안 그러면 잔해 수만큼 Orca 왕복이 생기고, 훅이 매 프롬프트마다 그것을 문다.
terminals_at_path() {
  local path="$1" out="${2:-}" real list p pr n=0

  [ -n "$out" ] || out="$("$(orca_cli)" terminal list --json 2>/dev/null)"
  if ! printf '%s' "$out" | jq -e '.result.terminals | type == "array"' >/dev/null 2>&1; then
    printf 'unknown\n'
    return 0
  fi

  # 실물 응답은 worktreePath 를 **빈 문자열로 두는 항목이 있다.** 그때는
  # worktreeId 의 `<repoId>::<경로>` 꼬리가 그 터미널의 유일한 경로다.
  list="$(printf '%s' "$out" | jq -r '
    .result.terminals[]?
    | (.worktreePath // "") as $wp
    | (.worktreeId // "") as $wid
    | if ($wp | length) > 0 then $wp
      elif ($wid | test("::")) then ($wid | sub("^[^:]*::"; ""))
      else empty end' 2>/dev/null)"

  # 심볼릭 링크를 사이에 둔 두 표기가 같은 디렉터리를 가리킨다. 글자만 비교하면
  # 같은 디렉터리를 다른 것으로 보고 0 을 내며, 그 0 이 곧 rm -rf 허가가 된다.
  # 그래서 양쪽을 실물 경로로 맞춘 뒤 비교한다.
  real="$(cd "$path" 2>/dev/null && pwd -P)"
  [ -n "$real" ] || real="$path"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    pr="$(cd "$p" 2>/dev/null && pwd -P)"
    [ -n "$pr" ] || pr="$p"
    if [ "$p" = "$path" ] || [ "$pr" = "$real" ]; then
      n=$((n + 1))
    fi
  done <<EOF
$list
EOF
  printf '%s\n' "$n"
}

# worktree rm 뒤에도 디렉터리가 남았으면(node_modules·.turbo 등 산출물) 치운다.
# 내용물이 빌드 산출물뿐일 때만 지운다 — --force 면 그 확인을 건너뛴다.
# 사용: prune_leftovers <경로> <저장소루트> [force(yes|no)]
prune_leftovers() {
  local path="$1" root="$2" force="${3:-no}" remaining rc=0
  if [ -d "$path" ]; then
    remaining="$(ls -A "$path" 2>/dev/null | grep -v -E '^(node_modules|\.turbo|\.idea|dist)$' | grep -c '')"
    if [ "$remaining" -eq 0 ] || [ "$force" = "yes" ]; then
      if [ "$remaining" -ne 0 ]; then
        printf '  [force] %s 에 빌드 산출물이 아닌 내용 %s개를 버린다:\n' "$path" "$remaining" >&2
        ls -A "$path" 2>/dev/null | sed 's/^/    /' >&2
      fi
      rm -rf "$path"
      printf '  잔해 디렉터리 제거: %s\n' "$path"
    else
      printf '  경고: %s 에 빌드 산출물이 아닌 내용이 남아 지우지 않았다\n' "$path" >&2
      ls -A "$path" 2>/dev/null | sed 's/^/    /' >&2
      rc=1
    fi
  fi
  git -C "$root" worktree prune
  return "$rc"
}

cmd_reap() {
  local target="" base="" force=no dry=no
  while [ $# -gt 0 ]; do
    case "$1" in
      --all-merged) target="__all__"; shift ;;
      --base)       base="${2:-}"; shift 2 ;;
      --force)      force=yes; shift ;;
      --dry-run)    dry=yes; shift ;;
      -*)           printf 'reap: 알 수 없는 인자 %s\n' "$1" >&2; return 2 ;;
      *)            target="$1"; shift ;;
    esac
  done
  [ -n "$target" ] || { printf 'reap: <슬러그> 또는 --all-merged 가 필요하다\n' >&2; return 2; }

  # F8: 일괄 모드와 --force 를 함께 쓰면 저장소의 모든 워크트리에서 미병합
  # 커밋과 미커밋 파일을 한 번에 버린다. 확인 절차가 없는 파괴는 막는다.
  if [ "$target" = "__all__" ] && [ "$force" = "yes" ]; then
    printf 'reap: --all-merged 와 --force 는 함께 쓸 수 없다\n' >&2
    printf '  한 번에 모든 워크트리의 미병합 커밋과 미커밋 파일을 버리게 된다.\n' >&2
    printf '  버릴 것을 먼저 보고(--all-merged --dry-run), 슬러그를 하나씩 지정해 --force 하라\n' >&2
    return 2
  fi

  local root; root="$(repo_root)"
  [ -n "$base" ] || base="$(git -C "$root" branch --show-current)"

  local slug state live path branch refused=0 matched=0 wt_id merged dirty token rows tl=""
  rows="$(collect_worktrees)"
  while IFS="$(printf '\t')" read -r slug state live path branch; do
    [ -n "$slug" ] || continue
    if [ "$target" != "__all__" ] && [ "$target" != "$slug" ]; then
      continue
    fi
    matched=$((matched + 1))

    # 무엇을 건드리지 않을지는 status 와 같은 판정으로 정한다.
    # waiting = 워커가 돌거나(F3) 터미널이 붙어 있다(F4). 둘 다 지울 대상이 아니다.
    # 보호 표시가 최우선이다. --force 로도 뚫리지 않는다 — 그게 이 표시의 뜻이다.
    if is_kept "$path"; then
      if [ "$target" = "__all__" ]; then
        printf '%s: 보호됨(.orca-keep) — 건너뛴다\n' "$slug"
        continue
      fi
      printf '%s: 보호된 워크트리다(.orca-keep). 지우려면 먼저 해제하라 — %s keep %s --remove\n' \
        "$slug" "$(basename "$0")" "$slug" >&2
      refused=$((refused + 1))
      continue
    fi

    merged="$(git_merged "$branch" "$base" "$path")"
    dirty="$(git_dirty_count "$path")"
    token="$(classify_worktree "$state" "$live" "$merged" "$dirty")"
    if [ "$token" = "waiting" ]; then
      if [ "$target" = "__all__" ]; then
        printf '%s: 워커·터미널이 살아 있어 건너뛴다 (워커 %s · 터미널 %s)\n' "$slug" "$state" "$live"
        continue
      fi
      # F13: 슬러그를 찍어도 마찬가지다. 다만 조용히 넘기지 않고 거부로 센다.
      printf '%s: 워커·터미널이 살아 있다 (워커 %s · 터미널 %s). 먼저 끝내라\n' \
        "$slug" "$state" "$live" >&2
      refused=$((refused + 1))
      continue
    fi

    # 자기가 서 있는 워크트리는 지우지 않는다.
    # 워크트리 안의 워커가 --all-merged 를 돌리면 자기 발밑을 무너뜨린다.
    if is_inside_path "$path"; then
      printf '%s: 지금 이 명령이 그 워크트리 안에서 돌고 있어 건너뛴다\n' "$slug" >&2
      continue
    fi

    if ! reap_gate "$slug" "$branch" "$path" "$base" "$force"; then
      refused=$((refused + 1))
      continue
    fi

    wt_id="$(repo_id)::$path"

    # dry-run 은 게이트를 통과했다는 사실만 보고하고 어떤 명령도 실행하지 않는다.
    if [ "$dry" = "yes" ]; then
      printf '%s: 정리 대상 (dry-run — 실행하지 않는다)\n' "$slug"
      continue
    fi

    printf '%s 정리\n' "$slug"
    release_workers "$wt_id"
    "$(orca_cli)" terminal close --worktree "id:$wt_id" --all --json >/dev/null 2>&1
    # --force 로 게이트를 넘긴 경우 rm 도 --force 라야 한다. 아니면 워커 회수와
    # 터미널 정지는 끝났는데 워크트리만 남는 반쪽 상태가 된다.
    if [ "$force" = "yes" ]; then
      "$(orca_cli)" worktree rm --worktree "id:$wt_id" --force --json >/dev/null 2>&1 \
        || printf '  경고: worktree rm 실패 — git 으로 확인이 필요하다\n' >&2
    else
      "$(orca_cli)" worktree rm --worktree "id:$wt_id" --json >/dev/null 2>&1 \
        || printf '  경고: worktree rm 실패 — git 으로 확인이 필요하다\n' >&2
    fi
    prune_leftovers "$path" "$root"
  done <<EOF
$rows
EOF

  # F7: Orca 도 git 도 모르는 고아 디렉터리를 함께 처리한다.
  while IFS="$(printf '\t')" read -r slug path; do
    [ -n "$slug" ] || continue
    if [ "$target" != "__all__" ] && [ "$target" != "$slug" ]; then
      continue
    fi
    matched=$((matched + 1))
    if is_inside_path "$path"; then
      printf '%s: 지금 이 명령이 그 디렉터리 안에서 돌고 있어 건너뛴다\n' "$slug" >&2
      continue
    fi
    # 워크트리 루프는 classify_worktree 가 터미널 생존을 보고 waiting 으로 빼 주지만,
    # 잔해 루프에는 그 판정이 없어 곧장 rm -rf 로 간다. 터미널이 붙은 디렉터리가
    # 잔해로 분류되면 워커가 도는 중에 작업 디렉터리가 통째로 사라진다.
    # 살아 있는 터미널은 --force 로도 뚫지 않는다 — waiting 과 같은 취급이다.
    # 잔해가 있을 때만 목록을 받고, 히어독 루프라 다음 반복까지 돌려 쓴다.
    [ -n "$tl" ] || tl="$("$(orca_cli)" terminal list --json 2>/dev/null)"
    live="$(terminals_at_path "$path" "$tl")"
    if [ "$live" != "0" ]; then
      if [ "$target" = "__all__" ]; then
        printf '%s: 잔해 디렉터리에 터미널 %s개가 붙어 있어 건너뛴다\n' "$slug" "$live"
        continue
      fi
      printf '%s: 잔해 디렉터리에 터미널 %s개가 붙어 있다. 먼저 끝내라\n' "$slug" "$live" >&2
      refused=$((refused + 1))
      continue
    fi
    if [ "$dry" = "yes" ]; then
      printf '%s: 잔해 디렉터리 — 제거 대상 (dry-run — 실행하지 않는다)\n' "$slug"
      continue
    fi
    printf '%s 잔해 정리\n' "$slug"
    prune_leftovers "$path" "$root" "$force" || refused=$((refused + 1))
  done <<EOF
$(collect_orphans "$(printf '%s' "$rows" | cut -f1)")
EOF

  # F10: 슬러그 오타가 "정리 완료"로 보고되던 것을 막는다.
  if [ "$target" != "__all__" ] && [ "$matched" -eq 0 ]; then
    printf 'reap: %s 라는 워크트리가 없다\n' "$target" >&2
    printf '  현황은 scripts/orca-worker.sh status 로 본다\n' >&2
    return 1
  fi

  [ "$refused" -eq 0 ]
}

# 워크트리에 붙은 Orca 터미널만 정지한다. 끝난 워커는 닫기 전에 회수하고(reap 과 같은
# 회수 → 닫기 순서), 워크트리도 브랜치도 건드리지 않는다.
#
# **이 verb 가 없으면 사람이 `orca terminal list | grep` 루프를 즉흥으로 짠다.**
# 그 평문 목록은 머신 전역이고 한 항목이 여러 줄(핸들 줄 + `preview:` + 가변 길이
# 미리보기)이라 `grep -B/-A` 창이 앞뒤 항목을 통째로 삼킨다. 그렇게 만든 루프는
# **다른 프로젝트의 터미널과 자기 자신의 터미널까지** 끄고, 끈 쪽은 무엇을 껐는지 모른다.
#
# 여기서는 `collect_worktrees` 가 `repoId` 로 거른 워크트리만 대상이 되고,
# 파괴 명령은 정확 일치 셀렉터를 받는 `terminal close --worktree --all` 하나뿐이다.
cmd_stop() {
  local target="" force=no dry=no
  while [ $# -gt 0 ]; do
    case "$1" in
      --all)     target="__all__"; shift ;;
      --force)   force=yes; shift ;;
      --dry-run) dry=yes; shift ;;
      -*)        printf 'stop: 알 수 없는 인자 %s\n' "$1" >&2; return 2 ;;
      *)         target="$1"; shift ;;
    esac
  done
  [ -n "$target" ] || { printf 'stop: <슬러그> 또는 --all 이 필요하다\n' >&2; return 2; }

  # `--force` 는 도는 워커를 끊으라는 뜻이다. 일괄 모드와 합치면 **이 저장소의 모든
  # 워커를 한 번에 끊고 exit 0** 이 된다 — 코드는 남지만 진행 중인 워커의 문맥은
  # 전부 사라지고, 끈 쪽은 무엇을 끊었는지 출력으로 알 수 없다.
  # reap 의 `--all-merged --force` 금지와 같은 관문이다.
  if [ "$target" = "__all__" ] && [ "$force" = "yes" ]; then
    printf 'stop: --all 과 --force 는 함께 쓸 수 없다\n' >&2
    printf '  한 번에 이 저장소의 도는 워커를 전부 끊게 된다. 코드는 남지만 문맥은 사라진다.\n' >&2
    printf '  끊을 것을 먼저 보고(--all --dry-run), 슬러그를 하나씩 지정해 --force 하라\n' >&2
    return 2
  fi

  local slug state live path branch refused=0 matched=0 rows repo
  repo="$(repo_id)"
  [ -n "$repo" ] || { printf 'stop: 이 저장소의 repoId 를 얻지 못했다. 중단한다\n' >&2; return 1; }
  rows="$(collect_worktrees)"

  while IFS="$(printf '\t')" read -r slug state live path branch; do
    [ -n "$slug" ] || continue
    if [ "$target" != "__all__" ] && [ "$target" != "$slug" ]; then
      continue
    fi
    matched=$((matched + 1))

    # 보호 표시는 여기서도 최우선이고 --force 로도 뚫리지 않는다.
    if is_kept "$path"; then
      if [ "$target" = "__all__" ]; then
        printf '%s: 보호됨(.orca-keep) — 건너뛴다\n' "$slug"
        continue
      fi
      printf '%s: 보호된 워크트리다(.orca-keep). 먼저 해제하라 — %s keep %s --remove\n' \
        "$slug" "$(basename "$0")" "$slug" >&2
      refused=$((refused + 1))
      continue
    fi

    # 자기가 서 있는 워크트리는 건너뛴다. 사고의 절반이 이것이었다 —
    # 손으로 짠 루프가 조율자 자신의 터미널을 껐고 그 세션이 그 자리에서 죽었다.
    if is_inside_path "$path"; then
      printf '%s: 지금 이 명령이 그 워크트리 안에서 돌고 있다 — 자기 터미널은 끄지 않는다\n' \
        "$slug" >&2
      continue
    fi

    if [ "$(is_worker_live "$state")" = "yes" ] && [ "$force" != "yes" ]; then
      if [ "$target" = "__all__" ]; then
        printf '%s: 워커가 도는 중이라 건너뛴다 (워커 %s). 끄려면 슬러그를 찍고 --force\n' \
          "$slug" "$state"
        continue
      fi
      printf '%s: 워커가 도는 중이다 (워커 %s). 정말 끊으려면 --force 를 준다\n' \
        "$slug" "$state" >&2
      refused=$((refused + 1))
      continue
    fi

    if [ "$live" = "0" ]; then
      printf '%s: 살아 있는 터미널이 없다 — 부를 것이 없다\n' "$slug"
      continue
    fi

    if [ "$dry" = "yes" ]; then
      printf '%s: 터미널 %s개 정지 대상 (dry-run — 실행하지 않는다)\n' "$slug" "$live"
      continue
    fi

    printf '%s: 터미널 %s개를 정지한다\n' "$slug" "$live"
    # 닫기 전에 회수한다 — reap 과 같은 순서다. close 는 터미널 탭까지 지우므로 닫은 뒤에는
    # worker-release 가 그 터미널을 찾지 못해 꼬리 보관 없이 회수하거나 release_unknown 으로
    # 남긴다. 도는 워커(active)는 release_disposition 이 건너뛰므로 --force 로 끊을 때도
    # 터미널만 닫는다. 회수 실패는 reap 처럼 경고만 내고 거부로 세지 않는다.
    release_workers "$repo::$path"
    "$(orca_cli)" terminal close --worktree "id:$repo::$path" --all --json >/dev/null 2>&1 \
      || { printf '  경고: terminal close 실패 — %s\n' "$slug" >&2; refused=$((refused + 1)); }
  done <<EOF
$rows
EOF

  # 저장소 밖 슬러그를 여기서 막는다. collect_worktrees 가 내지 않은 이름은
  # 이 저장소의 것이 아니므로 셀렉터를 만들지 않고 실패로 끝낸다.
  if [ "$target" != "__all__" ] && [ "$matched" -eq 0 ]; then
    printf 'stop: %s 라는 워크트리가 이 저장소에 없다\n' "$target" >&2
    printf '  현황은 %s status 로 본다\n' "$(basename "$0")" >&2
    return 1
  fi

  [ "$refused" -eq 0 ]
}

# Orca 런타임이 살아 있는지. 아니면 즉시 멈춘다 — 조용한 이탈을 막는다.
require_orca() {
  if ! "$(orca_cli)" status --json >/dev/null 2>&1; then
    printf 'Orca 런타임에 닿지 못했다. 워커를 띄울 수 없다\n' >&2
    return 1
  fi
}

# 경로로 워크트리 id 를 되찾는다.
# 생성 응답의 id 필드는 런타임 버전마다 위치가 다르고 null 인 경우가 있다.
# .result 는 실물에서 배열이고 다른 버전에서는 {worktrees:[...]} 다.
# jq 의 // 는 null·false 만 받아내고 에러는 잡지 못하므로 .worktrees 뒤에
# ? 를 반드시 붙인다 — 없으면 배열 응답에서 "Cannot index array" 로 죽는다.
# --limit 을 주지 않으면 응답이 절단(truncated)돼 방금 만든 워크트리를 못 찾는다.
worktree_id_for_path() {
  "$(orca_cli)" worktree list --limit 500 --json 2>/dev/null \
    | jq -r --arg p "$1" \
        '(.result.worktrees? // .result)[]? | select(.path == $p) | .id' \
    | head -1
}

create_worktree() {
  local slug="$1" base="$2" root
  root="$(repo_root)"
  "$(orca_cli)" worktree create \
      --name "$slug" \
      --repo "path:$root" \
      --base-branch "$base" \
      --setup run \
      --json >/dev/null 2>&1

  worktree_id_for_path "$root/.worktrees/$(basename "$root")/$slug"
}

# 새 브랜치가 기준과 같은 커밋에 서 있는지 확인하고, 아니면 되감는다.
# 브랜치명은 인자로 받지 않고 워크트리에서 직접 읽는다 — 슬러그와 브랜치명이
# 어긋나면 rev-list 가 실패하고 || printf '0' 이 그것을 "뒤처지지 않음"으로
# 삼켜 검증이 조용히 생략된다(안전하지 않은 방향의 fail-open).
verify_base() {
  local path="$1" base="$2" branch behind
  branch="$(git -C "$path" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ -z "$branch" ] || [ "$branch" = "HEAD" ]; then
    printf '기준 검증 실패: %s 의 브랜치를 읽지 못했다\n' "$path" >&2
    return 1
  fi
  behind="$(git -C "$path" rev-list --count "$branch..$base" 2>/dev/null)"
  if [ -z "$behind" ]; then
    printf '기준 검증 실패: %s..%s 를 셀 수 없다\n' "$branch" "$base" >&2
    return 1
  fi
  if [ "$behind" != "0" ]; then
    printf '기준보다 %s커밋 뒤에 있다. %s 로 되감는다\n' "$behind" "$base" >&2
    git -C "$path" reset --hard "$base" >/dev/null 2>&1 || {
      printf '되감기 실패: reset --hard %s\n' "$base" >&2
      return 1
    }
  fi
}

# gitignore 라 워크트리에 따라오지 않는 로컬 설정(.env)을 최상위에서 복사한다.
# 없으면 워크트리의 서버가 환경 변수 없이 떠서 설정 검증에 실패하거나 다른 Gateway·DB
# 경로를 향한다 — 로그에는 접속 오류만 찍혀 설정이 빠진 것이 보이지 않는다
# (docs/guides/worktree-workflow.md 2절). Orca 의 --setup run 은 .env 를 만들지
# 않으므로 새 워크트리에는 없는 것이 기본 상태다. 기본값(overwrite)은 항상 덮는다.
# 사용: sync_local_config <경로> [overwrite|preserve]
#
# **preserve 는 복구 경로(attach)를 위한 것이다.** attach 는 이미 사람이나 워커가
# 손댄 워크트리에 적용되고, .env 는 gitignore 라 되돌릴 이력이 없다. 무조건 덮으면
# 워커가 바꿔 둔 포트·DB 경로가 조용히 최상위 값으로 돌아가 **최상위 앱과 포트·DB 를
# 두고 충돌한다.** 그래서 preserve 는 **없을 때만 채우고, 다르면 알리고 그대로 둔다.**
sync_local_config() {
  local path="$1" mode="${2:-overwrite}" root src dst
  # repo_root 가 아니라 main_checkout 이다. 워크트리 안에서 sync-config 를 부르면
  # repo_root 는 그 워크트리를 내고, 원본과 대상이 같아져 "할 일 없음" 으로 조용히
  # 끝난다 — 고치려던 상황에서 아무 일도 일어나지 않는 것이 가장 나쁜 결말이다.
  root="$(main_checkout)"
  src="$root/.env"
  dst="$path/.env"

  # 최상위 자신을 가리키면 할 일이 없다(cp 가 "same file" 로 죽는다).
  [ "$src" = "$dst" ] && return 0

  if [ ! -f "$src" ]; then
    printf '경고: 최상위에 .env 가 없다. 워크트리 앱이 환경 변수 없이 떠서 Gateway·DB 접속이 실패한다\n' >&2
    return 1
  fi
  # preserve 인데 이미 내용이 있으면 손대지 않는다. 다르면 그 사실만 알린다.
  if [ "$mode" = "preserve" ] && [ -s "$dst" ]; then
    if cmp -s "$src" "$dst"; then
      printf '.env 는 최상위와 같다. 그대로 둔다\n' >&2
    else
      printf '경고: .env 가 최상위와 다르다. **덮지 않고 그대로 둔다** — 이 워크트리에서 바꾼 값일 수 있다\n' >&2
      printf '  최상위 값으로 맞추려면: scripts/orca-worker.sh sync-config %s\n' "$path" >&2
    fi
    return 0
  fi

  mkdir -p "$path" || {
    printf '경고: %s 를 만들지 못했다\n' "$path" >&2
    return 1
  }
  cp "$src" "$dst" || {
    printf '경고: .env 복사 실패\n' >&2
    return 1
  }
  printf '.env 를 최상위에서 복사했다\n' >&2
}

# BrowserOS neo 를 워커가 뜨기 *전에* 올린다.
#
# **워커는 `/mcp` 를 누를 수 없다.** 세션이 시작될 때 neo 가 꺼져 있었으면 그 워커에는
# `mcp__browseros-neo__*` 가 하나도 붙지 않고 나중에 켜도 소급되지 않는다. 메인 세션은
# 사람이 `/mcp` 로 붙여 줄 수 있지만 워커에게는 사람을 부를 자리가 없어, 그 워커는
# **수명 내내 브라우저를 못 본 채 나머지만 보고하고 끝난다.**
# → docs/guides/browser-verification.md 「둘은 같은 고장이 아니다 — 언제 꺼져 있었는가로 갈린다」
#
# 여기가 재는 것은 워크트리가 아니라 **기계 전역**이다. 그런데도 verify_setup 에 매다는
# 이유는 spawn 과 attach 두 길이 **모두** 이 함수를 워커가 뜨기 전에 부르기 때문이다.
#
# 설치돼 있지 않으면 조용히 넘어간다 — 그 환경은 neo 로 보지 않는다
# (browser-verification.md 「도구를 고르는 순서」 2번이 그 갈래를 받는다).
ensure_browser() {
  local app='/Applications/BrowserOS neo.app' url='http://127.0.0.1:9010/mcp'
  [ -d "$app" ] || return 0
  # 406 이 정상 응답이다. 코드가 무엇이든 **응답이 오면** 떠 있는 것이라 --fail 을 쓰지 않는다.
  curl -s -o /dev/null --max-time 2 "$url" && return 0
  printf 'BrowserOS neo 가 꺼져 있다. 워커가 뜨기 전에 켠다\n' >&2
  # -g: 포그라운드로 끌어올리지 않는다. spawn 도중에 사람의 창을 빼앗지 않기 위해서다.
  open -ga "$app" 2>/dev/null || {
    printf '경고: BrowserOS neo 를 켜지 못했다 — 이 워커는 브라우저 검증을 할 수 없다\n' >&2
    return 0
  }
  curl -s -o /dev/null --max-time 40 --retry 40 --retry-delay 1 --retry-connrefused "$url" || {
    printf '경고: BrowserOS neo 의 MCP 가 열리지 않았다 — 이 워커는 브라우저 검증을 할 수 없다\n' >&2
    return 0
  }
  printf 'BrowserOS neo 를 켰다\n' >&2
}

# --setup run 이 무엇을 했는지 믿지 않고 직접 잰다.
# 사용: verify_setup <경로> [overwrite|preserve]  — 두 번째 인자는 .env 정책이다
# 워크트리의 mise.toml 을 신뢰 목록에 올린다. mise 의 신뢰는 경로 단위라 최상위를 신뢰해도
# 워크트리 사본은 「not trusted」로 남고, 그러면 워커의 대화형 셸(mise activate)과 Bash 도구 훅이
# 핀한 Node 24 대신 PATH 의 다른 node(22)를 잡는다 — 2026-09-15 phase1-prep 워커가 실측.
# mise 가 없거나 mise.toml 이 없으면 조용히 통과한다.
trust_mise_config() {
  local path="$1"
  [ -f "$path/mise.toml" ] || return 0
  command -v mise >/dev/null 2>&1 || return 0
  mise trust "$path/mise.toml" >/dev/null 2>&1 \
    && printf 'mise.toml 을 신뢰 목록에 올렸다\n' >&2 \
    || printf '경고: mise trust 실패 — 워커 셸의 node 가 24 가 아닐 수 있다\n' >&2
}

verify_setup() {
  local path="$1" mode="${2:-overwrite}"
  trust_mise_config "$path"
  if [ ! -d "$path/node_modules" ]; then
    printf 'node_modules 가 없다. pnpm install 을 돌린다\n' >&2
    (cd "$path" && pnpm install >/dev/null 2>&1) \
      || printf '경고: pnpm install 실패\n' >&2
  fi
  sync_local_config "$path" "$mode" || true
  ensure_browser
}

# 워커 상태줄의 `Ctx Used` 를 찾는 정규식 조각.
#
# **낱말 사이가 보통 공백(0x20)이 아니다.** 실물 상태줄은 U+00A0 NO-BREAK SPACE
# (UTF-8 로 0xc2 0xa0)를 쓴다 — `terminal read --screen --json` 의 원문을 od 로 재면
# 이렇게 나온다:
#
#     C t x c2a0 U s e d : c2a0 <게이지> c2a0 1 2 . 0 %
#
# 그래서 보통 공백만 찾는 패턴은 **한 번도 맞지 않는다.** 그러면 상태줄을 영원히
# 「아직 안 그려졌다」로 읽어 시도를 다 태우고, **미제출 방어(0.0% → 엔터 재전송)에
# 도달하지 못한다** — 그 갈래가 이 장치의 존재 이유다. 실패는 조용하다: 성공한
# spawn 마다 경고가 한 줄 찍힐 뿐이고, 그 경고가 쌓이면 진짜 미제출까지 묻힌다.
#
# 두 갈래를 다 받는다. 런타임이 보통 공백으로 바뀌어도 계속 맞아야 한다.
# 대괄호가 아니라 교체(`|`)를 쓴다 — `[ \xc2\xa0]` 는 C 로케일에서 **한 바이트**만
# 세어 두 바이트짜리 NBSP 를 놓친다. 그 회귀는 개발자 기계의 UTF-8 로케일에서는
# **초록으로 통과하고** 컨테이너·cron·launchd 에서만 깨지므로, 테스트가 `LC_ALL=C` 를
# 명시로 걸어 잰다.
CTX_USED_RE='Ctx( |'$'\xc2\xa0'')Used'

# `terminal read --screen --json` 응답에서 **상태줄 한 줄**을 고른다. 없으면 빈 문자열.
#
# **응답 전체를 훑으면 스크롤백이 상태줄 행세를 한다.** `--screen` 이 내는 것은 렌더된
# 화면이고, 거기에는 워커가 읽은 브리프·문서·자기 출력이 그대로 떠 있다. 그 산문에
# `Ctx Used` 라는 글자가 있으면 두 갈래가 함께 깨진다.
#
#   - **상태줄이 아직 안 그려졌는데 「제출됨」으로 넘어간다** — 미제출을 놓치고 경고도 없다.
#   - **상태줄은 11.0% 인데 스크롤백의 `0.0%` 를 보고 미제출로 읽는다** — 멀쩡히 일하는
#     워커의 입력창에 엔터를 다시 보낸다.
#
# 그리고 이 규칙 자체가 산문이다 — **이 규칙을 인용하는 브리프로 워커를 띄우면 그 브리프
# 본문이 탐지를 만족시켜 그 워커의 미제출 탐지가 꺼진다.** 실물 화면에서 `Ctx Used` 를
# 담은 tail 줄이 여섯이었고 **그중 다섯이 산문**이었다(브리프·문서·자기 보고).
#
# 그래서 두 조건을 함께 만족하는 **마지막** 줄만 상태줄로 인정한다.
#   1) 앵커(`Ctx<공백류>Used`)에 맞고
#   2) **퍼센트를 같은 줄에 갖는다** — 산문은 앵커와 퍼센트를 한 줄에 같이 갖지 않는다.
#      실물에서 위 여섯 줄 중 퍼센트를 함께 가진 것은 상태줄 하나뿐이었다.
# 화면 맨 아래가 상태줄이므로 `last` 가 그것이다. 스크롤백은 언제나 그 위에 있다.
#
# `⎇ <브랜치>`(상태줄이 함께 갖는 2차 신호)를 **필수 앵커로 쓰지 않는다.** 그것까지
# 요구하면 상태줄 서식이 조금만 달라져도 매번 「상태줄을 못 읽었다」로 떨어져, 이 장치가
# 없애려는 경고 홍수가 그대로 돌아온다.
#
# `tail` 은 화면 줄의 배열이라는 **실물 모양**이다(`--screen --json` 응답을 직접 재서
# 확인했다). 모양이 달라지면 빈 문자열이 나오고, 그것은 「상태줄을 못 읽었다」 — 즉
# fail closed 다. 「제출됨」으로 넘어가지 않는다.
status_line() {
  printf '%s' "$1" | jq -r --arg re "$CTX_USED_RE" '
      [ .result.terminal.tail[]?
        | select(type == "string")
        | select(test($re))
        | select(test("[0-9]+([.][0-9]+)?%")) ]
      | last // ""' 2>/dev/null
}

# 브리프가 실제로 제출됐는지 확인한다.
# 상태줄의 Ctx Used 가 0.0% 면 모델이 한 번도 돌지 않은 것이므로 미제출이다.
#
# **「상태줄이 안 잡힌다」 갈래에는 반드시 대기가 있어야 한다.** 대기 없이 곧장
# 다음 시도로 가면 세 번이 0.5초에 소진되고, 갓 뜬 TUI 가 상태줄을 그리기도 전에
# 시도가 끝나 **미제출을 잡아 엔터를 다시 보내는 갈래에 영원히 도달하지 못한다.**
# 그러면 성공할 때마다 경고만 찍혀 진짜 경고까지 무시하게 된다.
verify_submitted() {
  local handle="$1" attempt=1 out line tries pause
  tries="${ORCA_WORKER_SUBMIT_TRIES:-6}"
  pause="${ORCA_WORKER_SUBMIT_SLEEP:-5}"
  while [ "$attempt" -le "$tries" ]; do
    # --screen 을 줘야 렌더된 상태줄을 읽는다. 기본 읽기는 누적 출력이라
    # 상태줄이 조각나 잡히지 않는다(orca terminal read --help).
    out="$("$(orca_cli)" terminal read --terminal "$handle" --screen --json 2>/dev/null)"
    # 응답 전체가 아니라 **상태줄 한 줄**만 본다 — 위 status_line 의 주석 참고.
    line="$(status_line "$out")"
    # 상태줄 자체가 안 잡히면 "제출됨"으로 넘기지 않는다 — 판정 불가는 실패다.
    if [ -z "$line" ]; then
      printf '상태줄(Ctx Used)이 아직 안 잡힌다. 그려질 때까지 기다린다 (%s/%s)\n' \
        "$attempt" "$tries" >&2
      sleep "$pause"
      attempt=$((attempt + 1))
      continue
    fi
    # `Used` 와 퍼센트 사이에는 `:`·NBSP·게이지 문자가 온다. 전부 숫자가 아니므로
    # `[^0-9]*` 가 건넌다. 첫 숫자가 `0.0%` 가 아니면(12.0% 등) 맞지 않는다.
    if ! printf '%s' "$line" | grep -qE "$CTX_USED_RE"'[^0-9]*0\.0%'; then
      return 0
    fi
    printf '브리프가 제출되지 않았다(Ctx Used 0.0%%). 엔터를 보낸다 (%s/%s)\n' \
      "$attempt" "$tries" >&2
    "$(orca_cli)" terminal send --terminal "$handle" --text "" --enter --json >/dev/null 2>&1
    # 엔터가 반영되기 전에 다시 읽으면 같은 0.0% 를 보고 또 보낸다.
    sleep "$pause"
    attempt=$((attempt + 1))
  done
  printf '경고: %s회 시도 후에도 제출을 확인하지 못했다. 터미널을 직접 확인하라\n' "$tries" >&2
  return 1
}

# TUI 가 그려질 때까지 기다린다. **붙이기 게이트가 아니다** — 붙이기는 이미 끝난
# 뒤이므로 여기서 tui-idle 은 「그려졌다」만 뜻한다. 옛 경로에서는 붙이기 앞의
# tui-idle 대기가 이 렌더 대기 노릇을 겸했고, 그것을 걷으면서 verify_submitted 가
# 상태줄을 못 본 채 시도를 소진했다.
wait_rendered() {
  "$(orca_cli)" terminal wait --terminal "$1" --for tui-idle \
    --timeout-ms "${ORCA_WORKER_RENDER_TIMEOUT_MS:-60000}" >/dev/null 2>&1 || true
}

# Run 이 바인딩돼 있지 않으면 task-create 가 run_required 로 실패한다.
# 이전 세션이 만든 Run 은 그 세션의 코디네이터 터미널에 묶여 있어 재사용되지
# 않는다(run-list 에는 보이지만 바인딩은 아니다). 그러므로 세션마다 확인하고
# 없으면 만든다.
#
# 워크트리를 만들기 *전에* 부른다 — 2026-09-01 에 이 확인이 없어 task-create 가
# run_required 로 죽었는데, 그때는 이미 워크트리가 만들어진 뒤라 잔해가 남았다.
ensure_run() {
  local objective="$1" rid
  rid="$("$(orca_cli)" orchestration run-current --json 2>/dev/null \
    | jq -r '.result.run.id // empty')"
  if [ -n "$rid" ]; then
    printf 'Run 바인딩 확인: %s\n' "$rid" >&2
    return 0
  fi
  rid="$("$(orca_cli)" orchestration run-create --objective "$objective" --json 2>/dev/null \
    | jq -r '.result.run.id // empty')"
  [ -n "$rid" ] || {
    printf 'spawn: Run 을 만들지 못했다(run-create 실패). 워크트리를 만들지 않고 중단한다\n' >&2
    return 1
  }
  printf 'Run 생성: %s\n' "$rid" >&2
}

# ---------------------------------------------------------------------------
# 붙이기(worker-start)
#
# 붙이기가 실패하는 진짜 이유는 재시도 횟수가 아니라 **경과 시간**이다. 갓 띄운
# 에이전트가 Orca 에 「알아볼 수 있는 에이전트」로 등록되기까지 1분을 넘길 수 있고,
# 그 전에 부른 worker-start 는 agent_unconfigured 로 거절된다. `terminal list` 의
# agentIdentity 는 그 게이트가 아니다 — 거절당하는 순간에도 "claude" 로 나온다.
# `terminal wait --for` 가 아는 조건은 exit 과 tui-idle 뿐이라 스크립트 쪽에서
# 그 등록을 기다릴 방법이 없다. 그래서 기다리는 일을 게이트를 아는 쪽(Orca)에
# 맡긴다 — worker-start 가 에이전트를 직접 띄우게 하고(--agent), 그 호출에
# 넉넉한 --timeout-ms 를 준다.
# ---------------------------------------------------------------------------

# 실패 봉투에서 「어디까지 갔다가 실패했는가」를 낸다. 없으면 빈 문자열.
#
# `worker-start --help`: *Failed or outcome_unknown exits 1 and JSON includes
# stage/failedStage, setup, effects, residualResources, and recovery commands when needed.*
# **이 필드들을 실물에서 본 적은 없다.** 관측된 worker-start 실패 봉투(task_not_found ·
# terminal_handle_stale · selector_not_found · agent_unconfigured)는 전부
# `.error.data` 에 `orchestrationRequestId`·`originalCommand` 둘뿐이었다 —
# **넷 다 「띄우기를 시작하기 전」의 검증 단계 실패라 남은 자원도, 그 필드도 없다.**
# `when needed` 가 그 뜻으로 읽힌다. 그 부류는 파괴적이지 않게 재현할 수 없다 —
# **이름만 `--help` 가 주고, 어느 깊이에 오는지는 아무도 모른다. 관측처럼 읽지 마라.**
# 그래서 자리를 짚지 않고 **봉투 전체를 이름으로 훑는다.** 못 찾으면 빈 문자열이다.
attach_stage() {
  jq -r '[ .. | objects | (.failedStage?, .stage?) | select(type == "string") ]
         | (map(select(. != "")) | .[0]) // ""' "$1" 2>/dev/null
}

# 남은 자원의 개수. 못 읽거나 없으면 0.
#
# **깊이를 짚지 않고 봉투 전체를 이름으로 훑는다.** 이름(`residualResources`)은
# `worker-start --help` 가 준 것이라 추측이 아니지만, **어느 깊이에 오는지는 관측된 적이
# 없다.** 자리를 하나 골라 거기만 보면 그 자리가 틀렸을 때 0건으로 읽히고, 봉투가
# `effectsApplied:false` 를 함께 달고 있으면 `clean` 으로 떨어져 **재시도한다** —
# 「자리를 틀려도 fail closed」가 그 칸에서만 참이 아니게 된다. 훑으면 그 칸이 사라진다.
#
# 남는 불확실성은 **이름 하나**다. 런타임이 다른 이름으로 부르면 못 찾고, 그때
# `effectsApplied:false` 가 함께 오면 재시도한다. 그 칸은 테스트가 의도적으로 단언한다 —
# 이름을 모르는 채로는 더 좁힐 수 없고, **모르는 것을 아는 척 좁히면 그것이 다음 거짓이다.**
#
# 배열이 아닌 값(객체·스칼라)도 「무엇인가 남았다」로 센다. 재시도하지 않는 쪽이 안전하다.
attach_residual_count() {
  jq -r '[ .. | objects | select(has("residualResources")) | .residualResources
           | select(. != null)
           | if (type == "array" or type == "object") then .[]? else . end ] | length' \
     "$1" 2>/dev/null
}

# 남은 자원과 정본이 함께 주는 복구 명령을 **그대로** 보여 준다.
#
# 모양을 모르므로 해석하지 않고 각 항목을 압축 JSON 한 줄로 낸다. 지어낸 필드명으로
# 예쁘게 찍으려다 틀리면, 조율자는 거짓 요약을 근거로 손을 댄다.
# 복구 명령의 키 이름도 모른다 — `nextSteps` 만 실물 오류 봉투(task-update 의
# run_required)에서 관측됐고 나머지는 `--help` 문장에서 왔다.
print_residual() {
  local resp="$1"
  printf '  남은 자원(residualResources):\n' >&2
  jq -r '[ .. | objects | select(has("residualResources")) | .residualResources
           | select(. != null)
           | if (type == "array" or type == "object") then .[]? else . end ]
         | .[] | if type == "string" then . else tojson end' "$resp" 2>/dev/null \
    | sed 's/^/    /' >&2
  jq -r '[ .. | objects | to_entries[]
           | select(.key == "recoveryCommands" or .key == "recovery" or .key == "nextSteps")
           | .value | arrays | .[] ]
         | .[] | if type == "string" then . else tojson end' "$resp" 2>/dev/null \
    | sed 's/^/    복구: /' >&2
}

# 실패한 worker-start 응답에서 「무엇이 이미 먹혔는가」를 판정한다.
# 출력: "<판정> <requestId>" — 판정은 residual|delivered|landed|pending|clean|unknown.
#
#   residual   남은 자원(residualResources)이 있다. 스킬 정본이 실패 시
#              stage·effects·residualResources 를 보라며 *instead of guessing or
#              automatically retrying* 라고 못박는다. **어떤 재시도도 하지 않고**
#              무엇이 남았는지와 복구 명령을 조율자에게 그대로 넘긴다.
#   delivered  브리프가 이미 워커에게 들어갔다. 다시 부르면 같은 지시가 두 번
#              주입된다. 근거는 effects 의 dispatch_input(state=accepted) 이다.
#   landed     request-show 가 completed 다 — 그 mutation 은 이미 끝났고, 같은
#              requestId 로 부르면 Orca 가 **두 번째를 시작하는 대신 기록된 결과를
#              재생한다**. 그러므로 중복 주입 없이 진실(성공 여부·핸들)을 되받을 수 있다.
#   pending    원래 호출이 아직 살아 있거나 결과가 기록되기 전이다. 같은
#              requestId 를 --retry-request 로 되돌려 주는 것만 안전하다.
#   clean      효과가 하나도 적용되지 않았음이 응답에 적혀 있다(effectsApplied
#              false). 새로 부르는 것이 안전하다.
#   unknown    판정할 수 없다. **조용히 재시도하지 않는다.** request-show 의
#              absent 는 "아무 일도 없었다"는 증거가 아니라고 런타임이 직접 말한다.
#
# **관측된 worker-start 실패 봉투는 `.error.data` 에 `orchestrationRequestId` 와
# `originalCommand` 둘뿐이었다**(task_not_found 로 확인). `effects` 도
# `effectsApplied` 도 없었다. `effectsApplied` 는 다른 오류 부류에서는 실제로 온다
# (`task-update` 의 `run_required` 로 확인) — 그래서 두 갈래를 지우지 않고 남긴다.
# **다만 지금 실물에서 worker-start 실패는 전부 `unknown` 으로 떨어져 재시도하지
# 않는다.** 아래 두 갈래는 그 점에서 **추측 경로**다. 위치가 틀려도 fail open 이
# 되지는 않는다 — 못 알아보면 `unknown` 이고, `unknown` 은 재시도하지 않는다.
attach_verdict() {
  local resp="$1" rid injected state applied residual

  rid="$(jq -r '.error.data.orchestrationRequestId? // empty' "$resp" 2>/dev/null)"

  # 남은 자원이 있으면 **어떤 재시도도 하지 않는다.** 스킬 정본이 실패 시
  # stage·effects·residualResources 를 보라고 하며 *instead of guessing or
  # automatically retrying* 라고 못박는다 — 그 금지는 조건이 없으므로 아래
  # 어느 갈래보다 먼저 온다. 자리는 짚지 않고 이름으로 훑으므로 깊이가 달라도 찾는다 —
  # **남는 구멍은 이름 하나뿐이고, 그 칸이 어떻게 떨어지는지는 테스트가 단언한다.**
  residual="$(attach_residual_count "$resp")"
  if [ -n "$residual" ] && [ "$residual" != "0" ]; then
    printf 'residual %s\n' "$rid"
    return 0
  fi

  # 추측 경로 1 — worker-start 실패 봉투에서 effects 를 관측한 적은 없다.
  # 모양은 worker-show 실물 응답의 .result.worker.effects 를 따랐다.
  injected="$(jq -r '
      [ (.error.data.effects? // .result.worker.effects? // [])[]?
        | select(.kind? == "dispatch_input")
        | select((.state? // "") == "accepted") ] | length' "$resp" 2>/dev/null)"
  if [ -n "$injected" ] && [ "$injected" != "0" ]; then
    printf 'delivered %s\n' "$rid"
    return 0
  fi

  # 추측 경로 2 — worker-start 실패 봉투에서 이 필드를 관측한 적은 없다.
  # effectsApplied 는 불리언이다. jq 의 // 는 false 도 "없음"으로 삼키므로
  # 여기서 // 를 쓰면 "효과 없음"이 "판정 불가"로 뒤집힌다.
  applied="$(jq -r '.error?.data?.effectsApplied?
                    | if . == null then "" else tostring end' "$resp" 2>/dev/null)"

  if [ -n "$rid" ]; then
    state="$("$(orca_cli)" orchestration request-show --request "$rid" --json 2>/dev/null \
      | jq -r '.result.state? // empty')"
    case "$state" in
      completed) printf 'landed %s\n' "$rid";    return 0 ;;
      pending)   printf 'pending %s\n' "$rid";   return 0 ;;
    esac
  fi

  if [ "$applied" = "false" ]; then
    printf 'clean %s\n' "$rid"
  else
    printf 'unknown %s\n' "$rid"
  fi
}

# 양의 정수(0 포함)인지. 아니면 rc=1.
# 예산은 이 스크립트의 퓨즈다. `[ 5 -ge abc ]` 는 rc=2 로 죽고 `if` 가 그것을
# **거짓으로 삼켜** 루프가 끝나지 않는다 — 앞뒤 공백(" 240 ")·16진수(0x10)도 같다.
# 그래서 쓰기 전에 재고, 아니면 기본값으로 되돌린다.
is_uint() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
    *)           return 0 ;;
  esac
}

# 환경변수를 정수로 읽고, 정수가 아니면 알린 뒤 기본값을 쓴다.
# 사용: uint_env <이름> <기본값>
uint_env() {
  local name="$1" fallback="$2" value
  eval "value=\"\${$name:-}\""
  if [ -z "$value" ]; then
    printf '%s\n' "$fallback"
    return 0
  fi
  if is_uint "$value"; then
    printf '%s\n' "$value"
  else
    printf '경고: %s=%s 는 정수가 아니다. 기본값 %s 를 쓴다\n' "$name" "$value" "$fallback" >&2
    printf '%s\n' "$fallback"
  fi
}

# 같은 requestId 로 되돌려 준다. Orca 는 두 번째 작업을 시작하는 대신
# 기록된 결과를 재생하거나 원래 호출에 합류한다 — 중복 주입이 생기지 않는다.
# 사용: replay_worker_start <응답파일> <requestId> <worker-start 인자...>
replay_worker_start() {
  local resp="$1" rid="$2"; shift 2
  "$(orca_cli)" orchestration worker-start "$@" --retry-request "$rid" --json \
    >"$resp" 2>"$resp.err"
}

# worker-start 를 부르고, 실패하면 「이미 먹혔는가」를 물은 뒤에만 다시 부른다.
# 사용: attach_worker <응답파일> <worker-start 인자...>
# 종료코드 0=붙었다, 2=브리프는 전달됐지만 supervised 가 아니다, 1=붙지 못했다.
#
# **퓨즈가 둘이다.** 시간 예산 하나만 두면 그 한 값이 정수가 아니거나 시계가
# 뒤로 가는 순간 루프가 끝나지 않는다 — 퓨즈가 하나뿐이면 퓨즈가 아니다.
# 그래서 시도 횟수 상한을 함께 둔다. 벽시계 최악은
# 예산 + worker-start 한 번의 --timeout-ms + 간격 이다(검사가 호출 뒤에 오므로).
attach_worker() {
  local resp="$1"; shift
  local budget interval maxtries tries started now elapsed verdict rid stage

  budget="$(uint_env ORCA_WORKER_ATTACH_BUDGET_SEC 240)"
  interval="$(uint_env ORCA_WORKER_RETRY_SLEEP 15)"
  maxtries="$(uint_env ORCA_WORKER_ATTACH_MAX_TRIES 8)"
  [ "$maxtries" -ge 1 ] || maxtries=1
  tries=0
  started="$(date +%s 2>/dev/null)"
  is_uint "$started" || started=0

  while :; do
    tries=$((tries + 1))
    if "$(orca_cli)" orchestration worker-start "$@" --json >"$resp" 2>"$resp.err"; then
      return 0
    fi

    verdict="$(attach_verdict "$resp")"
    rid="${verdict#* }"
    verdict="${verdict%% *}"

    stage="$(attach_stage "$resp")"

    case "$verdict" in
      residual)
        printf '붙이기 실패 — 남은 자원이 있다(%s). 자동으로 재시도하지 않는다\n' \
          "$(jq -r '.error.code? // "코드 없음"' "$resp" 2>/dev/null)" >&2
        [ -n "$stage" ] \
          && printf '  어디까지 갔는가: %s\n' "$stage" >&2
        print_residual "$resp"
        printf '  남은 것을 정리하거나 인계한 뒤에 다시 붙여라. 그 전에 다시 부르면 자원이 겹친다\n' >&2
        return 1
        ;;
      delivered)
        printf '붙이기 실패 — 그러나 브리프는 이미 워커에게 전달됐다(%s).\n' \
          "$(jq -r '.error.code? // "판정: effects"' "$resp" 2>/dev/null)" >&2
        printf '  다시 붙이면 같은 지시가 두 번 주입된다. 재시도하지 않는다\n' >&2
        return 2
        ;;
      landed|pending)
        if [ "$verdict" = "landed" ]; then
          printf '붙이기 실패로 보이지만 그 요청(%s)은 이미 끝났다(request-show: completed).\n' "$rid" >&2
          printf '  같은 요청으로 되돌려 결과를 받는다 — 두 번째 작업은 시작되지 않는다\n' >&2
        else
          printf '붙이기 실패 — 원래 호출(requestId %s)이 아직 정리되지 않았다. 같은 요청으로 이어받는다\n' "$rid" >&2
        fi
        if replay_worker_start "$resp" "$rid" "$@"; then
          return 0
        fi
        # 이어받기까지 실패하면 그 응답을 다시 판정한다. 새로 부르지 않는다.
        case "$(attach_verdict "$resp")" in
          delivered*) return 2 ;;
          residual*)  print_residual "$resp" ;;
        esac
        printf '  이어받기도 실패했다. 재시도하지 않는다\n' >&2
        return 1
        ;;
      unknown)
        printf '붙이기 실패 — 이미 먹혔는지 확인할 수 없다(%s).\n' \
          "$(jq -r '.error.code? // "코드 없음"' "$resp" 2>/dev/null)" >&2
        # 「판정 불가」한 마디로 끝내면 조율자가 터미널을 손으로 뒤지러 간다.
        # 어디까지 갔는지를 봉투가 말하면 그것부터 보여 준다.
        [ -n "$stage" ] \
          && printf '  어디까지 갔는가: %s\n' "$stage" >&2
        [ -n "$rid" ] \
          && printf '  request-show 로 직접 확인하라: orchestration request-show --request %s --json\n' "$rid" >&2
        printf '  중복 주입을 막기 위해 재시도하지 않는다\n' >&2
        return 1
        ;;
    esac

    # clean — 효과가 적용되지 않았다. 시간을 더 주고 다시 부른다.
    if [ "$tries" -ge "$maxtries" ]; then
      printf '붙이기 실패 — %s회(상한 %s회) 시도했다: %s\n' "$tries" "$maxtries" \
        "$(jq -r '.error.code? // "코드 없음"' "$resp" 2>/dev/null)" >&2
      [ -n "$stage" ] && printf '  어디까지 갔는가: %s\n' "$stage" >&2
      return 1
    fi
    now="$(date +%s 2>/dev/null)"
    is_uint "$now" || now="$started"
    elapsed=$((now - started))
    # 시계가 뒤로 가면 경과가 음수가 돼 예산에 영원히 걸리지 않는다.
    # 그때는 기준 시각을 다시 잡고, 횟수 상한이 퓨즈 노릇을 이어받는다.
    if [ "$elapsed" -lt 0 ]; then
      started="$now"
      elapsed=0
    fi
    if [ "$elapsed" -ge "$budget" ]; then
      printf '붙이기 실패 — %s초(예산 %s초) 동안 붙지 못했다: %s\n' \
        "$elapsed" "$budget" \
        "$(jq -r '.error.code? // "코드 없음"' "$resp" 2>/dev/null)" >&2
      [ -n "$stage" ] && printf '  어디까지 갔는가: %s\n' "$stage" >&2
      return 1
    fi
    printf '아직 붙지 못했다(%s, 경과 %s초, %s/%s회). 효과는 적용되지 않았다 — %s초 뒤 다시 부른다\n' \
      "$(jq -r '.error.code? // "코드 없음"' "$resp" 2>/dev/null)" \
      "$elapsed" "$tries" "$maxtries" "$interval" >&2
    sleep "$interval"
  done
}

# 붙은 뒤 워커의 터미널 핸들을 찾는다.
# 영수증의 필드 위치는 런타임 버전마다 다르므로, 못 찾으면 워크트리로 되짚는다
# (orca skills get orchestration 의 핸들 복구 순서와 같다).
attach_handle() {
  local resp="$1" wt_id="$2" handle
  handle="$(jq -r '.result.worker.agent_terminal_handle?
                   // .result.worker.agentTerminalHandle?
                   // .result.agentTerminalHandle?
                   // .result.terminal.handle?
                   // empty' "$resp" 2>/dev/null)"
  if [ -z "$handle" ]; then
    handle="$("$(orca_cli)" terminal list --worktree "id:$wt_id" --json 2>/dev/null \
      | jq -r '[ .result.terminals[]?
                 | select((.agentIdentity? // "") != "")
                 | select(.orphaned? != true) ] | last | .handle? // empty')"
  fi
  printf '%s\n' "$handle"
}

# 붙지 못한 채 살아 있는 워커를 조율자가 잃지 않게 한다.
# `wait` 은 supervised 워커의 worker_done 만 받는다 — 붙지 않은 워커는 정상적으로
# 일을 마쳐도 그 신호가 오지 않아 조율자가 영원히 기다린다.
print_unsupervised() {
  local handle="$1" slug="$2"
  printf '\n⚠ 이 워커는 supervised 가 아니다 — `wait` 로 잡히지 않는다.\n' >&2
  printf '  완료 신호가 오지 않으므로 터미널을 직접 읽어야 한다:\n' >&2
  if [ -n "$handle" ]; then
    printf '    %s terminal read --terminal %s --screen --json\n' "$(orca_cli)" "$handle" >&2
  else
    printf '    %s terminal list --worktree <셀렉터> --json 으로 핸들을 먼저 찾아라\n' "$(orca_cli)" >&2
  fi
  printf '  워크트리(%s)와 터미널은 그대로 둔다. 세팅은 이미 끝나 있다\n' "$slug" >&2
}

cmd_spawn() {
  local slug="" role="" model_override="" brief="" base=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --model) model_override="${2:-}"; shift 2 ;;
      --brief) brief="${2:-}"; shift 2 ;;
      --base)  base="${2:-}"; shift 2 ;;
      -*)      printf 'spawn: 알 수 없는 인자 %s\n' "$1" >&2; return 2 ;;
      *)
        if [ -z "$slug" ]; then slug="$1"; else role="$1"; fi
        shift
        ;;
    esac
  done
  [ -n "$slug" ] && [ -n "$role" ] || {
    printf 'spawn: <슬러그> <역할> 이 필요하다\n' >&2; return 2; }

  local model root wt_id path task_id handle
  model="$(resolve_model "$role" "$model_override")" || return 1
  require_orca || return 1
  ensure_run "$role:$slug" || return 1

  root="$(repo_root)"
  [ -n "$base" ] || base="$(git -C "$root" branch --show-current)"

  wt_id="$(create_worktree "$slug" "$base")"
  [ -n "$wt_id" ] || { printf 'spawn: 워크트리 생성 실패\n' >&2; return 1; }
  path="${wt_id#*::}"

  verify_base "$path" "$base" || return 1
  verify_setup "$path"

  # 브리프는 task-create --spec 으로 전달한다. worker-start 가 그 spec 을 TASK
  # 블록으로 워커에 주입한다(orca skills get orchestration 의
  # 「Preferred Supervised Worker Loop」 절).
  # worker-start 에 --prompt-file 이라는 플래그는 존재하지 않는다.
  local spec
  if [ -n "$brief" ]; then
    [ -f "$brief" ] || { printf 'spawn: 브리프 파일이 없다: %s\n' "$brief" >&2; return 1; }
    spec="$(cat "$brief")"
    [ -n "$spec" ] || { printf 'spawn: 브리프 파일이 비었다: %s\n' "$brief" >&2; return 1; }
  else
    # --spec 은 필수 플래그다. 브리프가 없으면 최소 지시를 넣는다.
    spec="워크트리 $slug 에서 $role 역할로 작업한다. 구체적 지시는 코디네이터가 곧 보낸다 — 그때까지 저장소를 파악하고 대기하라."
  fi

  # 워크트리 준비가 끝났으니 tiergear 를 부를 수 있다(floor 파일이 이 경로에 쓰인다).
  select_worker_model "$role" "$model" "$model_override" "$spec" "$path"

  local tc_out
  tc_out="$("$(orca_cli)" orchestration task-create \
      --spec "$spec" --task-title "$role:$slug" --json 2>&1)"
  task_id="$(printf '%s' "$tc_out" | jq -r '.result.task.id // .result.id // empty' 2>/dev/null)"
  # handle 에만 있고 task_id 에는 없던 가드다. 없으면 task-create 실패가
  # worker-start 실패로 이어지고도 exit 0 성공 요약으로 끝난다.
  [ -n "$task_id" ] || {
    printf 'spawn: 태스크를 만들지 못했다(task-create 실패). 터미널을 만들지 않고 중단한다\n' >&2
    # 오류를 감추면 원인(run_required 등)을 찾는 데 세션 하나가 든다.
    printf '  %s\n' "$(printf '%s' "$tc_out" | jq -r '.error.message // .' 2>/dev/null | head -3)" >&2
    return 1
  }

  # 터미널을 직접 만들지 않는다. worker-start 가 에이전트를 띄우고 그 자리에서
  # 붙이면 「띄웠지만 아직 붙일 수 없는」 창 자체가 없어진다 — 등록을 기다리는
  # 일이 게이트를 아는 쪽으로 넘어간다. --model 은 --terminal 과 함께 쓸 수 없고
  # --agent 와만 쓴다(orca orchestration worker-start --help).
  local resp rc
  resp="$(mktemp)"
  attach_worker "$resp" \
    --task "$task_id" --worktree "id:$wt_id" \
    --agent claude --model "$WM_MODEL" ${WM_EFFORT:+--effort "$WM_EFFORT"} \
    --timeout-ms "${ORCA_WORKER_START_TIMEOUT_MS:-180000}"
  rc=$?

  handle="$(attach_handle "$resp" "$wt_id")"
  rm -f "$resp" "$resp.err"

  if [ "$rc" -ne 0 ]; then
    printf 'spawn: supervised 로 붙지 못했다\n' >&2
    if [ "$rc" -eq 2 ]; then
      printf '  브리프는 전달됐다 — attach 를 부르지 마라. 같은 지시가 두 번 주입된다\n' >&2
    else
      printf '  워크트리는 그대로 둔다(pnpm·.env 세팅 완료). 다시 붙이기:\n' >&2
      printf '    scripts/orca-worker.sh attach %s %s%s\n' "$slug" "$role" \
        "$([ -n "$brief" ] && printf ' --brief %s' "$brief")" >&2
    fi
    print_unsupervised "$handle" "$slug"
    return 1
  fi

  # 빈 핸들로 read/send 를 부르면 Orca 가 코디네이터 자신의 터미널로 해석한다.
  # 실측으로 실제 발생했다 — 반드시 여기서 멈춘다.
  [ -n "$handle" ] || {
    printf 'spawn: 붙긴 했으나 터미널 핸들을 얻지 못했다. 중단한다\n' >&2
    return 1
  }

  # worker-start 가 만든 터미널에는 우리 제목이 없다. 붙인 뒤에 붙여 준다.
  # (--display-name 은 이미 있는 워크트리에서 거부된다. 에이전트가 곧 자기 상태로
  # 덮으므로 잠깐 보이는 이름일 뿐이고, 실패해도 아무것도 잃지 않는다.)
  "$(orca_cli)" terminal rename --terminal "$handle" --title "$role:$slug" --json >/dev/null 2>&1

  wait_rendered "$handle"
  verify_submitted "$handle" || true

  printf '워크트리: %s\n태스크: %s\n터미널: %s\n모델: %s\n' \
    "$wt_id" "$task_id" "$handle" "$(model_label)"
  printf '\n다음: scripts/orca-worker.sh wait\n'
}

# 이미 세팅된 워크트리에 워커를 다시 붙인다.
# spawn 이 붙이기에 실패했을 때 워크트리(pnpm·.env)와 살아 있는
# 터미널을 버리지 않고 그대로 쓰기 위한 복구 경로다. 실패한 Task 는 failed 로
# 잠겨 재시작할 수 없으므로 Task 만 새로 세운다.
#
# 사용: attach <슬러그> <역할> [--model ...] [--brief <파일>] [--terminal <핸들>] [--force]
cmd_attach() {
  local slug="" role="" model_override="" brief="" handle="" force=no
  while [ $# -gt 0 ]; do
    case "$1" in
      --model)    model_override="${2:-}"; shift 2 ;;
      --brief)    brief="${2:-}"; shift 2 ;;
      --terminal) handle="${2:-}"; shift 2 ;;
      --force)    force=yes; shift ;;
      -*)         printf 'attach: 알 수 없는 인자 %s\n' "$1" >&2; return 2 ;;
      *)
        if [ -z "$slug" ]; then slug="$1"; else role="$1"; fi
        shift
        ;;
    esac
  done
  [ -n "$slug" ] && [ -n "$role" ] || {
    printf 'attach: <슬러그> <역할> 이 필요하다\n' >&2; return 2; }

  local model path wt_id spec task_id tc_out live resp rc
  model="$(resolve_model "$role" "$model_override")" || return 1
  require_orca || return 1

  path="$(worktrees_dir)/$slug"
  [ -d "$path" ] || {
    printf 'attach: 워크트리가 없다: %s (붙일 대상이 없으면 spawn 을 쓴다)\n' "$path" >&2
    return 1
  }
  wt_id="$(worktree_id_for_path "$path")"
  [ -n "$wt_id" ] || {
    printf 'attach: Orca 가 %s 를 워크트리로 모른다\n' "$path" >&2; return 1; }

  # 핸들을 주지 않으면 그 워크트리에 살아 있는 에이전트 터미널을 쓴다.
  # 없으면 --agent 로 새로 띄운다 — 그래도 워크트리 세팅은 그대로 산다.
  # **리뷰는 예외다 — 살아 있는 터미널을 쓰지 않고 늘 새로 띄운다.** 끝난 구현자의
  # 터미널은 살아 있으므로 거기에 붙이면 리뷰가 구현자 자신의 문맥에서 돈다(독립 리뷰가
  # 아니다). --terminal 을 준 리뷰는 사람이 고른 것이라 그대로 받는다.
  local wt_terms live_handles
  wt_terms="$("$(orca_cli)" terminal list --worktree "id:$wt_id" --json 2>/dev/null)"
  if [ -z "$handle" ]; then
    live_handles="$(printf '%s' "$wt_terms" \
      | jq -r '.result.terminals[]?
               | select((.agentIdentity? // "") != "")
               | select(.orphaned? != true)
               | select(.connected? != false) | .handle? // empty')"
    if [ "$role" != "review" ]; then
      handle="$(printf '%s\n' "$live_handles" | sed '/^$/d' | tail -n 1)"
    fi
  else
    # **--terminal 로 받은 핸들이 이 워크트리 것인지 먼저 잰다.** 확인 없이 넘기면
    # 다른 워크트리(다른 프로젝트일 수도 있다)에서 도는 워커에 브리프가 주입된다 —
    # 이 스크립트가 앞서 고친 사고가 정확히 「범위를 넘는 것」이었다.
    # --force 로도 뚫지 않는다. 이것은 중복 주입이 아니라 오폭 방지다.
    if ! printf '%s' "$wt_terms" \
        | jq -e --arg h "$handle" '[ .result.terminals[]? | select(.handle? == $h) ] | length > 0' \
          >/dev/null 2>&1; then
      printf 'attach: 터미널 %s 는 워크트리 %s 의 것이 아니다\n' "$handle" "$slug" >&2
      printf '  그 워크트리의 터미널을 보려면: %s terminal list --worktree "id:%s" --json\n' \
        "$(orca_cli)" "$wt_id" >&2
      return 1
    fi
  fi

  # 진행 중인 Dispatch 가 붙어 있는 터미널에 또 주입하면 워커가 같은 지시를 두 번
  # 받는다. 그 워커가 이미 브리프를 받고 일하는 중일 수 있다.
  # **새로 띄우는 리뷰도 같은 검사를 받는다** — 그 터미널에 붙지는 않지만, 구현자가 아직
  # 일하는 중에 리뷰어를 띄우면 반쯤 된 트리를 리뷰하고 두 에이전트가 한 워크트리를 함께
  # 고친다(리뷰어의 변이 테스트도 파일을 잠시 고친다).
  local check_handles busy_handle
  check_handles="$handle"
  [ -z "$handle" ] && [ "$role" = "review" ] && check_handles="$live_handles"
  if [ -n "$check_handles" ] && [ "$force" != "yes" ]; then
    live="$("$(orca_cli)" orchestration worker-list --json 2>/dev/null \
      | jq -r --arg hs "$check_handles" \
          '($hs | split("\n") | map(select(. != ""))) as $hs
           | [ .result.workers[]?
               | select(.agentTerminalHandle? as $h | any($hs[]; . == $h))
               | select(.dispatchStatus? == "dispatched") ] | last
           | select(. != null) | "\(.agentTerminalHandle) \(.dispatchId // "")"')"
    if [ -n "$live" ]; then
      busy_handle="${live%% *}"
      live="${live#* }"
      if [ -n "$handle" ]; then
        printf 'attach: 터미널 %s 에 아직 진행 중인 Dispatch(%s)가 있다\n' "$handle" "$live" >&2
        printf '  그 워커는 이미 브리프를 받았을 수 있다. 다시 붙이면 같은 지시가 두 번 주입된다\n' >&2
      else
        printf 'attach: 구현자 터미널 %s 에 아직 진행 중인 Dispatch(%s)가 있다\n' \
          "$busy_handle" "$live" >&2
        printf '  구현이 끝나기 전에 리뷰를 띄우면 반쯤 된 트리를 리뷰하고 두 에이전트가 같은 워크트리를 함께 고친다\n' >&2
        printf '  끝을 받은 뒤 붙여라: scripts/orca-worker.sh wait\n' >&2
      fi
      printf '  먼저 읽어 확인하라: %s terminal read --terminal %s --screen --json\n' \
        "$(orca_cli)" "$busy_handle" >&2
      printf '  확인하고도 붙이려면 --force\n' >&2
      return 1
    fi
  fi

  ensure_run "$role:$slug" || return 1

  # 워크트리는 살아 있어도 setup 이 반쯤 된 채 남았을 수 있다. 다시 맞춘다.
  # **.env 는 덮지 않는다** — 이 워크트리에서 바꾼 값일 수 있고,
  # gitignore 라 덮으면 되돌릴 이력이 없다. 「워크트리를 버리지 않는다」가 이 verb 의 요점이다.
  verify_setup "$path" preserve

  if [ -n "$brief" ]; then
    [ -f "$brief" ] || { printf 'attach: 브리프 파일이 없다: %s\n' "$brief" >&2; return 1; }
    spec="$(cat "$brief")"
    [ -n "$spec" ] || { printf 'attach: 브리프 파일이 비었다: %s\n' "$brief" >&2; return 1; }
  else
    spec="워크트리 $slug 에서 $role 역할로 작업한다. 구체적 지시는 코디네이터가 곧 보낸다 — 그때까지 저장소를 파악하고 대기하라."
  fi

  tc_out="$("$(orca_cli)" orchestration task-create \
      --spec "$spec" --task-title "$role:$slug" --json 2>&1)"
  task_id="$(printf '%s' "$tc_out" | jq -r '.result.task.id // .result.id // empty' 2>/dev/null)"
  [ -n "$task_id" ] || {
    printf 'attach: 태스크를 만들지 못했다(task-create 실패)\n' >&2
    printf '  %s\n' "$(printf '%s' "$tc_out" | jq -r '.error.message // .' 2>/dev/null | head -3)" >&2
    return 1
  }

  # 이 터미널의 **직전** Dispatch 가 실패했을 때만 --retry-of 로 잇는다. 스킬 정본이
  # 실패 Dispatch 의 교체를 그렇게 이으라고 한다 — 없으면 이력이 끊긴다.
  #
  # **성공한 Dispatch 는 잇지 않는다.** 새 Task 는 그것의 재시도가 아니다. 상태를 보지 않고
  # 직전 것을 집으면 `completed` 까지 딸려 와, 이 verb 가 복구 경로로 서 있는 바로 그 자리
  # — 앞선 붙이기는 실패했지만 그 터미널의 이전 작업은 성공한 자리 — 에서 뜻이 뒤집힌다.
  # 관측된 실패도 그 자리였다: 구현 워커가 정상 종료(`completed`)한 터미널에 리뷰어를
  # 붙이려 하자 `worker-start` 가 `task_not_startable` 로 두 번 거절했다.
  #
  # **`last` 를 고른 뒤에 상태를 본다.** 실패한 것만 먼저 걸러 `last` 를 잡으면, 그 뒤에
  # 성공한 Dispatch 가 있어도 **옛 실패를 끌어와** 잇는다 — 교체 대상은 「직전 시도」뿐이다.
  # (배치는 물려받지 않으므로 --terminal/--worktree 는 그대로 다시 준다.)
  local prev retry_of
  prev="$("$(orca_cli)" orchestration worker-list --json 2>/dev/null \
    | jq -r --arg h "$handle" \
        '[ .result.workers[]? | select(.agentTerminalHandle? == $h) ] | last
           | select(.dispatchStatus? == "failed") | .dispatchId? // empty')"
  retry_of=""
  [ -n "$prev" ] && retry_of="$prev"

  resp="$(mktemp)"
  if [ -n "$handle" ]; then
    # --model 은 --terminal 과 함께 쓸 수 없다. 이미 도는 에이전트의 모델은 그대로다.
    if [ -n "$retry_of" ]; then
      attach_worker "$resp" \
        --task "$task_id" --terminal "$handle" --worktree "id:$wt_id" \
        --retry-of "$retry_of" \
        --timeout-ms "${ORCA_WORKER_START_TIMEOUT_MS:-180000}"
    else
      attach_worker "$resp" \
        --task "$task_id" --terminal "$handle" --worktree "id:$wt_id" \
        --timeout-ms "${ORCA_WORKER_START_TIMEOUT_MS:-180000}"
    fi
  else
    if [ "$role" = "review" ]; then
      printf 'attach: 리뷰어를 새 에이전트로 띄워 붙인다 — 리뷰어는 구현자와 다른 세션이어야 한다\n' >&2
      # **stop 은 워크트리 단위다.** 리뷰어를 띄운 뒤에 권하면 방금 띄운 리뷰어까지 문맥째
      # 끈다(리뷰어가 도는 중이면 stop 이 거부하지만 --force 면 뚫린다). 띄운 뒤에는 핸들 하나씩만 끈다.
      if [ -n "$live_handles" ]; then
        printf '  남아 있는 에이전트 터미널(%s)은 그대로 둔다\n' \
          "$(printf '%s' "$live_handles" | tr '\n' ' ' | sed 's/ *$//')" >&2
        printf '  정리는 리뷰어를 띄우기 전에만 워크트리 단위로: scripts/orca-worker.sh stop %s (--force 없이 — 「워커가 도는 중이다」로 거부되면 구현자가 아직 돈다)\n' \
          "$slug" >&2
        printf '  띄운 뒤라면 그 핸들만 끈다:\n' >&2
        printf '%s\n' "$live_handles" | sed '/^$/d' | while IFS= read -r h; do
          printf '    %s terminal close --terminal %s\n' "$(orca_cli)" "$h" >&2
        done
      fi
    else
      printf 'attach: 살아 있는 에이전트 터미널이 없다. 새로 띄워 붙인다\n' >&2
    fi
    # 모델을 넘기는 자리는 새로 띄울 때뿐이다 — 도는 에이전트에는 tiergear 를 부르지 않는다.
    select_worker_model "$role" "$model" "$model_override" "$spec" "$path"
    attach_worker "$resp" \
      --task "$task_id" --worktree "id:$wt_id" \
      --agent claude --model "$WM_MODEL" ${WM_EFFORT:+--effort "$WM_EFFORT"} \
      --timeout-ms "${ORCA_WORKER_START_TIMEOUT_MS:-180000}"
  fi
  rc=$?
  [ -n "$handle" ] || handle="$(attach_handle "$resp" "$wt_id")"
  rm -f "$resp" "$resp.err"

  if [ "$rc" -ne 0 ]; then
    printf 'attach: supervised 로 붙지 못했다\n' >&2
    [ "$rc" -eq 2 ] \
      && printf '  브리프는 전달됐다 — 다시 부르지 마라. 같은 지시가 두 번 주입된다\n' >&2
    print_unsupervised "$handle" "$slug"
    return 1
  fi

  [ -n "$handle" ] || {
    printf 'attach: 붙긴 했으나 터미널 핸들을 얻지 못했다\n' >&2; return 1; }

  "$(orca_cli)" terminal rename --terminal "$handle" --title "$role:$slug" --json >/dev/null 2>&1

  wait_rendered "$handle"
  verify_submitted "$handle" || true

  printf '워크트리: %s\n태스크: %s\n터미널: %s\n역할: %s\n' "$wt_id" "$task_id" "$handle" "$role"
  printf '\n다음: scripts/orca-worker.sh wait\n'
}

# 워크트리에 보호 표시를 붙이거나 뗀다.
# 사용: cmd_keep <슬러그> [--remove]
cmd_keep() {
  local slug="" remove=no path found=no
  while [ $# -gt 0 ]; do
    case "$1" in
      --remove) remove=yes; shift ;;
      -*) printf 'keep: 알 수 없는 인자 %s\n' "$1" >&2; return 2 ;;
      *)  slug="$1"; shift ;;
    esac
  done
  [ -n "$slug" ] || { printf 'keep: <슬러그> 가 필요하다\n' >&2; return 2; }

  local s_slug s_state s_live s_path s_branch
  while IFS="$(printf '\t')" read -r s_slug s_state s_live s_path s_branch; do
    [ "$s_slug" = "$slug" ] || continue
    path="$s_path"
    found=yes
    break
  done <<EOF
$(collect_worktrees)
EOF

  if [ "$found" != "yes" ] || [ ! -d "$path" ]; then
    printf 'keep: %s 라는 워크트리를 찾지 못했다\n' "$slug" >&2
    return 1
  fi

  if [ "$remove" = "yes" ]; then
    rm -f "$path/.orca-keep"
    printf '%s: 보호 해제. 이제 reap 대상이 된다\n' "$slug"
  else
    : > "$path/.orca-keep"
    printf '%s: 보호함. reap 이 --force 로도 지우지 않는다\n' "$slug"
  fi
}

# 받은 배치를 확인 처리한다. 빼면 Run 이 --ack 할 때까지 같은 배치를 재생하므로
# (orca orchestration check --help: "replays the same Delivery until --ack"),
# 먼저 끝난 워커의 보고가 다음 wait 에 다시 나와 아직 도는 워커를 끝난 것으로 판정한다.
# 필드 위치는 런타임 버전마다 다를 수 있어 fallback 을 둔다.
ack_delivery() {
  local out="$1" delivery
  delivery="$(printf '%s' "$out" \
    | jq -r '.result.deliveryId // .result.delivery.id // .result.batchId // empty' 2>/dev/null)"
  if [ -n "$delivery" ]; then
    "$(orca_cli)" orchestration check --ack "$delivery" --json >/dev/null 2>&1 \
      || printf '경고: Delivery %s 확인 처리 실패 — 다음 wait 에서 같은 보고가 재생될 수 있다\n' \
           "$delivery" >&2
  else
    printf '경고: 응답에서 deliveryId 를 찾지 못해 확인 처리하지 못했다.\n' >&2
    printf '  다음 wait 이 같은 배치를 다시 낼 수 있으니 메시지 내용으로 구분하라\n' >&2
  fi
}

cmd_wait() {
  local timeout=900000
  while [ $# -gt 0 ]; do
    case "$1" in
      --timeout-ms) timeout="${2:-}"; shift 2 ;;
      *) printf 'wait: 알 수 없는 인자 %s\n' "$1" >&2; return 2 ;;
    esac
  done

  # heartbeat 는 --types 로 걸러지지 않는다(런타임이 무시한다). 실측 2026-09-01:
  # --types worker_done,escalation,question 으로 불러도 heartbeat 배치가 그대로 왔다.
  # 그것을 보고 돌아가면 코디네이터가 heartbeat 마다 깨고, 정작 워커의 question 은
  # 다음 호출까지 방치된다 — 2026-09-01 seg-apply 배치에서 워커가 두 번 물은 판정이
  # 그렇게 묻혔고, 워커가 스스로 가정을 세워 진행했다.
  # 그러므로 heartbeat 만 온 배치는 확인 처리하고 **같은 호출 안에서 계속 기다린다.**
  local out count real
  while :; do
    out="$("$(orca_cli)" orchestration check --wait \
            --types worker_done,escalation,question \
            --timeout-ms "$timeout" --json 2>/dev/null)"
    count="$(printf '%s' "$out" | jq -r '.result.count // 0' 2>/dev/null || printf '0')"
    # 응답이 깨져 count 를 못 읽으면 "받은 게 없다"로 본다.
    # 빈 값을 통과시키면 아무것도 안 왔는데 완료로 보고하게 된다.
    [ -n "$count" ] || count=0

    if [ "$count" = "0" ]; then
      # 타임아웃은 체크포인트지 실패가 아니다. 긴 작업은 15~60분이 예사다.
      printf '아직 완료 신호가 없다(체크포인트). 워커는 계속 도는 중일 수 있다.\n'
      printf '다시 기다리려면 같은 명령을 반복한다.\n'
      return 3
    fi

    ack_delivery "$out"

    real="$(printf '%s' "$out" \
      | jq -r '[.result.messages[]? | select(.type!="heartbeat")] | length' 2>/dev/null)"
    [ -n "$real" ] || real=0
    [ "$real" != "0" ] && break

    printf 'heartbeat 만 왔다. 계속 기다린다\n' >&2
  done

  printf '%s' "$out" | jq -r '
    .result.messages[]? |
    select(.type != "heartbeat") |
    "[\(.type)] \(.subject // "")\n\(.body // "")\n"'

  # question 이 있으면 메인 세션이 답해야 한다.
  if printf '%s' "$out" | jq -e '.result.messages[]? | select(.type=="question")' >/dev/null 2>&1; then
    printf '\n질문이 있다. orchestration reply --id <msg_id> --body <답> 으로 답하라.\n'
  fi
  return 0
}

# 사용: cmd_sync_config [<워크트리경로>]  (기본값: 현재 디렉터리)
# spawn 을 거치지 않고 만든 워크트리에서 로컬 설정만 맞출 때 쓴다.
cmd_sync_config() {
  local path="${1:-$PWD}"
  [ -d "$path" ] || {
    printf 'sync-config: 그런 경로가 없다: %s\n' "$path" >&2
    return 1
  }
  trust_mise_config "$path"
  sync_local_config "$path"
}

main() {
  local verb="${1:-}"
  [ $# -gt 0 ] && shift
  case "$verb" in
    status) cmd_status "$@" ;;
    keep)   cmd_keep "$@" ;;
    reap)   cmd_reap "$@" ;;
    stop)   cmd_stop "$@" ;;
    spawn)  cmd_spawn "$@" ;;
    attach) cmd_attach "$@" ;;
    wait)   cmd_wait "$@" ;;
    sync-config) cmd_sync_config "$@" ;;
    *)
      printf 'usage: orca-worker.sh {spawn|attach|status|wait|reap|stop|keep|sync-config}\n' >&2
      return 2
      ;;
  esac
}

# 테스트가 함수만 불러올 때는 main 을 돌리지 않는다.
if [ -z "${ORCA_WORKER_LIB:-}" ]; then
  main "$@"
fi

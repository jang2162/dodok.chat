#!/bin/bash
# 미정리 Orca 워커·워크트리가 있을 때만 현황을 낸다.
# 없으면 아무것도 출력하지 않는다. 어떤 경우에도 턴을 막지 않는다(항상 exit 0).
#
# 컨텍스트 주입은 스키마에 명시된 hookSpecificOutput.additionalContext 로 한다
# ("Text injected back to model"). 이벤트 이름은 settings.json 이 인자로 넘긴다 —
# stdin 필드 이름에 기대지 않기 위해서다.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# 워커 세션(워크트리 안)에서는 침묵한다 — 회수는 메인 세션의 일이고, 워커에게는 자기 워크트리를 지우라는 말이 된다.
# ORCA_WORKER_REPO_ROOT 로 저장소를 따로 준 호출(테스트)은 훅 파일 자리와 무관하므로 거르지 않는다 —
# 거르면 워커가 워크트리 안에서 돌린 orca-worker.test.sh 의 훅 사례만 실패한다
# 워크트리인지는 경로가 아니라 git 으로 가른다 — 자리는 Orca 설정이 정해 `.worktrees/` 밖(기본
# `~/orca/workspaces/<저장소>/<슬러그>`)일 수 있다. 워크트리에서는 git-dir(`.git/worktrees/<이름>`)과
# git-common-dir(최상위의 `.git`)이 다르고, 최상위에서는 같다. git 이 답하지 못하면 거르지 않는다.
if [ -z "${ORCA_WORKER_REPO_ROOT:-}" ]; then
  git_dir="$(git -C "$ROOT" rev-parse --path-format=absolute --git-dir 2>/dev/null)"
  common_dir="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  if [ -n "$git_dir" ] && [ -n "$common_dir" ] && [ "$git_dir" != "$common_dir" ]; then
    exit 0
  fi
fi
SCRIPT="$ROOT/scripts/orca-worker.sh"
EVENT="${1:-UserPromptSubmit}"

[ -f "$SCRIPT" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Orca 가 없는 환경에서는 조용히 통과한다.
ORCA="${ORCA_CLI_COMMAND:-orca}"
command -v "$ORCA" >/dev/null 2>&1 || exit 0
"$ORCA" status --json >/dev/null 2>&1 || exit 0

rows="$(cd "$ROOT" && bash "$SCRIPT" status --porcelain 2>/dev/null)"
rc=$?
[ "$rc" -eq 0 ] && exit 0   # exit 0 = 미정리 없음 — 침묵
[ -n "$rows" ] || exit 0

body="$(
  printf '⚠ 정리되지 않은 Orca 워커/워크트리가 있다:\n'
  printf '%s\n' "$rows" | while IFS="$(printf '\t')" read -r token slug state live dirty; do
    # bash 3.2 는 $( ) 안의 case 패턴 닫는 괄호를 명령치환의 끝으로 오인한다.
    # POSIX 의 선행 괄호 형태로 써야 파싱된다.
    case "$token" in
      (recover) printf '  %-14s 워커 done · 터미널 %s개 살아 있음 → 회수 필요\n' "$slug" "$live" ;;
      (reap)    printf '  %-14s 병합 완료 · 클린 → 폐기 가능\n' "$slug" ;;
      (blocked) printf '  %-14s 병합됐으나 미커밋 %s개 → 처리 필요\n' "$slug" "$dirty" ;;
      (orphan)  printf '  %-14s Orca 도 git 도 모르는 잔해 디렉터리 → 제거 필요\n' "$slug" ;;
      # orphan-live 는 미정리로 세지 않아 **이 훅을 스스로 깨우지 않는다**(아래 count 참고).
      # 다만 다른 것 때문에 훅이 이미 돌 때는 함께 보여야 한다 — 분기가 없으면 그 줄만
      # 조용히 빠져서, 터미널이 붙은 잔해는 사람이 status 를 직접 칠 때만 보인다.
      (orphan-live)
        printf '  %-14s 잔해 디렉터리에 터미널 %s개 → 그 터미널을 끝내야 제거된다\n' "$slug" "$live" ;;
      # dispatched 도 미정리로 세지 않는다 — activity 는 done 이지만 dispatch 가 진행 중인 워커다
      # (사람의 답을 기다리는 브레인스토밍 워커가 그렇다). 회수 대상으로 읽히지 않게 따로 적는다.
      (dispatched)
        printf '  %-14s 워커 done 으로 보이나 dispatch 진행 중 → 회수하지 않는다(답을 기다리는 워커일 수 있다)\n' "$slug" ;;
    esac
  done
  printf '\n정리: scripts/orca-worker.sh reap <슬러그> (또는 --all-merged)\n'
  printf '이번 턴에 처리하거나, 이월할 이유를 사용자에게 말할 것.\n'
)"

# porcelain 에는 waiting·active 행도 들어오므로 미정리 토큰만 센다.
# 탭은 $'\t' 로 실제 문자를 넘긴다 — GNU grep 은 패턴 안 \t 를 탭으로 읽지 않는다(BSD 는 읽는다).
count="$(printf '%s\n' "$rows" | grep -c -E '^(recover|reap|blocked|orphan)'$'\t')"
jq -n --arg ev "$EVENT" --arg ctx "$body" --arg n "$count" \
  '{systemMessage: ("⚠ 정리되지 않은 Orca 워크트리 " + $n + "건 — scripts/orca-worker.sh status"),
    hookSpecificOutput: {hookEventName: $ev, additionalContext: $ctx}}'
exit 0

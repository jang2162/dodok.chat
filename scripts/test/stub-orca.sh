#!/bin/bash
# 테스트용 스텁 Orca CLI.
#   - 인자를 $STUB_ORCA_LOG 에 한 줄로 기록한다
#   - **실물처럼 인자를 검증한다** — 미지 서브커맨드·미지 플래그·필수 누락은 exit 1
#   - 통과하면 서브커맨드에 맞는 픽스처 JSON 을 stdout 에 낸다
#   - $STUB_ORCA_FAIL 에 서브커맨드 이름이 들어 있으면 exit 1
#
# 검증을 넣은 이유: 이것이 없어서 `task-create --title`(존재하지 않는 플래그)과
# `worker-start --prompt-file`(존재하지 않는 플래그)이 테스트를 통과했다.
# 실물은 실행 전에 거부한다:
#   $ orca orchestration worker-list --prompt-file /dev/null --json ; echo $?
#   {"id":"local","ok":false,"error":{"code":"invalid_argument",
#    "message":"Unknown flag --prompt-file for command: orchestration worker-list", ...
#   1
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -n "${STUB_ORCA_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$STUB_ORCA_LOG"
fi

# 서브커맨드는 플래그가 아닌 앞의 두 인자다.
# ("status --json" 처럼 플래그가 섞이면 매칭이 깨진다)
sub=""
for arg in "$@"; do
  case "$arg" in
    (-*) continue ;;
  esac
  if [ -z "$sub" ]; then
    sub="$arg"
  else
    sub="$sub $arg"
    break
  fi
done

# ---------------------------------------------------------------------------
# 서브커맨드별 허용 플래그. `orca agent-context --json`(schema v1, 2026-08-28)의
# .flags 를 그대로 옮긴 것이다. 새 플래그를 쓰려면 실물 스키마부터 확인해라.
# ---------------------------------------------------------------------------
allowed_flags() {
  case "$1" in
    (status)                        printf 'help json pairing-code environment' ;;
    ("worktree ps")                 printf 'help json pairing-code environment limit' ;;
    ("worktree list")               printf 'help json pairing-code environment repo limit' ;;
    ("worktree create")             printf 'help json pairing-code environment repo project host project-host-setup name agent prompt base-branch issue linear-issue comment setup parent-worktree no-parent run-hooks activate' ;;
    ("worktree rm")                 printf 'help json pairing-code environment worktree force run-hooks' ;;
    ("terminal create")             printf 'help json pairing-code environment worktree command title focus' ;;
    ("terminal list")               printf 'help json pairing-code environment worktree limit include-visual-layouts' ;;
    ("terminal read")               printf 'help json pairing-code environment terminal cursor limit screen' ;;
    ("terminal send")               printf 'help json pairing-code environment terminal text enter interrupt' ;;
    ("terminal wait")               printf 'help json pairing-code environment terminal for timeout-ms' ;;
    ("terminal rename")             printf 'help json pairing-code environment terminal title' ;;
    ("terminal close")              printf 'help json pairing-code environment terminal tab worktree all' ;;
    ("orchestration run-current")   printf 'help json pairing-code environment from full' ;;
    ("orchestration run-create")    printf 'help json pairing-code environment objective from retry-request full' ;;
    ("orchestration task-create")   printf 'help json pairing-code environment spec task-title display-name deps parent run from retry-request full' ;;
    ("orchestration worker-start")  printf 'help json pairing-code environment task on worktree name repo base-branch display-name comment setup agent model effort terminal retry-of timeout-ms run from retry-request full' ;;
    ("orchestration worker-list")   printf 'help json pairing-code environment run terminal-state include-remote cursor limit full' ;;
    ("orchestration run-list")      printf 'help json pairing-code environment limit cursor full' ;;
    ("orchestration request-show")  printf 'help json pairing-code environment request full' ;;
    ("orchestration worker-show")   printf 'help json pairing-code environment dispatch full' ;;
    ("orchestration worker-release") printf 'help json pairing-code environment dispatch retry-request full' ;;
    ("orchestration check")         printf 'help json pairing-code environment terminal run ack unread peek all types format wait timeout-ms retry-request full' ;;
    (*)                             return 1 ;;
  esac
}

# usage 문자열에서 대괄호 밖에 있는 것들. 없으면 빈 문자열.
required_flags() {
  case "$1" in
    ("orchestration task-create")   printf 'spec' ;;
    ("orchestration run-create")    printf 'objective' ;;
    ("orchestration worker-start")  printf 'task' ;;
    ("orchestration worker-release") printf 'dispatch' ;;
    ("orchestration request-show")  printf 'request' ;;
    ("orchestration worker-show")   printf 'dispatch' ;;
    ("terminal wait")               printf 'for' ;;
    ("worktree create")             printf 'name' ;;
    ("worktree rm")                 printf 'worktree' ;;
    (*)                             printf '' ;;
  esac
}

die_invalid() {
  # 실물의 --json 오류 형식을 흉내낸다. stdout 에 JSON, stderr 에 사람이 읽는 줄.
  #
  # 거부 사실을 로그에도 남긴다. 프로덕션 코드가 종료코드를 삼키는 호출
  # (terminal close, worktree rm 등)은 거부돼도 아무도 보지 못한다 —
  # 테스트가 "REJECTED 가 0건인가"를 직접 물을 수 있어야 그 자리도 지켜진다.
  if [ -n "${STUB_ORCA_LOG:-}" ]; then
    printf 'REJECTED: %s\n' "$1" >> "$STUB_ORCA_LOG"
  fi
  printf '{"id":"local","ok":false,"error":{"code":"invalid_argument","message":"%s"}}\n' "$1"
  printf '%s\n' "$1" >&2
  exit 1
}

ALLOWED="$(allowed_flags "$sub")" || die_invalid "Unknown command: $sub"

# 응답 모양. Orca 1.4.246 부터 `orchestration` 명령의 `--json` 기본 응답은 짧은 모양이고
# `--full` 이어야 옛(긴) 모양이 온다. 스텁도 그렇게 답해야 `--full` 을 빠뜨린 호출이 시험에서
# 드러난다. STUB_ORCA_FORCE_SHORT=1 이면 `--full` 이 있어도 짧은 모양을 낸다 — 짧은 모양을
# 받았을 때의 동작(파싱 폴백)을 재기 위한 것이다.
#
# 짧은 모양은 실물 표본(2026-11-02, 1.4.246)을 옮겼다. 긴 모양 중 `task-create` 와
# `worker-start` 의 영수증은 **1.4.246 의 `--full` 실물을 이 저장소에서 재지 못했다**
# (워커 터미널은 남의 Run 에 태스크를 만들 수 없다) — 그 둘은 이전 스텁의 모양 그대로다.
full=no
for arg in "$@"; do
  [ "$arg" = "--full" ] && full=yes
done
[ "${STUB_ORCA_FORCE_SHORT:-}" = "1" ] && full=no

# 미지 플래그를 거부한다.
for arg in "$@"; do
  case "$arg" in
    (--*) : ;;
    (*)   continue ;;
  esac
  name="${arg#--}"
  name="${name%%=*}"
  found=no
  for f in $ALLOWED; do
    if [ "$f" = "$name" ]; then found=yes; break; fi
  done
  [ "$found" = "yes" ] || die_invalid "Unknown flag --$name for command: $sub"
done

# 필수 플래그 누락을 거부한다.
for req in $(required_flags "$sub"); do
  found=no
  for arg in "$@"; do
    case "$arg" in
      ("--$req"|"--$req="*) found=yes; break ;;
    esac
  done
  [ "$found" = "yes" ] || die_invalid "Missing required flag --$req for command: $sub"
done

# terminal close 의 usage 는 `([--terminal <핸들>] [--tab] | --worktree <셀렉터> --all)` 이다.
# 둘 중 한 꼴이어야 한다. 워크트리 꼴은 --worktree 와 --all 이 짝이고 --terminal·--tab 과
# 섞지 못한다 — 실물은 짝이 빠지거나 섞인 꼴을 거부하므로 스텁도 거부해야 그 호출을 쓰는
# 코드가 테스트를 통과하지 못한다.
#
# 플래그가 없는 꼴(--tab 만 준 꼴 포함)의 거부는 **일부러 실물보다 엄격하다.** 실물은 그때
# cwd 워크트리의 활성 터미널, 곧 부른 쪽 자기 터미널을 닫는다. 스크립트가 낼 꼴이 아니다.
if [ "$sub" = "terminal close" ]; then
  has_t=no; has_tab=no; has_w=no; has_a=no
  for arg in "$@"; do
    case "$arg" in
      (--terminal|--terminal=*) has_t=yes ;;
      (--tab)                   has_tab=yes ;;
      (--worktree|--worktree=*) has_w=yes ;;
      (--all)                   has_a=yes ;;
    esac
  done
  if [ "$has_w" = "yes" ] || [ "$has_a" = "yes" ]; then
    [ "$has_w" = "yes" ] && [ "$has_a" = "yes" ] && [ "$has_t" = "no" ] && [ "$has_tab" = "no" ] \
      || die_invalid "terminal close --worktree and --all go together and cannot combine with --terminal or --tab for command: $sub"
  else
    [ "$has_t" = "yes" ] || die_invalid "Missing required flag (--terminal | --worktree --all) for command: $sub"
  fi
fi

# worker-start 는 --agent 와 --terminal 중 하나가 반드시 있어야 한다.
if [ "$sub" = "orchestration worker-start" ]; then
  found=no
  for arg in "$@"; do
    case "$arg" in
      (--agent|--terminal) found=yes; break ;;
    esac
  done
  [ "$found" = "yes" ] \
    || die_invalid "Missing required flag (--agent | --terminal) for command: $sub"

  # 실물: "--model supports ... opaque provider model ids; --effort requires --model.
  #        Neither can combine with --terminal."
  # 스텁이 이것을 허용하면 --terminal 에 --model 을 붙인 코드가 테스트를 통과하고
  # 실물에서만 거절된다.
  has_terminal=no; has_model=no; has_effort=no
  for arg in "$@"; do
    case "$arg" in
      (--terminal|--terminal=*) has_terminal=yes ;;
      (--model|--model=*)       has_model=yes ;;
      (--effort|--effort=*)     has_effort=yes ;;
    esac
  done
  if [ "$has_terminal" = "yes" ] && { [ "$has_model" = "yes" ] || [ "$has_effort" = "yes" ]; }; then
    die_invalid "--model/--effort cannot combine with --terminal for command: $sub"
  fi
  if [ "$has_effort" = "yes" ] && [ "$has_model" = "no" ]; then
    die_invalid "--effort requires --model for command: $sub"
  fi
fi

case "${STUB_ORCA_FAIL:-}" in
  ("") : ;;
  (*"$sub"*) exit 1 ;;
esac

# 첫 호출만 실패시킨다 — 재시도가 실제로 붙는지 재기 위한 것이다.
# STUB_ORCA_FAIL_ONCE 에 서브커맨드, STUB_ORCA_FAIL_ONCE_COUNTER 에 카운터 파일 경로.
case "${STUB_ORCA_FAIL_ONCE:-}" in
  ("") : ;;
  (*"$sub"*)
    if [ -n "${STUB_ORCA_FAIL_ONCE_COUNTER:-}" ] && [ ! -f "$STUB_ORCA_FAIL_ONCE_COUNTER" ]; then
      : > "$STUB_ORCA_FAIL_ONCE_COUNTER"
      exit 1
    fi
    ;;
esac

# 픽스처는 STUB_ORCA_PS_FIXTURE 로 덮어쓸 수 있다.
# 테스트가 경로를 치환한 사본을 넘기므로 원본은 건드리지 않는다.
PS_FIXTURE="${STUB_ORCA_PS_FIXTURE:-$HERE/fixtures/worktree-ps.json}"
LIST_FIXTURE="${STUB_ORCA_LIST_FIXTURE:-$PS_FIXTURE}"
WORKERS_FIXTURE="${STUB_ORCA_WORKERS_FIXTURE:-$HERE/fixtures/worker-list.json}"
TERMINALS_FIXTURE="${STUB_ORCA_TERMINALS_FIXTURE:-$HERE/fixtures/terminal-list.json}"

# --worktree 셀렉터 값. terminal list 의 범위 해석을 실물과 맞추는 데 쓴다.
wt_selector=""
prev=""
for arg in "$@"; do
  case "$prev" in
    (--worktree) wt_selector="$arg"; break ;;
  esac
  case "$arg" in
    (--worktree=*) wt_selector="${arg#--worktree=}"; break ;;
  esac
  prev="$arg"
done

# worker-start 에 --terminal 과 --worktree 를 함께 줬으면 그 핸들이 그 워크트리
# 것인지 검사한다. **실물이 이것을 거절하는지는 이 저장소에서 확인되지 않았다** —
# 스텁이 실물보다 엄격한 쪽이라 안전하고, 이 검사가 없으면 소속을 넘는 갈래를
# 테스트가 아예 재지 못한다(스텁이 관대하면 그 자리는 영원히 안 재진다).
# 픽스처에 그 워크트리의 터미널이 하나도 없으면 판단하지 않고 통과시킨다.
if [ "$sub" = "orchestration worker-start" ] && [ -n "$wt_selector" ]; then
  ws_handle=""
  prev=""
  for arg in "$@"; do
    case "$prev" in (--terminal) ws_handle="$arg"; break ;; esac
    case "$arg" in (--terminal=*) ws_handle="${arg#--terminal=}"; break ;; esac
    prev="$arg"
  done
  if [ -n "$ws_handle" ]; then
    ws_scope="$(jq -r --arg wt "${wt_selector#id:}" \
      '[ .result.terminals[]? | select(.worktreeId == $wt) ] | length' \
      "$TERMINALS_FIXTURE" 2>/dev/null)"
    if [ -n "$ws_scope" ] && [ "$ws_scope" != "0" ]; then
      jq -e --arg wt "${wt_selector#id:}" --arg h "$ws_handle" \
        '[ .result.terminals[]? | select(.worktreeId == $wt) | select(.handle == $h) ] | length > 0' \
        "$TERMINALS_FIXTURE" >/dev/null 2>&1 \
        || die_invalid "terminal_worktree_mismatch: $ws_handle is not in $wt_selector"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# worker-start 의 붙이기 실패를 실물 모양으로 재현한다.
#
# 실물 오류 봉투는 (orchestration task-update 를 실물에 쏴서 확인한 모양이다):
#   {"id":"<호출 상관 id>","ok":false,
#    "error":{"code":"...","message":"... Orchestration mutation request ID: <uuid>.",
#             "data":{"effectsApplied":false,"orchestrationRequestId":"<uuid>",
#                     "nextSteps":[...],"originalCommand":[...]}}}
# effectsApplied 는 **불리언**이다 — 문자열로 두면 jq 판정이 실물과 갈라진다.
#
# STUB_ORCA_WS_FAIL_MODE:
#   clean      관측 A·C — agent_unconfigured, 효과 없음. 시간이 지나면 붙는다
#   delivered  관측 B   — 실패했다는데 브리프는 이미 주입됐다(dispatch_input accepted)
#   pending    원래 호출이 아직 정리되지 않았다 → --retry-request 로만 이어받는다
#   unknown    effectsApplied 조차 없어 판정할 수 없다
#   residual   **지어낸 모양이다** — 띄우기가 시작된 뒤 실패한 봉투를 이 저장소가
#              관측한 적이 없다. 관측된 worker-start 실패(task_not_found ·
#              terminal_handle_stale · selector_not_found · agent_unconfigured)는
#              전부 「띄우기 전」의 검증 단계라 남은 자원이 없고 이 필드도 없었다.
#              키 이름과 깊이는 `worker-start --help` 의 한 문장에서만 왔다:
#              *Failed or outcome_unknown exits 1 and JSON includes stage/failedStage,
#              setup, effects, residualResources, and recovery commands when needed.*
#              그 부류는 파괴적이지 않게 재현할 수 없다 — **관측처럼 읽지 마라.**
# STUB_ORCA_WS_FAIL_TIMES: 앞의 N 번만 실패하고 그 뒤로는 붙는다(관측 A·C).
# STUB_ORCA_WS_COUNTER:    호출 횟수를 세는 파일.
# STUB_ORCA_REQUEST_STATE: request-show 가 낼 state(기본 absent).
ws_request_id="7c97cc9d-8192-46be-ac6e-6e7232dd293e"

ws_fail_envelope() {
  case "${STUB_ORCA_WS_FAIL_MODE:-clean}" in
    (delivered)
      # 실패했지만 dispatch_input 은 이미 accepted 다. effects 의 모양은
      # worker-show 실물 응답(.result.worker.effects)과 같다.
      printf '{"id":"stub-call","ok":false,"error":{"code":"agent_unconfigured","message":"Terminal term_stub is not running a recognized agent. Orchestration mutation request ID: %s.","data":{"effectsApplied":true,"orchestrationRequestId":"%s","effects":[{"kind":"worktree","action":"reused","id":"repo1::/w"},{"kind":"terminal","role":"agent","action":"reused","id":"term_stub"},{"kind":"dispatch_input","role":"agent","id":"term_stub","state":"accepted"}]}}}\n' \
        "$ws_request_id" "$ws_request_id"
      ;;
    (residual)
      # 위 주석대로 **지어낸 모양이다.** stage/failedStage 와 residualResources 를
      # `--help` 가 말한 이름 그대로 `.error.data` 아래에 둔다. 실물 위치가 여기가
      # 아니면 프로덕션은 0건을 보고 unknown 으로 떨어진다 — 그쪽도 재시도하지 않는다.
      printf '{"id":"stub-call","ok":false,"error":{"code":"outcome_unknown","message":"Worker start outcome is unknown. Orchestration mutation request ID: %s.","data":{"orchestrationRequestId":"%s","stage":"agent_launch","failedStage":"dispatch_input","residualResources":[{"kind":"terminal","role":"agent","id":"term_stub_left"},{"kind":"worktree","id":"repo1::/w"}],"nextSteps":["Using this same Orca CLI executable, run: orchestration worker-release --dispatch ctx_stub"]}}}\n' \
        "$ws_request_id" "$ws_request_id"
      ;;
    (unknown)
      printf '{"id":"stub-call","ok":false,"error":{"code":"outcome_unknown","message":"Worker start outcome is unknown. Orchestration mutation request ID: %s.","data":{"orchestrationRequestId":"%s"}}}\n' \
        "$ws_request_id" "$ws_request_id"
      ;;
    (pending)
      printf '{"id":"stub-call","ok":false,"error":{"code":"outcome_unknown","message":"Worker start outcome is unknown. Orchestration mutation request ID: %s.","data":{"effectsApplied":true,"orchestrationRequestId":"%s"}}}\n' \
        "$ws_request_id" "$ws_request_id"
      ;;
    (*)
      printf '{"id":"stub-call","ok":false,"error":{"code":"agent_unconfigured","message":"Terminal term_stub is not running a recognized agent. No effects were applied. Orchestration mutation request ID: %s.","data":{"effectsApplied":false,"orchestrationRequestId":"%s","nextSteps":["Using this same Orca CLI executable, run: skills get orchestration --full"],"originalCommand":["orca","orchestration","worker-start"]}}}\n' \
        "$ws_request_id" "$ws_request_id"
      ;;
  esac
}

if [ "$sub" = "orchestration worker-start" ] && [ -n "${STUB_ORCA_WS_FAIL_MODE:-}" ]; then
  ws_seen=0
  if [ -n "${STUB_ORCA_WS_COUNTER:-}" ]; then
    [ -f "$STUB_ORCA_WS_COUNTER" ] && ws_seen="$(grep -c '' "$STUB_ORCA_WS_COUNTER")"
    printf 'x\n' >> "$STUB_ORCA_WS_COUNTER"
  fi
  # --retry-request 로 이어받은 호출은 기록된 결과를 되돌려 준다. 실물의
  # "replays the recorded outcome instead of starting a second one" 자리다.
  ws_replay=no
  for arg in "$@"; do
    case "$arg" in (--retry-request|--retry-request=*) ws_replay=yes ;; esac
  done
  if [ "$ws_replay" = "yes" ] && [ "${STUB_ORCA_WS_REPLAY_OK:-}" = "1" ]; then
    :
  elif [ "$ws_seen" -lt "${STUB_ORCA_WS_FAIL_TIMES:-999}" ]; then
    ws_fail_envelope
    exit 1
  fi
fi

# 플래그 값을 꺼낸다(`--이름 값` 과 `--이름=값` 둘 다). 없으면 빈 문자열.
flag_value() {
  local name="$1" prev="" arg
  shift
  for arg in "$@"; do
    [ "$prev" = "--$name" ] && { printf '%s' "$arg"; return 0; }
    case "$arg" in ("--$name="*) printf '%s' "${arg#--"$name"=}"; return 0 ;; esac
    prev="$arg"
  done
}

# 커서를 시작 행으로 푼다. 스텁만 아는 꼴(`<접두>-<시작 행>`)이라, 커서를 불투명하게
# 그대로 넘기지 않는 코드는 여기서 거부된다.
cursor_offset() {
  case "$2" in
    ("")        printf '0' ;;
    ("$1"-[0-9]*) printf '%s' "${2#"$1"-}" ;;
    (*)         die_invalid "invalid --cursor for command: $sub" ;;
  esac
}

# worker-list 의 범위와 페이지를 실물 모양으로 흉내 낸다(`worker-list --help`):
#   *Without --run the list is scoped to the Run bound to the calling terminal, and to every
#    Run when there is no binding; the receipt reports which in scope.source*
#   *Returns at most 100 local rows ... Continue with the opaque page.nextCursor value unchanged.*
# 기본은 묶인 Run 이 없고 한 장에 전부다 — 실물의 `scope.source: "all"`, `hasMore: false`.
#   STUB_ORCA_BOUND_RUN          부른 터미널에 묶인 Run. 있으면 --run 없는 호출이 그 Run 만 낸다
#   STUB_ORCA_WORKERS_PAGE_SIZE  한 장의 행 수
#   STUB_ORCA_WORKERS_STUCK      끝나지 않는 페이지 — 둘째 장부터 늘 같은 커서를 다시 낸다
stub_worker_list() {
  local run source off
  run="$(flag_value run "$@")"
  if [ -n "$run" ]; then
    source=flag
  elif [ -n "${STUB_ORCA_BOUND_RUN:-}" ]; then
    source=bound; run="$STUB_ORCA_BOUND_RUN"
  else
    source=all
  fi
  off="$(cursor_offset stub-cursor "$(flag_value cursor "$@")")" || exit 1
  jq --arg source "$source" --arg run "$run" --argjson off "$off" \
     --arg size "${STUB_ORCA_WORKERS_PAGE_SIZE:-}" --arg stuck "${STUB_ORCA_WORKERS_STUCK:-}" '
    (.result.workers | if $run == "" then . else map(select(.runId == $run)) end) as $all
    | ($all | length) as $total
    | (if $size == "" then $total else ($size | tonumber) end) as $n
    | (($off + $n) < $total) as $more
    | .result.workers = $all[$off:($off + $n)]
    | .result.scope = (if $source == "all" then {source: "all"} else {source: $source, run: $run} end)
    | .result.page = {limit: $n, total: $total, hasMore: ($more or $stuck != ""),
        nextCursor: (if $stuck != "" then "stub-cursor-\($n)"
                     elif $more then "stub-cursor-\($off + $n)" else null end)}' "$WORKERS_FIXTURE" \
    | if [ "$full" = "yes" ]; then cat; else
        # 짧은 모양: 실물 표본의 키만 남긴다(workerState·dispatchStatus·agentTerminalHandle·
        # resource·projection 이 없다).
        jq '.result.workers |= map({dispatchId, taskId, state: .workerState,
              outcome: (.projection.outcome? // (if .dispatchStatus == "dispatched" then "in_progress" else .dispatchStatus end)),
              liveness: "unverifiable", terminal: .agentTerminalHandle,
              terminalState, workspace: (.resource.worktreeId? // .projection.workspace.id?),
              host: "local"})'
      fi
}

# run-list 는 픽스처 행의 runId 로 Run 목록을 만든다. 실물처럼 다음 커서는 `page` 가 아니라
# `.result.nextCursor` 에 있다. STUB_ORCA_RUNS_PAGE_SIZE 로 장을 나눈다.
stub_run_list() {
  local off
  off="$(cursor_offset stub-run-cursor "$(flag_value cursor "$@")")" || exit 1
  jq --argjson off "$off" --arg size "${STUB_ORCA_RUNS_PAGE_SIZE:-}" '
    ([.result.workers[]? | .runId // empty] | unique) as $ids
    | ($ids | length) as $total
    | (if $size == "" then $total else ($size | tonumber) end) as $n
    | {ok: true, result: {runs: ($ids[$off:($off + $n)] | map({id: .})),
        nextCursor: (if ($off + $n) < $total then "stub-run-cursor-\($off + $n)" else null end)}}' \
    "$WORKERS_FIXTURE"
}

stub_check_body() {
  # STUB_ORCA_CHECK_HEARTBEAT_ONCE 가 가리키는 파일이 아직 없으면 **첫 호출만**
  # heartbeat 배치를 낸다(그 뒤로는 평소 픽스처). 런타임이 --types 로 heartbeat 를
  # 걸러 주지 않는 실제 동작을 재현한다.
  if [ -n "${STUB_ORCA_CHECK_HEARTBEAT_ONCE:-}" ] && [ ! -f "$STUB_ORCA_CHECK_HEARTBEAT_ONCE" ]; then
    : > "$STUB_ORCA_CHECK_HEARTBEAT_ONCE"
    printf '{"ok":true,"result":{"count":1,"deliveryId":"dlv_hb","messages":[{"type":"heartbeat","subject":"alive","body":""}]}}\n'
  elif [ -n "${STUB_ORCA_CHECK_FIXTURE:-}" ]; then
    cat "$STUB_ORCA_CHECK_FIXTURE"
  else
    printf '{"ok":true,"result":{"count":0,"messages":[]}}\n'
  fi
}

case "$sub" in
  (status)           printf '{"ok":true,"result":{"runtime":{"state":"ready"}}}\n' ;;
  ("orchestration request-show")
    printf '{"ok":true,"result":{"requestId":"%s","state":"%s","interpretation":"stub"}}\n' \
      "$ws_request_id" "${STUB_ORCA_REQUEST_STATE:-absent}"
    ;;
  ("orchestration worker-start")
    # 붙은 뒤의 영수증. 핸들·Dispatch id 의 자리는 worker-show 실물 응답
    # (.result.worker.agent_terminal_handle / .result.dispatch.id)과 같은 이름을 쓴다.
    # STUB_ORCA_WS_NO_HANDLE 이면 핸들이 빠진 영수증을 낸다 — 그때 프로덕션이
    # terminal list 로 되짚는지 재기 위한 것이다.
    if [ "$full" != "yes" ]; then
      # 1.4.246 의 짧은 영수증 — 핸들이 `.result.terminal` 에 문자열로 온다.
      printf '{"ok":true,"result":{"dispatchId":"ctx_stub","taskId":"task_stub","runId":"run_stub","state":"ready","agent":"claude","model":null,"mode":"supervised","terminal":"term_stub","workspace":"repo1::/w","next":"wait"}}\n'
    elif [ -n "${STUB_ORCA_WS_NO_HANDLE:-}" ]; then
      printf '{"ok":true,"result":{"dispatch":{"id":"ctx_stub"},"worker":{"state":"ready","stage":"input_accepted"},"mutation":{"requestId":"%s","replayed":false}}}\n' "$ws_request_id"
    else
      printf '{"ok":true,"result":{"dispatch":{"id":"ctx_stub"},"worker":{"state":"ready","stage":"input_accepted","agent_terminal_handle":"term_stub","effects":[{"kind":"dispatch_input","role":"agent","id":"term_stub","state":"accepted"}]},"mutation":{"requestId":"%s","replayed":false}}}\n' "$ws_request_id"
    fi
    ;;
  ("worktree ps")    cat "$PS_FIXTURE" ;;
  ("worktree list")  cat "$LIST_FIXTURE" ;;
  ("orchestration worker-list") stub_worker_list "$@" ;;
  ("orchestration run-list")    stub_run_list "$@" ;;
  ("terminal list")
    # 실물의 --worktree 는 `id:<repoId>::<path>` 를 **정확 일치**로 해석하고,
    # 주지 않으면 머신 전역 목록을 낸다. 스텁이 실물보다 관대하면 범위를 넘긴
    # 코드가 테스트를 통과한다 — 그래서 여기서도 정확 일치로 거른다.
    if [ -n "$wt_selector" ]; then
      jq --arg wt "${wt_selector#id:}" \
        '.result.terminals |= map(select(.worktreeId == $wt))' "$TERMINALS_FIXTURE"
    else
      cat "$TERMINALS_FIXTURE"
    fi
    ;;
  ("orchestration run-current")
    # STUB_ORCA_NO_RUN 이면 바인딩이 없는 응답을 낸다(실물의 run_required 재현).
    if [ -n "${STUB_ORCA_NO_RUN:-}" ]; then
      # 짧은 모양도 바인딩이 없으면 runId 가 null 이다(실물 워커 터미널에서 확인).
      if [ "$full" = "yes" ]; then printf '{"ok":true,"result":{}}\n'
      else printf '{"ok":true,"result":{"runId":null}}\n'; fi
    elif [ "$full" = "yes" ]; then
      printf '{"ok":true,"result":{"run":{"id":"run_stub"}}}\n'
    else
      printf '{"ok":true,"result":{"runId":"run_stub","objective":"stub"}}\n'
    fi
    ;;
  ("orchestration run-create")
    if [ -n "${STUB_ORCA_NO_RUN_ID:-}" ]; then
      printf '{"ok":true,"result":{}}\n'
    elif [ "$full" = "yes" ]; then
      printf '{"ok":true,"result":{"run":{"id":"run_stub_created"}}}\n'
    else
      printf '{"ok":true,"result":{"runId":"run_stub_created"}}\n'
    fi
    ;;
  ("orchestration task-create")
    # STUB_ORCA_NO_TASK_ID 면 id 가 빠진 응답을 낸다(실물 실패 재현).
    if [ -n "${STUB_ORCA_NO_TASK_ID:-}" ]; then
      printf '{"ok":true,"result":{}}\n'
    elif [ "$full" = "yes" ]; then
      printf '{"ok":true,"result":{"task":{"id":"task_stub"}}}\n'
    else
      # 1.4.246 의 짧은 모양(조율자가 실물에서 본 것).
      printf '{"ok":true,"result":{"taskId":"task_stub","status":"ready"}}\n'
    fi
    ;;
  ("terminal create")
    # STUB_ORCA_NO_HANDLE 이면 핸들이 빠진 응답을 낸다(실측 사고 재현).
    if [ -n "${STUB_ORCA_NO_HANDLE:-}" ]; then
      printf '{"ok":true,"result":{}}\n'
    else
      printf '{"ok":true,"result":{"terminal":{"handle":"term_stub"}}}\n'
    fi
    ;;
  ("terminal read")
    if [ -n "${STUB_ORCA_READ_FIXTURE:-}" ]; then
      cat "$STUB_ORCA_READ_FIXTURE"
    else
      # 실물 `terminal read --screen --json` 을 그대로 흉내낸다. 세 가지가 다 필요하다.
      #
      #   1) 모양이 `.result.terminal.tail` — **화면 줄의 배열**이다.
      #   2) 응답이 **여러 줄로 pretty-print** 된다. 한 줄로 내면 「줄 단위」라는 성질이
      #      사라져, 응답 전체를 훑는 구현이 스위트를 통과해 버린다.
      #   3) `tail` 에 **스크롤백이 함께 들어 있다.** 실물 화면에는 워커가 읽은 브리프·문서가
      #      떠 있어 `Ctx Used` 라는 글자가 산문으로도 나타난다 — 실물에서 여섯 줄 중
      #      다섯이 산문이었다. 상태줄만 든 픽스처는 그 자리를 아예 재지 못한다.
      #
      # 상태줄의 낱말 사이는 **진짜 U+00A0 NO-BREAK SPACE(0xc2 0xa0)** 다. 보통 공백으로
      # 지으면 맞을 리 없는 패턴이 여기서 통과해 버린다 — 이 저장소는 「픽스처가 실물과
      # 달라 죽은 코드가 통과한」 사고를 이미 겪었다.
      printf '%s\n' \
        '{' \
        '  "ok": true,' \
        '  "result": {' \
        '    "terminal": {' \
        '      "handle": "term_stub",' \
        '      "status": "running",' \
        '      "tail": [' \
        '        "  - 상태줄의 Ctx Used 가 0.0% 면 미제출이다 (브리프 본문 — 스크롤백)",' \
        '        "",' \
        "$(printf '        "\xc2\xa0Ctx\xc2\xa0Used:\xc2\xa0\xe2\x96\x93\xe2\x96\x91\xe2\x96\x91\xc2\xa012.3%%\xc2\xa0\xc2\xa05m\xc2\xa0\xc2\xa0|\xc2\xa0\xc2\xa0\xe2\x8e\x87\xc2\xa0stub\xc2\xa0\xc2\xa0(+0,-0)"')" \
        '      ]' \
        '    }' \
        '  }' \
        '}'
    fi
    ;;
  ("orchestration check")
    # 짧은 모양은 `count`·`deliveryId` 가 없다(실물 표본). 결과 앞에 keepalive 줄을 붙이려면
    # STUB_ORCA_CHECK_KEEPALIVE 에 줄 수를 준다 — 실물 `check --wait` 는 15초마다
    # `{"_keepalive":true,...}` 를 내고, 두 흐름을 합쳐 받은 표본은 그 줄이 결과 앞에 있었다.
    i=0
    while [ "$i" -lt "${STUB_ORCA_CHECK_KEEPALIVE:-0}" ]; do
      i=$((i + 1))
      printf '{"_keepalive":true,"_heartbeat":true,"elapsedMs":%s,"deadlineMs":600000}\n' "$((i * 15000))"
    done
    stub_check_body | if [ "$full" = "yes" ]; then cat; else
      jq -c 'if type == "object" and (.result? | type) == "object"
             then .result |= del(.count, .deliveryId) else . end' 2>/dev/null || cat
    fi
    ;;
  (*)                printf '{"ok":true,"result":{}}\n' ;;
esac


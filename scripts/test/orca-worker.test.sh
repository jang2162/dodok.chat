#!/bin/bash
# scripts/orca-worker.sh 테스트. 의존성 없이 bash 3.2 에서 돈다.
#   실행: bash scripts/test/orca-worker.test.sh

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SUT="$HERE/../orca-worker.sh"

PASS=0
FAIL=0

assert_eq() {
  # $1 실제, $2 기대, $3 설명
  if [ "$1" = "$2" ]; then
    PASS=$((PASS + 1))
    printf '  ok   %s\n' "$3"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL %s\n       기대: [%s]\n       실제: [%s]\n' "$3" "$2" "$1"
  fi
}

assert_status() {
  # $1 기대 종료코드, $2 설명, 나머지: 실행할 명령
  local expected="$1" desc="$2"
  shift 2
  "$@" >/dev/null 2>&1
  local actual=$?
  if [ "$actual" -eq "$expected" ]; then
    PASS=$((PASS + 1))
    printf '  ok   %s\n' "$desc"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL %s\n       기대 종료코드: %s, 실제: %s\n' "$desc" "$expected" "$actual"
  fi
}

finish() {
  printf '\n%s개 통과, %s개 실패\n' "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ] || exit 1
}

# 테스트 대상 함수를 불러온다. ORCA_WORKER_LIB=1 이면 main 을 돌리지 않는다.
ORCA_WORKER_LIB=1
export ORCA_WORKER_LIB
# 스위트는 실제로 자지 않는다. 대기가 **있는지**는 아래 verify_submitted 절이
# ORCA_WORKER_SUBMIT_SLEEP 을 되돌려 직접 잰다.
ORCA_WORKER_SUBMIT_SLEEP=0
export ORCA_WORKER_SUBMIT_SLEEP

# **재시도는 스위트 기본값이 「하지 않는다」다.** 재시도가 필요한 테스트만 예산을
# 명시로 올린다. 이 기본값이 없으면 「재시도하지 않아야 할 자리가 재시도하게 되는」
# 회귀가 **붉은 테스트가 아니라 수 분짜리 매달림**으로 나타난다 — CI 타임아웃은
# 「인프라 flake」로 읽히지 회귀로 읽히지 않는다.
ORCA_WORKER_ATTACH_BUDGET_SEC=0
ORCA_WORKER_RETRY_SLEEP=0
export ORCA_WORKER_ATTACH_BUDGET_SEC ORCA_WORKER_RETRY_SLEEP
. "$SUT"

# **스위트 기본값은 「tiergear 없음」이다.** 개발자 머신에 깔린 진짜 tiergear 가
# 판단기를 부르면 모델이 머신마다 달라져 단언이 흔들린다. tiergear 가 필요한
# 테스트만 스텁(stub-tiergear.sh)을 주입한다.
TIERGEAR_COMMAND="$HERE/no-such-tiergear"
export TIERGEAR_COMMAND

echo "역할→모델 배정"
assert_eq "$(resolve_model implement)" "opus"   "implement 는 opus"
assert_eq "$(resolve_model review)"    "opus"   "review 는 opus"
assert_eq "$(resolve_model verify)"    "sonnet" "verify 는 sonnet"
assert_eq "$(resolve_model chore)"     "sonnet" "chore 는 sonnet"
assert_eq "$(resolve_model implement sonnet)" "sonnet" "--model 이 기본값을 덮어쓴다"
assert_eq "$(resolve_model chore opus)"       "opus"   "--model 이 기본값을 덮어쓴다(반대 방향)"
assert_status 1 "알 수 없는 역할은 거부한다" resolve_model deploy
assert_status 1 "허용되지 않은 모델은 거부한다" resolve_model implement haiku
assert_status 1 "모델 ID 직접 지정은 거부한다" resolve_model implement claude-opus-5

echo "워크트리 상태 판정"
# 인자: <워커상태> <살아있는터미널수> <병합여부> <미커밋수>
assert_eq "$(classify_worktree running 2 yes 0)" "waiting" "도는 워커는 미정리가 아니다"
assert_eq "$(classify_worktree running 0 no 0)"  "waiting" "터미널이 0이어도 도는 중이면 기다린다"
assert_eq "$(classify_worktree done 3 yes 0)"    "recover" "끝난 워커가 터미널을 물고 있으면 회수"
assert_eq "$(classify_worktree done 3 no 0)"     "recover" "미병합이어도 done+터미널이면 회수"
assert_eq "$(classify_worktree done 0 yes 4)"    "blocked" "병합됐어도 미커밋이 있으면 폐기하지 않는다"
assert_eq "$(classify_worktree none 0 yes 4)"    "blocked" "워커가 없어도 미커밋이 있으면 막는다"
assert_eq "$(classify_worktree done 0 yes 0)"    "reap"    "끝나고 터미널 없고 병합·클린이면 폐기"
assert_eq "$(classify_worktree none 0 yes 0)"    "reap"    "워커 기록이 없어도 병합·클린이면 폐기"
assert_eq "$(classify_worktree none 0 no 0)"     "active"  "미병합은 아직 작업 중이다"
assert_eq "$(classify_worktree none 0 no 7)"     "active"  "미병합 + 미커밋은 그냥 작업 중이다"

echo "미정리 판정"
assert_eq "$(is_unsettled recover)" "yes" "recover 는 미정리"
assert_eq "$(is_unsettled blocked)" "yes" "blocked 는 미정리"
assert_eq "$(is_unsettled reap)"    "yes" "reap 는 미정리"
assert_eq "$(is_unsettled waiting)" "no"  "waiting 은 미정리가 아니다"
assert_eq "$(is_unsettled active)"  "no"  "active 는 미정리가 아니다"

echo "현황 조회"
TMPREPO="$(mktemp -d)"
sed "s#REPO#$TMPREPO#g" "$HERE/fixtures/worktree-ps.json" > "$TMPREPO/ps.json"

ORCA_CLI_COMMAND="$HERE/stub-orca.sh"
STUB_ORCA_PS_FIXTURE="$TMPREPO/ps.json"
ORCA_WORKER_REPO_ID=repo1
ORCA_WORKER_REPO_ROOT="$TMPREPO"
export ORCA_CLI_COMMAND STUB_ORCA_PS_FIXTURE ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

rows="$(collect_worktrees)"
assert_eq "$(printf '%s\n' "$rows" | wc -l | tr -d ' ')" "3" "이 저장소의 비-최상위 워크트리 3개만 나온다"
assert_eq "$(printf '%s\n' "$rows" | cut -f1 | tr '\n' ',')" "w-recover,w-reap,w-dirty," "슬러그가 순서대로 나온다"
assert_eq "$(printf '%s\n' "$rows" | awk -F'\t' '$1=="w-recover"{print $2"/"$3}')" "done/3" "워커 상태와 터미널 수를 읽는다"
assert_eq "$(printf '%s\n' "$rows" | awk -F'\t' '$1=="w-reap"{print $2"/"$3}')" "none/0" "워커가 없으면 none/0"
assert_eq "$(printf '%s\n' "$rows" | grep -c other-project)" "0" "다른 저장소 워크트리는 제외한다"
# F9: 위 단언만으로는 repoId 필터를 지워도 통과한다 — 픽스처의 타 저장소 항목이
# isMainWorktree:true 라 다음 필터에 먼저 걸리기 때문이다. 타 저장소의
# **비-메인** 워크트리로 repoId 필터 자체를 검증한다.
assert_eq "$(printf '%s\n' "$rows" | cut -f1 | grep -c -x 'other-wt')" "0" \
  "다른 저장소의 비-최상위 워크트리도 제외한다(repoId 필터)"
rm -rf "$TMPREPO"

echo "status 통합"
T="$(mktemp -d)"
git -C "$T" init -q -b main
printf 'base\n' > "$T/f.txt"
git -C "$T" add f.txt
git -C "$T" -c user.email=t@t -c user.name=t commit -qm base

# 병합된 브랜치 두 개(하나는 나중에 더럽힌다)와 미병합 브랜치 하나
git -C "$T" branch w-reap
git -C "$T" branch w-dirty
git -C "$T" branch w-recover
git -C "$T" checkout -q -b ahead
printf 'ahead\n' >> "$T/f.txt"
git -C "$T" -c user.email=t@t -c user.name=t commit -qam ahead
git -C "$T" checkout -q main

assert_eq "$(git_merged w-reap main "$T")" "yes" "같은 커밋의 브랜치는 병합됨"
assert_eq "$(git_merged ahead main "$T")"  "no"  "앞선 커밋이 있으면 미병합"

mkdir -p "$T/wt"
printf 'x\n' > "$T/wt/untracked.txt"
assert_eq "$(git_dirty_count "$T")" "1" "추적되지 않는 파일도 미커밋으로 센다"
rm -f "$T/wt/untracked.txt"
assert_eq "$(git_dirty_count "$T")" "0" "클린 워크트리는 0"
assert_eq "$(git_dirty_count /does/not/exist)" "0" "없는 경로는 0"

rm -rf "$T"

# 훅이 전적으로 의존하는 계약이므로 종료코드를 직접 검증한다.
echo "status 종료코드"
SC="$(mktemp -d)"
sed "s#REPO#$SC#g" "$HERE/fixtures/worktree-ps.json" > "$SC/ps.json"
git -C "$SC" init -q -b main
printf 'x\n' > "$SC/f.txt"; git -C "$SC" add f.txt
git -C "$SC" -c user.email=t@t -c user.name=t commit -qm base
git -C "$SC" branch w-recover; git -C "$SC" branch w-reap; git -C "$SC" branch w-dirty

ORCA_CLI_COMMAND="$HERE/stub-orca.sh"
STUB_ORCA_PS_FIXTURE="$SC/ps.json"
ORCA_WORKER_REPO_ID=repo1
ORCA_WORKER_REPO_ROOT="$SC"
export ORCA_CLI_COMMAND STUB_ORCA_PS_FIXTURE ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

assert_status 1 "미정리가 있으면 exit 1" cmd_status --base main
# sort -u 는 사전순이므로 reap 이 recover 보다 먼저 온다.
assert_eq "$(cmd_status --porcelain --base main | cut -f1 | sort -u | tr '\n' ',')" \
  "reap,recover," "porcelain 첫 칸이 판정 토큰이다"
assert_eq "$(cmd_status --porcelain --base main | wc -l | tr -d ' ')" "3" \
  "porcelain 은 워크트리당 한 줄"

# 픽스처의 워크트리 경로가 실재하지 않으면 미커밋 0으로 잡히므로,
# 미정리가 없는 상태는 빈 픽스처로 만든다.
printf '{"ok":true,"result":{"worktrees":[]}}\n' > "$SC/ps.json"
assert_status 0 "미정리가 없으면 exit 0" cmd_status --base main
assert_eq "$(cmd_status --porcelain --base main | grep -c '')" "0" "없으면 아무것도 출력하지 않는다"
rm -rf "$SC"
unset STUB_ORCA_PS_FIXTURE ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

# 2026-08-28 실물 측정: 도는 워커의 agents[].state 는 running 이 아니라 working 이었다.
# 상태 목록이 문서화돼 있지 않으므로 done/none 만 "끝난 것"으로 보고 나머지는 전부 도는 것으로 친다.
echo "워커 생존 판정(실측 반영)"
assert_eq "$(is_worker_live working)"  "yes" "working 은 도는 워커다(2026-08-28 실측)"
assert_eq "$(is_worker_live running)"  "yes" "running 도 도는 워커다"
assert_eq "$(is_worker_live starting)" "yes" "모르는 상태는 도는 것으로 본다"
assert_eq "$(is_worker_live done)"     "no"  "done 은 끝났다"
assert_eq "$(is_worker_live none)"     "no"  "none 은 워커 기록이 없다"
assert_eq "$(is_worker_live '')"       "no"  "빈 상태도 워커 없음으로 본다"

assert_eq "$(classify_worktree working 2 yes 0)" "waiting" "working 워크트리는 미정리가 아니다"
assert_eq "$(classify_worktree working 0 yes 0)" "waiting" "터미널이 0이어도 working 이면 기다린다"

echo "reap 안전 게이트"
G="$(mktemp -d)"
git -C "$G" init -q -b main
printf 'base\n' > "$G/f.txt"
git -C "$G" add f.txt
git -C "$G" -c user.email=t@t -c user.name=t commit -qm base
git -C "$G" branch merged-clean
git -C "$G" checkout -q -b unmerged
printf 'more\n' >> "$G/f.txt"
git -C "$G" -c user.email=t@t -c user.name=t commit -qam more
git -C "$G" checkout -q main

assert_status 0 "병합+클린은 통과한다" reap_gate w merged-clean "$G" main no
assert_status 1 "미병합은 거부한다"     reap_gate w unmerged     "$G" main no
assert_status 0 "--force 는 미병합도 통과시킨다" reap_gate w unmerged "$G" main yes

printf 'dirty\n' > "$G/newfile.txt"
assert_status 1 "미커밋이 있으면 거부한다" reap_gate w merged-clean "$G" main no
assert_status 0 "--force 는 미커밋도 통과시킨다" reap_gate w merged-clean "$G" main yes
assert_eq "$(reap_gate w merged-clean "$G" main yes 2>&1 >/dev/null | grep -c newfile.txt)" "1" \
  "--force 는 버려지는 파일을 출력한다"
rm -rf "$G"

echo "reap 실행 순서"
# 계획의 원안은 픽스처 경로를 임시 저장소로 치환하지 않아 collect_worktrees 가
# 한 행도 내지 않았다(repo_id 가 빈 문자열이 되어 select 가 전부 탈락).
# 게이트가 <워크트리경로>에서 git 을 부르므로 실제 워크트리를 만들어 쓴다.
export STUB_ORCA_LOG="$(mktemp)"
R="$(mktemp -d)"
git -C "$R" init -q -b main
printf 'x\n' > "$R/f.txt"; git -C "$R" add f.txt
git -C "$R" -c user.email=t@t -c user.name=t commit -qm base
git -C "$R" worktree add -q "$R/.worktrees/lms-base/w-reap"    -b w-reap
git -C "$R" worktree add -q "$R/.worktrees/lms-base/w-recover" -b w-recover
git -C "$R" worktree add -q "$R/.worktrees/lms-base/w-dirty"   -b w-dirty
git -C "$R" worktree add -q "$R/.worktrees/lms-base/w-live"    -b w-live
# 게이트에 걸려야 하는 둘은 미커밋을 남긴다
printf 'wip\n' > "$R/.worktrees/lms-base/w-recover/wip.txt"
printf 'wip\n' > "$R/.worktrees/lms-base/w-dirty/wip.txt"

# w-live 는 워커가 도는 중(state=working)인 워크트리다. 픽스처에 덧붙인다.
sed "s#REPO#$R#g" "$HERE/fixtures/worktree-ps.json" \
  | jq --arg p "$R/.worktrees/lms-base/w-live" '
      .result.worktrees += [{
        "worktreeId": ("repo1::" + $p), "repoId": "repo1", "path": $p,
        "branch": "refs/heads/w-live", "isMainWorktree": false,
        "displayName": "w-live", "liveTerminalCount": 1,
        "agents": [{"state": "working"}]
      }]' > "$R/ps.json"
sed "s#REPO#$R#g" "$HERE/fixtures/worker-list.json" > "$R/workers.json"

STUB_ORCA_PS_FIXTURE="$R/ps.json"
STUB_ORCA_WORKERS_FIXTURE="$R/workers.json"
ORCA_WORKER_REPO_ID=repo1
ORCA_WORKER_REPO_ROOT="$R"
export STUB_ORCA_PS_FIXTURE STUB_ORCA_WORKERS_FIXTURE ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

# dry-run 은 아무 Orca 명령도 부르지 않아야 한다.
cmd_reap w-reap --base main --dry-run >/dev/null 2>&1
assert_eq "$(grep -c -E 'worker-release|terminal stop|worktree rm' "$STUB_ORCA_LOG")" "0" \
  "dry-run 은 어떤 파괴 명령도 실행하지 않는다"

# 실제 실행은 회수→정지→폐기 순서여야 한다. Orca 호출은 스텁이 받는다.
: > "$STUB_ORCA_LOG"
cmd_reap w-reap --base main >/dev/null 2>&1
order="$(grep -o -E 'worker-release|terminal stop|worktree rm' "$STUB_ORCA_LOG" | tr '\n' ',')"
assert_eq "$order" "worker-release,terminal stop,worktree rm," "회수→터미널정지→폐기 순서"

# 게이트에 걸리면 실행 명령이 하나도 나가지 않아야 한다.
: > "$STUB_ORCA_LOG"
cmd_reap w-recover --base main >/dev/null 2>&1
assert_eq "$(grep -c 'worktree rm' "$STUB_ORCA_LOG")" "0" \
  "게이트에 걸린 워크트리에는 삭제 명령이 나가지 않는다"

# 도는 워커(state=working)는 --all-merged 가 건드리지 않는다.
: > "$STUB_ORCA_LOG"
cmd_reap --all-merged --base main >/dev/null 2>&1
assert_eq "$(grep 'worktree rm' "$STUB_ORCA_LOG" | grep -c 'w-live')" "0" \
  "도는 워커의 워크트리는 --all-merged 가 건너뛴다"
assert_eq "$(grep 'worktree rm' "$STUB_ORCA_LOG" | grep -c 'w-reap')" "1" \
  "병합·클린 워크트리만 폐기된다"

# 자기 발밑 보호: 그 워크트리 안에서 돌면 건너뛴다.
: > "$STUB_ORCA_LOG"
( cd "$R/.worktrees/lms-base/w-reap" && cmd_reap --all-merged --base main ) >/dev/null 2>&1
assert_eq "$(grep -c 'worktree rm' "$STUB_ORCA_LOG")" "0" \
  "자기가 서 있는 워크트리는 지우지 않는다"

rm -f "$STUB_ORCA_LOG"; rm -rf "$R"
unset STUB_ORCA_LOG STUB_ORCA_PS_FIXTURE STUB_ORCA_WORKERS_FIXTURE ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

echo "spawn 워크트리 생성"
export STUB_ORCA_LOG="$(mktemp)"
S="$(mktemp -d)"
git -C "$S" init -q -b main
printf 'x\n' > "$S/f.txt"; git -C "$S" add f.txt
git -C "$S" -c user.email=t@t -c user.name=t commit -qm base
ORCA_WORKER_REPO_ROOT="$S"; export ORCA_WORKER_REPO_ROOT

create_worktree probe main >/dev/null 2>&1
line="$(grep 'worktree create' "$STUB_ORCA_LOG" | head -1)"
assert_eq "$(printf '%s' "$line" | grep -c -- '--base-branch main')" "1" \
  "--base-branch 를 항상 넘긴다"
assert_eq "$(printf '%s' "$line" | grep -c -- '--setup run')" "1" \
  "--setup run 을 넘긴다"
assert_eq "$(printf '%s' "$line" | grep -c -- '--name probe')" "1" \
  "슬러그를 이름으로 넘긴다"
rm -f "$STUB_ORCA_LOG"; rm -rf "$S"
unset STUB_ORCA_LOG

echo "spawn 워커 기동"
export STUB_ORCA_LOG="$(mktemp)"
P="$(mktemp -d)"
git -C "$P" init -q -b main
printf 'x\n' > "$P/f.txt"; git -C "$P" add f.txt
git -C "$P" -c user.email=t@t -c user.name=t commit -qm base
ORCA_WORKER_REPO_ROOT="$P"; export ORCA_WORKER_REPO_ROOT

# create_worktree 는 생성 응답이 아니라 경로로 id 를 되찾는다.
# 그래서 worktree list 픽스처가 그 경로를 갖고 있어야 spawn 이 이어진다.
# 그리고 verify_base 가 그 경로에서 git 을 부르므로 **실물 워크트리**여야 한다.
PB="$(basename "$P")"
git -C "$P" worktree add -q "$P/.worktrees/$PB/probe"  -b probe
git -C "$P" worktree add -q "$P/.worktrees/$PB/probe2" -b probe2
jq -n --arg a "$P/.worktrees/$PB/probe" --arg b "$P/.worktrees/$PB/probe2" \
  '{ok:true,result:[{id:("repo1::"+$a),path:$a},{id:("repo1::"+$b),path:$b}]}' \
  > "$P/list.json"
STUB_ORCA_LIST_FIXTURE="$P/list.json"; export STUB_ORCA_LIST_FIXTURE

assert_status 0 "정상 경로는 exit 0 으로 끝난다" cmd_spawn probe chore --base main
: > "$STUB_ORCA_LOG"
cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--agent claude --model sonnet')" "1" \
  "chore 는 sonnet 으로 에이전트를 띄운다"
# 붙이기가 실패하던 창은 「터미널을 만들어 놓고 아직 붙일 수 없는」 구간이었다.
# worker-start 가 에이전트를 직접 띄우면 그 구간 자체가 없다.
assert_eq "$(grep -c 'terminal create' "$STUB_ORCA_LOG")" "0" \
  "spawn 은 터미널을 직접 만들지 않는다(붙이기 창을 없앤다)"
# tui-idle 통과는 「붙일 수 있다」를 뜻하지 않는다 — 실측에서 tui-idle 을 통과한
# 뒤에도 agent_unconfigured 로 거절당했다. 그래서 **붙이기 앞에는** 쓰지 않는다.
# 붙인 뒤의 tui-idle 은 「그려졌다」만 뜻하므로 렌더 대기로는 쓴다(H1).
assert_eq "$(awk '/orchestration worker-start/{ws=NR} /terminal wait/{if(!ws) bad=1} END{print bad+0}' "$STUB_ORCA_LOG")" "0" \
  "붙이기 *전에는* tui-idle 을 기다리지 않는다"
assert_eq "$(grep -c 'terminal wait' "$STUB_ORCA_LOG")" "1" \
  "붙인 뒤에는 렌더 대기로 tui-idle 을 쓴다(verify_submitted 가 상태줄을 보게)"
# 등록 지연이 60초를 넘는 것이 관측됐다. 기다리는 일을 게이트를 아는 쪽에 맡긴다.
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--timeout-ms 180000')" "1" \
  "worker-start 에 넉넉한 --timeout-ms 를 준다"
assert_eq "$(grep -c 'terminal rename' "$STUB_ORCA_LOG")" "1" \
  "붙인 뒤 터미널 제목을 역할:슬러그로 되돌린다"
assert_eq "$(grep -c 'worker-start' "$STUB_ORCA_LOG")" "1" \
  "worker-start 로 붙여 supervised 로 만든다"
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--worktree')" "1" \
  "worker-start 에 --worktree 를 함께 준다"
# 스텁은 실물처럼 인자를 검증한다. 종료코드를 삼키는 호출까지 포함해
# **한 건도 거부되지 않았는지** 직접 묻는다 — 이것이 없으면 아무 단언도
# 이름을 대지 않는 자리의 틀린 플래그가 계속 통과한다.
assert_eq "$(grep -c '^REJECTED' "$STUB_ORCA_LOG")" "0" \
  "spawn 의 모든 Orca 호출이 실물 인자 검증을 통과한다"

# F1 — task-create 의 실제 인터페이스는 --spec(필수) + --task-title 이다.
# --title 이라는 플래그는 존재하지 않는다. 스텁이 실물처럼 거부하므로,
# 틀린 플래그로 돌아가면 아래 두 단언이 무너진다.
assert_eq "$(grep 'task-create' "$STUB_ORCA_LOG" | grep -c -- '--spec')" "1" \
  "task-create 는 --spec 으로 부른다"
assert_eq "$(grep 'task-create' "$STUB_ORCA_LOG" | grep -c -- '--task-title chore:probe')" "1" \
  "task-create 는 --task-title 로 제목을 준다"
# (terminal create 는 --title 이 정당한 플래그다. task-create 줄로 한정한다)
assert_eq "$(grep 'task-create' "$STUB_ORCA_LOG" | grep -c -- '--title ')" "0" \
  "task-create 에 존재하지 않는 --title 플래그를 쓰지 않는다"

# F2 — worker-start 에 --prompt-file 은 없다. 브리프는 --spec 으로 간다.
BRIEF="$P/brief.md"
printf '이 브리프 본문이 spec 으로 가야 한다\n' > "$BRIEF"
: > "$STUB_ORCA_LOG"
assert_status 0 "--brief 를 줘도 성공한다" cmd_spawn probe chore --base main --brief "$BRIEF"
assert_eq "$(grep -c -- '--prompt-file' "$STUB_ORCA_LOG")" "0" \
  "worker-start 에 존재하지 않는 --prompt-file 을 주지 않는다"
assert_eq "$(grep 'task-create' "$STUB_ORCA_LOG" | grep -c '이 브리프 본문이 spec 으로 가야 한다')" "1" \
  "브리프 본문이 task-create --spec 으로 전달된다"
assert_status 1 "없는 브리프 파일은 거부한다" cmd_spawn probe chore --base main --brief "$P/없다.md"

# F1 — task_id 빈 값 가드. 없으면 연쇄 실패가 exit 0 성공 요약으로 끝난다.
: > "$STUB_ORCA_LOG"
assert_status 1 "task_id 를 얻지 못하면 실패로 끝낸다" \
  env STUB_ORCA_NO_TASK_ID=1 bash -c '. "$0"; cmd_spawn probe chore --base main' "$SUT"
STUB_ORCA_NO_TASK_ID=1 cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep -c 'terminal create' "$STUB_ORCA_LOG")" "0" \
  "task_id 가 없으면 터미널을 만들지 않는다"

# Run 바인딩. task-create 는 Run 이 바인딩돼 있지 않으면 run_required 로 죽는다.
# 이전 세션의 Run 은 그 세션 코디네이터 터미널에 묶여 있어 재사용되지 않으므로
# spawn 이 세션마다 확인해야 한다. 2026-09-01 에 이 단계가 없어 spawn 이 세 번
# 연속 실패했고, 실패 지점이 워크트리 생성 *뒤* 라 잔해가 남았다.
: > "$STUB_ORCA_LOG"
cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep -c 'orchestration run-current' "$STUB_ORCA_LOG")" "1" \
  "spawn 은 Run 바인딩을 먼저 확인한다"
assert_eq "$(grep -c 'orchestration run-create' "$STUB_ORCA_LOG")" "0" \
  "이미 바인딩돼 있으면 Run 을 새로 만들지 않는다"

: > "$STUB_ORCA_LOG"
STUB_ORCA_NO_RUN=1 cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep -c 'orchestration run-create' "$STUB_ORCA_LOG")" "1" \
  "바인딩이 없으면 Run 을 만든다"

# Run 생성이 실패하면 워크트리를 만들기 전에 멈춘다 — 잔해를 남기지 않는 것이 요점이다.
: > "$STUB_ORCA_LOG"
assert_status 1 "Run 을 만들지 못하면 spawn 이 실패로 끝난다" \
  env STUB_ORCA_NO_RUN=1 STUB_ORCA_NO_RUN_ID=1 \
  bash -c '. "$0"; cmd_spawn probe chore --base main' "$SUT"
STUB_ORCA_NO_RUN=1 STUB_ORCA_NO_RUN_ID=1 cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep -c 'worktree create' "$STUB_ORCA_LOG")" "0" \
  "Run 을 만들지 못하면 워크트리를 만들지 않는다"
assert_eq "$(grep -c 'terminal create' "$STUB_ORCA_LOG")" "0" \
  "Run 을 만들지 못하면 터미널도 만들지 않는다"

echo "붙이기 — 「이미 먹혔는가」 판정"
# 갈리는 변수는 재시도 횟수가 아니라 경과 시간이다. 실측 세 번 모두 5초×3회
# (총 15초)로는 못 붙었고, 1분 뒤 같은 인자가 1회에 붙었다.
# 그래서 재시도는 「효과가 적용되지 않았음이 응답에 적혀 있을 때」만 하고,
# 예산은 횟수가 아니라 초로 잡는다.
ORCA_WORKER_RETRY_SLEEP=0
export ORCA_WORKER_RETRY_SLEEP

# clean — effectsApplied:false. 새로 부르는 것이 안전하다(관측 A·C).
: > "$STUB_ORCA_LOG"
WSC="$(mktemp)"; rm -f "$WSC"
STUB_ORCA_WS_FAIL_MODE=clean STUB_ORCA_WS_FAIL_TIMES=2 STUB_ORCA_WS_COUNTER="$WSC" \
  ORCA_WORKER_ATTACH_BUDGET_SEC=300 ORCA_WORKER_RETRY_SLEEP=0 \
  cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep -c 'orchestration worker-start' "$STUB_ORCA_LOG")" "3" \
  "효과가 적용되지 않았으면 시간을 더 주고 다시 부른다(N번째에 붙는다)"
assert_status 0 "N번째에 붙으면 spawn 은 성공으로 끝난다" \
  env STUB_ORCA_WS_FAIL_MODE=clean STUB_ORCA_WS_FAIL_TIMES=2 STUB_ORCA_WS_COUNTER="$(mktemp -u)" \
      ORCA_WORKER_ATTACH_BUDGET_SEC=300 ORCA_WORKER_RETRY_SLEEP=0 \
  bash -c '. "$0"; cmd_spawn probe chore --base main' "$SUT"
rm -f "$WSC"

# 예산은 초다. 0초면 첫 실패에서 멈춘다 — 무한히 부르지 않는다.
: > "$STUB_ORCA_LOG"
STUB_ORCA_WS_FAIL_MODE=clean ORCA_WORKER_ATTACH_BUDGET_SEC=0 ORCA_WORKER_RETRY_SLEEP=0 \
  cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep -c 'orchestration worker-start' "$STUB_ORCA_LOG")" "1" \
  "예산(초)이 다하면 더 부르지 않는다"
assert_status 1 "붙지 못하면 spawn 이 실패로 끝난다" \
  env STUB_ORCA_WS_FAIL_MODE=clean ORCA_WORKER_ATTACH_BUDGET_SEC=0 ORCA_WORKER_RETRY_SLEEP=0 \
  bash -c '. "$0"; cmd_spawn probe chore --base main' "$SUT"

# delivered — 관측 B. worker-start 는 실패했다는데 dispatch_input 은 accepted 다.
# 여기서 다시 부르면 같은 브리프가 두 번 주입된다.
: > "$STUB_ORCA_LOG"
STUB_ORCA_WS_FAIL_MODE=delivered \
  ORCA_WORKER_ATTACH_BUDGET_SEC=300 ORCA_WORKER_ATTACH_MAX_TRIES=3 ORCA_WORKER_RETRY_SLEEP=0 \
  cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep -c 'orchestration worker-start' "$STUB_ORCA_LOG")" "1" \
  "브리프가 이미 전달됐으면 worker-start 를 다시 부르지 않는다(재시도가 열려 있어도)"
out="$(STUB_ORCA_WS_FAIL_MODE=delivered ORCA_WORKER_ATTACH_BUDGET_SEC=0 ORCA_WORKER_RETRY_SLEEP=0 \
       cmd_spawn probe chore --base main 2>&1 >/dev/null)"
assert_eq "$(printf '%s' "$out" | grep -c '다시 붙이면 같은 지시가 두 번 주입된다')" "1" \
  "중복 주입 위험을 조율자에게 말한다"
assert_eq "$(printf '%s' "$out" | grep -c 'attach 를 부르지 마라')" "1" \
  "그 경우 attach 를 부르지 말라고 말한다"

# pending — 원래 호출이 아직 정리되지 않았다. 새 작업을 시작하면 안 되고,
# 같은 requestId 를 --retry-request 로 되돌려 주는 것만 안전하다.
: > "$STUB_ORCA_LOG"
STUB_ORCA_WS_FAIL_MODE=pending STUB_ORCA_REQUEST_STATE=pending \
  STUB_ORCA_WS_REPLAY_OK=1 ORCA_WORKER_ATTACH_BUDGET_SEC=0 ORCA_WORKER_RETRY_SLEEP=0 \
  cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep 'orchestration worker-start' "$STUB_ORCA_LOG" | grep -c -- '--retry-request')" "1" \
  "pending 이면 같은 requestId 로 이어받는다(두 번째 작업을 시작하지 않는다)"
assert_status 0 "이어받기가 성공하면 spawn 도 성공한다" \
  env STUB_ORCA_WS_FAIL_MODE=pending STUB_ORCA_REQUEST_STATE=pending \
      STUB_ORCA_WS_REPLAY_OK=1 ORCA_WORKER_ATTACH_BUDGET_SEC=0 ORCA_WORKER_RETRY_SLEEP=0 \
  bash -c '. "$0"; cmd_spawn probe chore --base main' "$SUT"

# request-show 가 completed 면 그 mutation 은 **이미 끝났다**. 같은 requestId 로
# 부르면 Orca 가 두 번째를 시작하는 대신 기록된 결과를 재생하므로, 중복 주입
# 없이 진실(성공 여부·핸들)을 되받을 수 있다. 포기하고 「붙지 못했다」로 끝내면
# 사실은 supervised 인 워커를 두고 조율자가 터미널을 손으로 읽으러 간다.
: > "$STUB_ORCA_LOG"
STUB_ORCA_WS_FAIL_MODE=pending STUB_ORCA_REQUEST_STATE=completed \
  STUB_ORCA_WS_REPLAY_OK=1 ORCA_WORKER_ATTACH_BUDGET_SEC=0 ORCA_WORKER_RETRY_SLEEP=0 \
  cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep 'orchestration worker-start' "$STUB_ORCA_LOG" | grep -c -- '--retry-request')" "1" \
  "completed 면 같은 requestId 로 되돌려 결과를 받는다"
assert_eq "$(grep 'orchestration worker-start' "$STUB_ORCA_LOG" | grep -vc -- '--retry-request')" "1" \
  "새 작업을 시작하지 않는다(재생 호출 하나뿐)"
assert_eq "$(grep -c 'orchestration request-show' "$STUB_ORCA_LOG")" "1" \
  "재시도 전에 request-show 로 「이미 먹혔는가」를 묻는다"
assert_status 0 "재생이 성공이면 spawn 도 성공으로 끝난다(붙었다고 알린다)" \
  env STUB_ORCA_WS_FAIL_MODE=pending STUB_ORCA_REQUEST_STATE=completed \
      STUB_ORCA_WS_REPLAY_OK=1 ORCA_WORKER_ATTACH_BUDGET_SEC=0 ORCA_WORKER_RETRY_SLEEP=0 \
  bash -c '. "$0"; cmd_spawn probe chore --base main' "$SUT"

# unknown — 판정할 수 없다. absent 는 「아무 일도 없었다」의 증거가 아니다.
: > "$STUB_ORCA_LOG"
STUB_ORCA_WS_FAIL_MODE=unknown STUB_ORCA_REQUEST_STATE=absent \
  ORCA_WORKER_ATTACH_BUDGET_SEC=300 ORCA_WORKER_ATTACH_MAX_TRIES=3 ORCA_WORKER_RETRY_SLEEP=0 \
  cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep -c 'orchestration worker-start' "$STUB_ORCA_LOG")" "1" \
  "판정할 수 없으면 조용히 재시도하지 않는다(재시도가 열려 있어도)"
out="$(STUB_ORCA_WS_FAIL_MODE=unknown STUB_ORCA_REQUEST_STATE=absent ORCA_WORKER_ATTACH_BUDGET_SEC=0 ORCA_WORKER_RETRY_SLEEP=0 \
       cmd_spawn probe chore --base main 2>&1 >/dev/null)"
assert_eq "$(printf '%s' "$out" | grep -c '확인할 수 없다')" "1" \
  "확인할 수 없다는 사실을 출력한다"
assert_eq "$(printf '%s' "$out" | grep -c 'request-show --request')" "1" \
  "직접 확인할 명령을 함께 낸다"

# ---------------------------------------------------------------------------
# residual — 남은 자원이 있으면 **어떤 재시도도 하지 않는다**
#
# 스킬 정본이 실패 시 stage·effects·residualResources 를 보라며
# *instead of guessing or automatically retrying* 라고 못박는다.
# **이 봉투 모양은 이 저장소에서 관측된 적이 없다** — 관측된 worker-start 실패는
# 전부 「띄우기 전」의 검증 단계라 남은 자원이 없었다. 그래서 스텁의 residual
# 봉투는 `worker-start --help` 문장에서 지어낸 모양이고, 스텁 주석이 그렇다고 말한다.
# 여기서 재는 것은 「그 모양이 오면 무엇을 하는가」다.
# ---------------------------------------------------------------------------
: > "$STUB_ORCA_LOG"
STUB_ORCA_WS_FAIL_MODE=residual STUB_ORCA_REQUEST_STATE=absent \
  ORCA_WORKER_ATTACH_BUDGET_SEC=300 ORCA_WORKER_ATTACH_MAX_TRIES=5 ORCA_WORKER_RETRY_SLEEP=0 \
  cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep -c 'orchestration worker-start' "$STUB_ORCA_LOG")" "1" \
  "남은 자원이 있으면 재시도가 열려 있어도 다시 부르지 않는다"
assert_eq "$(grep -c 'orchestration request-show' "$STUB_ORCA_LOG")" "0" \
  "남은 자원이 있으면 이어받기(request-show)로도 가지 않는다"

out="$(STUB_ORCA_WS_FAIL_MODE=residual STUB_ORCA_REQUEST_STATE=absent ORCA_WORKER_ATTACH_BUDGET_SEC=300 \
       ORCA_WORKER_ATTACH_MAX_TRIES=5 ORCA_WORKER_RETRY_SLEEP=0 \
       cmd_spawn probe chore --base main 2>&1 >/dev/null)"
assert_eq "$(printf '%s' "$out" | grep -c '자동으로 재시도하지 않는다')" "1" \
  "남은 자원이 있으면 자동 재시도하지 않는다고 말한다"
assert_eq "$(printf '%s' "$out" | grep -c '남은 자원(residualResources):')" "1" \
  "남은 자원 목록을 머리말과 함께 낸다"
assert_eq "$(printf '%s' "$out" | grep -c 'term_stub_left')" "1" \
  "무엇이 남았는지를 그대로 보여 준다"
assert_eq "$(printf '%s' "$out" | grep -c '복구: ')" "1" \
  "정본이 함께 주는 복구 명령을 그대로 보여 준다"
assert_eq "$(printf '%s' "$out" | grep -c '어디까지 갔는가: dispatch_input')" "1" \
  "어디까지 갔다가 실패했는지를 출력에 싣는다(failedStage)"
assert_status 1 "남은 자원이 있으면 spawn 은 실패로 끝난다" \
  env STUB_ORCA_WS_FAIL_MODE=residual STUB_ORCA_REQUEST_STATE=absent \
      ORCA_WORKER_ATTACH_BUDGET_SEC=300 \
      ORCA_WORKER_ATTACH_MAX_TRIES=5 ORCA_WORKER_RETRY_SLEEP=0 \
  bash -c '. "$0"; cmd_spawn probe chore --base main' "$SUT"

# **가장 위험한 조합** — 이어받기가 성공할 상황(request-show: pending)인데 남은
# 자원도 있다. 금지가 없으면 여기서 --retry-request 로 되돌려 주고 spawn 이
# 성공으로 끝난다. 정본의 금지에는 조건이 없다 — 남은 자원이 있으면 되돌리지도 않는다.
: > "$STUB_ORCA_LOG"
STUB_ORCA_WS_FAIL_MODE=residual STUB_ORCA_REQUEST_STATE=pending STUB_ORCA_WS_REPLAY_OK=1 \
  ORCA_WORKER_ATTACH_BUDGET_SEC=300 ORCA_WORKER_ATTACH_MAX_TRIES=5 ORCA_WORKER_RETRY_SLEEP=0 \
  cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep 'orchestration worker-start' "$STUB_ORCA_LOG" | grep -c -- '--retry-request')" "0" \
  "이어받기가 성공할 상황이어도 남은 자원이 있으면 되돌려 주지 않는다"
assert_status 1 "그 경우에도 spawn 은 실패로 끝난다(성공으로 삼키지 않는다)" \
  env STUB_ORCA_WS_FAIL_MODE=residual STUB_ORCA_REQUEST_STATE=pending STUB_ORCA_WS_REPLAY_OK=1 \
      ORCA_WORKER_ATTACH_BUDGET_SEC=300 ORCA_WORKER_ATTACH_MAX_TRIES=5 ORCA_WORKER_RETRY_SLEEP=0 \
  bash -c '. "$0"; cmd_spawn probe chore --base main' "$SUT"

# 판정 불가 갈래에도 stage 를 싣는다 — 「판정 불가」 한 마디로 끝내면 조율자가
# 터미널을 손으로 뒤지러 간다.
RS="$(mktemp -d)"
printf '{"ok":false,"error":{"code":"outcome_unknown","data":{"orchestrationRequestId":"r1","stage":"worktree_ready"}}}\n' \
  > "$RS/stage-only.json"
assert_eq "$(attach_stage "$RS/stage-only.json")" "worktree_ready" \
  "failedStage 가 없으면 stage 를 읽는다"
printf '{"ok":false,"error":{"code":"outcome_unknown","data":{"orchestrationRequestId":"r1","stage":"agent_launch","failedStage":"dispatch_input"}}}\n' \
  > "$RS/both.json"
assert_eq "$(attach_stage "$RS/both.json")" "dispatch_input" \
  "둘 다 있으면 failedStage 가 「어디서 실패했는가」다"
printf '{"ok":false,"error":{"code":"task_not_found","data":{"orchestrationRequestId":"r1","originalCommand":["orca"]}}}\n' \
  > "$RS/observed.json"
assert_eq "$(attach_stage "$RS/observed.json")" "" \
  "실물로 관측된 검증단계 실패 봉투에는 stage 가 없다(없으면 빈 문자열)"
assert_eq "$(attach_residual_count "$RS/observed.json")" "0" \
  "관측된 봉투에는 남은 자원이 없다"
assert_eq "$(attach_verdict "$RS/observed.json" | cut -d' ' -f1)" "unknown" \
  "관측된 봉투는 지금도 unknown 으로 떨어져 재시도하지 않는다"

# 빈 배열을 「남았다」로 읽으면 정상 재시도가 통째로 막힌다.
printf '{"ok":false,"error":{"code":"agent_unconfigured","data":{"orchestrationRequestId":"r1","effectsApplied":false,"residualResources":[]}}}\n' \
  > "$RS/empty.json"
assert_eq "$(attach_residual_count "$RS/empty.json")" "0" "빈 residualResources 는 0건이다"
assert_eq "$(attach_verdict "$RS/empty.json" | cut -d' ' -f1)" "clean" \
  "남은 자원이 0건이면 원래 판정(clean)이 그대로 산다"

# **깊이를 짚지 않고 이름으로 훑는다.** 자리를 하나 골라 거기만 보면, 그 자리가 틀렸을 때
# 0건으로 읽히고 봉투가 `effectsApplied:false` 를 함께 달고 있으면 **clean 으로 떨어져
# 재시도한다** — 「자리를 틀려도 fail closed」가 바로 그 칸에서 거짓이 된다.
# 그 칸을 여기서 정면으로 잰다(`effectsApplied:false` 를 **일부러** 함께 넣는다).
printf '{"ok":false,"error":{"code":"agent_unconfigured","data":{"orchestrationRequestId":"r1","effectsApplied":false}},"result":{"worker":{"residualResources":[{"kind":"terminal","id":"t"}],"failedStage":"dispatch_input"}}}\n' \
  > "$RS/misplaced.json"
assert_eq "$(attach_residual_count "$RS/misplaced.json")" "1" \
  "우리가 짚지 않은 깊이에 있어도 이름으로 찾아낸다"
assert_eq "$(attach_verdict "$RS/misplaced.json" | cut -d' ' -f1)" "residual" \
  "effectsApplied:false 가 함께 와도 clean 으로 떨어지지 않는다(재시도 금지)"
assert_eq "$(attach_stage "$RS/misplaced.json")" "dispatch_input" \
  "stage 도 깊이를 짚지 않고 이름으로 찾는다"

# **남는 구멍은 이름 하나다 — 그것을 아는 척 덮지 않고 그대로 단언한다.**
# 런타임이 `residualResources` 를 다른 이름으로 부르면 못 찾고, 그때 봉투가
# `effectsApplied:false` 를 달고 있으면 clean 으로 떨어져 **재시도한다.**
# 이름을 모르는 채로는 더 좁힐 수 없다. 좁히는 척하면 그것이 다음 거짓이 된다.
printf '{"ok":false,"error":{"code":"agent_unconfigured","data":{"orchestrationRequestId":"r1","effectsApplied":false,"leftoverResources":[{"kind":"terminal","id":"t"}]}}}\n' \
  > "$RS/unknown-name.json"
assert_eq "$(attach_residual_count "$RS/unknown-name.json")" "0" \
  "모르는 이름의 남은 자원은 세지 못한다(이름은 --help 가 준 하나뿐이다)"
assert_eq "$(attach_verdict "$RS/unknown-name.json" | cut -d' ' -f1)" "clean" \
  "그때는 clean 으로 떨어져 재시도한다 — 이 칸은 fail closed 가 아니다(알고 남긴다)"
# 같은 봉투에서 effectsApplied 가 없으면(관측된 모양) 판정 불가로 떨어진다.
printf '{"ok":false,"error":{"code":"agent_unconfigured","data":{"orchestrationRequestId":"r1","leftoverResources":[{"kind":"terminal","id":"t"}]}}}\n' \
  > "$RS/unknown-name-noflag.json"
assert_eq "$(attach_verdict "$RS/unknown-name-noflag.json" | cut -d' ' -f1)" "unknown" \
  "effectsApplied 가 없으면(관측된 모양) 판정 불가로 떨어져 재시도하지 않는다"
rm -rf "$RS"

# 붙지 못한 워커는 wait 로 잡히지 않는다. 관측 B 에서 리뷰어는 22분 동안 정상
# 작동했지만 완료 신호가 오지 않아 조율자가 터미널을 직접 읽어야 했다.
out="$(STUB_ORCA_WS_FAIL_MODE=clean ORCA_WORKER_ATTACH_BUDGET_SEC=0 ORCA_WORKER_RETRY_SLEEP=0 \
       cmd_spawn probe chore --base main 2>&1 >/dev/null)"
assert_eq "$(printf '%s' "$out" | grep -c 'wait` 로 잡히지 않는다')" "1" \
  "붙이기에 최종 실패하면 wait 로 잡히지 않음을 말한다"
assert_eq "$(printf '%s' "$out" | grep -c '터미널을 직접 읽어야 한다')" "1" \
  "터미널을 직접 읽어야 한다고 말한다"
assert_eq "$(printf '%s' "$out" | grep -c 'orca-worker.sh attach probe chore')" "1" \
  "워크트리를 버리지 않고 attach 로 다시 붙이라고 말한다"
assert_eq "$(printf '%s' "$out" | grep -c '정리 후 다시 spawn')" "0" \
  "세팅이 끝난 워크트리를 버리라고 말하지 않는다"

: > "$STUB_ORCA_LOG"
cmd_spawn probe2 implement --base main >/dev/null 2>&1
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--agent claude --model opus')" "1" \
  "implement 는 opus 로 에이전트를 띄운다"

# 빈 핸들로 read/send 를 부르면 Orca 가 코디네이터 자신의 터미널로 해석한다.
# 영수증에 핸들이 없으면 워크트리로 되짚고, 그래도 없으면 멈춘다.
: > "$STUB_ORCA_LOG"
STUB_ORCA_WS_NO_HANDLE=1 cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep -c 'terminal read' "$STUB_ORCA_LOG")" "0" \
  "핸들을 얻지 못하면 터미널을 읽지 않는다"
assert_eq "$(grep -c 'terminal rename' "$STUB_ORCA_LOG")" "0" \
  "핸들을 얻지 못하면 제목도 바꾸지 않는다"
assert_status 1 "핸들을 얻지 못하면 실패로 끝낸다" \
  env STUB_ORCA_WS_NO_HANDLE=1 bash -c '. "$0"; cmd_spawn probe chore --base main' "$SUT"

# 영수증에 핸들이 없어도 워크트리에 살아 있는 에이전트 터미널이 있으면 되짚는다.
jq --arg wt "repo1::$P/.worktrees/$PB/probe" \
   '.result.terminals |= (map(.worktreeId = $wt) | .[0:1])' \
   "$HERE/fixtures/terminal-list.json" > "$P/terms.json"
: > "$STUB_ORCA_LOG"
assert_status 0 "영수증에 핸들이 없으면 terminal list 로 되짚어 이어간다" \
  env STUB_ORCA_WS_NO_HANDLE=1 STUB_ORCA_TERMINALS_FIXTURE="$P/terms.json" \
  bash -c '. "$0"; cmd_spawn probe chore --base main' "$SUT"
: > "$STUB_ORCA_LOG"
STUB_ORCA_WS_NO_HANDLE=1 STUB_ORCA_TERMINALS_FIXTURE="$P/terms.json" \
  cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep 'terminal rename' "$STUB_ORCA_LOG" | grep -c 'term_reap_1')" "1" \
  "되짚은 핸들로 이어서 작업한다"
unset ORCA_WORKER_RETRY_SLEEP

# F6 — require_orca. Orca 런타임에 닿지 못하면 워크트리조차 만들지 않는다.
: > "$STUB_ORCA_LOG"
assert_status 1 "Orca 런타임이 없으면 spawn 이 실패한다" \
  env STUB_ORCA_FAIL=status bash -c '. "$0"; cmd_spawn probe chore --base main' "$SUT"
STUB_ORCA_FAIL=status cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep -c 'worktree create' "$STUB_ORCA_LOG")" "0" \
  "Orca 가 없으면 워크트리를 만들지 않는다(조용한 이탈 차단)"

# F6 — worker-start 가 실패하면 성공으로 끝내지 않는다.
assert_status 1 "worker-start 가 실패하면 spawn 도 실패한다" \
  env STUB_ORCA_FAIL="orchestration worker-start" bash -c '. "$0"; cmd_spawn probe chore --base main' "$SUT"

echo "attach — 세팅된 워크트리를 버리지 않고 다시 붙인다"
# spawn 이 붙이기에 실패하면 pnpm·.env 세팅이 끝난 워크트리와
# 살아 있는 터미널이 남는다. 조율자가 손으로 하던 「task 만 새로 세워 같은
# 터미널에 붙이기」를 스크립트가 한다.
ORCA_WORKER_WORKTREES_DIR="$P/.worktrees/$PB"; export ORCA_WORKER_WORKTREES_DIR
jq --arg wt "repo1::$P/.worktrees/$PB/probe" \
   '.result.terminals |= (map(.worktreeId = $wt) | .[0:1])' \
   "$HERE/fixtures/terminal-list.json" > "$P/aterms.json"
STUB_ORCA_TERMINALS_FIXTURE="$P/aterms.json"; export STUB_ORCA_TERMINALS_FIXTURE
# 진행 중인 Dispatch 가 그 터미널에 없어야 붙는다. 픽스처의 workers 를 비운다.
jq '.result.workers = []' "$HERE/fixtures/worker-list.json" > "$P/noworkers.json"
STUB_ORCA_WORKERS_FIXTURE="$P/noworkers.json"; export STUB_ORCA_WORKERS_FIXTURE

: > "$STUB_ORCA_LOG"
assert_status 0 "이미 있는 워크트리에 다시 붙는다" cmd_attach probe chore
: > "$STUB_ORCA_LOG"
cmd_attach probe chore >/dev/null 2>&1
assert_eq "$(grep -c 'worktree create' "$STUB_ORCA_LOG")" "0" \
  "attach 는 워크트리를 새로 만들지 않는다"
assert_eq "$(grep -c 'terminal create' "$STUB_ORCA_LOG")" "0" \
  "attach 는 터미널을 새로 만들지 않는다"
assert_eq "$(grep -c 'orchestration task-create' "$STUB_ORCA_LOG")" "1" \
  "실패한 Task 는 failed 로 잠기므로 Task 만 새로 세운다"
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--terminal term_reap_1')" "1" \
  "살아 있는 에이전트 터미널을 그대로 쓴다"
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--worktree')" "1" \
  "--terminal 을 줄 때 --worktree 를 빠뜨리지 않는다(mismatch 로 실패한다)"
# --model 은 --terminal 과 함께 쓸 수 없다(실물이 거부한다). 스텁도 거부한다.
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--model')" "0" \
  "이미 도는 에이전트에는 --model 을 붙이지 않는다"
assert_eq "$(grep -c '^REJECTED' "$STUB_ORCA_LOG")" "0" \
  "attach 의 모든 Orca 호출이 실물 인자 검증을 통과한다"

# 브리프는 spawn 과 같은 길로 간다.
: > "$STUB_ORCA_LOG"
cmd_attach probe chore --brief "$BRIEF" >/dev/null 2>&1
assert_eq "$(grep 'task-create' "$STUB_ORCA_LOG" | grep -c '이 브리프 본문이 spec 으로 가야 한다')" "1" \
  "attach 도 브리프를 task-create --spec 으로 넘긴다"

# 진행 중인 Dispatch 가 붙어 있으면 그 워커는 이미 브리프를 받았을 수 있다.
jq --arg h term_reap_1 \
   '.result.workers = [{dispatchId:"ctx_live",taskId:"task_live",runId:"run_a",workerState:"unsupervised",dispatchStatus:"dispatched",agentTerminalHandle:$h,terminalState:"retained",resource:null}]' \
   "$HERE/fixtures/worker-list.json" > "$P/liveworker.json"
: > "$STUB_ORCA_LOG"
assert_status 1 "진행 중인 Dispatch 가 있으면 붙이지 않는다" \
  env STUB_ORCA_WORKERS_FIXTURE="$P/liveworker.json" \
  bash -c '. "$0"; cmd_attach probe chore' "$SUT"
STUB_ORCA_WORKERS_FIXTURE="$P/liveworker.json" cmd_attach probe chore >/dev/null 2>&1
assert_eq "$(grep -c 'orchestration task-create' "$STUB_ORCA_LOG")" "0" \
  "거부할 때는 Task 도 만들지 않는다(중복 주입 차단)"
out="$(STUB_ORCA_WORKERS_FIXTURE="$P/liveworker.json" cmd_attach probe chore 2>&1 >/dev/null)"
assert_eq "$(printf '%s' "$out" | grep -c '두 번 주입')" "1" \
  "왜 거부하는지 말한다"
assert_status 0 "--force 면 확인하고도 붙일 수 있다" \
  env STUB_ORCA_WORKERS_FIXTURE="$P/liveworker.json" \
  bash -c '. "$0"; cmd_attach probe chore --force' "$SUT"

# 리뷰는 살아 있는 에이전트 터미널(구현자의 것)을 재사용하지 않고 새로 띄운다.
: > "$STUB_ORCA_LOG"
out="$(cmd_attach probe review 2>&1 >/dev/null)"
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--terminal')" "0" \
  "attach review: 살아 있는 터미널이 있어도 --terminal 없이 새로 띄운다"
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--agent claude')" "1" \
  "attach review: --agent 로 새 에이전트를 띄운다"
assert_eq "$(grep -c '^REJECTED' "$STUB_ORCA_LOG")" "0" \
  "attach review: 새로 띄우는 경로의 Orca 호출이 실물 인자 검증을 통과한다"
assert_eq "$(printf '%s' "$out" | grep -c '남아 있는 에이전트 터미널(term_reap_1)은 그대로 둔다')" "1" \
  "attach review: 남겨 둔 터미널 핸들을 보인다"
# stop 은 워크트리 단위라 리뷰어를 띄운 뒤에 권하면 방금 띄운 리뷰어까지 끈다.
assert_eq "$(printf '%s' "$out" | grep -c '띄우기 전에만.*stop probe ')" "1" \
  "attach review: 워크트리 단위 stop 은 리뷰어를 띄우기 전에만 권한다"
assert_eq "$(printf '%s' "$out" | grep -c 'terminal close --terminal term_reap_1$')" "1" \
  "attach review: 띄운 뒤에는 그 핸들 하나만 끄는 명령을 보인다"
assert_eq "$(printf '%s' "$out" | grep -c -- 'stop probe --force')" "0" \
  "attach review: 리뷰 앞 stop 에 --force 를 붙이지 않는다(도는 구현자를 죽여 진행 중 거부를 무력화한다)"
# 구현자가 아직 일하는 중이면 리뷰어를 띄우지 않는다 — 그 터미널에 붙지 않아도
# 반쯤 된 트리를 리뷰하고 두 에이전트가 한 워크트리를 함께 고친다.
: > "$STUB_ORCA_LOG"
assert_status 1 "attach review: 구현자 터미널에 진행 중인 Dispatch 가 있으면 띄우지 않는다" \
  env STUB_ORCA_WORKERS_FIXTURE="$P/liveworker.json" \
  bash -c '. "$0"; cmd_attach probe review' "$SUT"
assert_eq "$(grep -c 'orchestration task-create' "$STUB_ORCA_LOG")" "0" \
  "attach review: 거부할 때는 Task 도 만들지 않는다"
assert_eq "$(grep -c 'orchestration worker-start' "$STUB_ORCA_LOG")" "0" \
  "attach review: 거부하면 worker-start 까지 가지 않는다"
out="$(STUB_ORCA_WORKERS_FIXTURE="$P/liveworker.json" cmd_attach probe review 2>&1 >/dev/null)"
assert_eq "$(printf '%s' "$out" | grep -c '구현자 터미널 term_reap_1 에 아직 진행 중인 Dispatch(ctx_live)')" "1" \
  "attach review: 어느 터미널의 어느 Dispatch 때문인지 말한다"
assert_eq "$(printf '%s' "$out" | grep -c '반쯤 된 트리')" "1" \
  "attach review: 왜 거부하는지 말한다"
: > "$STUB_ORCA_LOG"
assert_status 0 "attach review --force: 확인하고도 띄울 수 있다" \
  env STUB_ORCA_WORKERS_FIXTURE="$P/liveworker.json" \
  bash -c '. "$0"; cmd_attach probe review --force' "$SUT"
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--terminal')" "0" \
  "attach review --force: 구현자 터미널에 붙지 않고 새로 띄운다"
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--agent claude')" "1" \
  "attach review --force: --agent 로 새 에이전트를 띄운다"
# 같은 조건의 implement 는 재사용한다.
: > "$STUB_ORCA_LOG"
cmd_attach probe implement >/dev/null 2>&1
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--terminal term_reap_1')" "1" \
  "attach implement: 살아 있는 터미널을 재사용한다"
# --terminal 을 준 리뷰는 사람이 고른 것이라 그대로 받는다.
: > "$STUB_ORCA_LOG"
cmd_attach probe review --terminal term_reap_1 >/dev/null 2>&1
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--terminal term_reap_1')" "1" \
  "attach review --terminal: 준 핸들을 그대로 쓴다"

# 리뷰 뒤에는 워크트리에 구현자·리뷰어 터미널이 함께 남는 것이 보통이다. --terminal 없는
# 수정 라운드가 둘 중 무엇을 고르는지가 실제로 갈리므로 「목록의 마지막」을 잠근다.
jq --arg wt "repo1::$P/.worktrees/$PB/probe" \
   '.result.terminals |= ([.[0], .[2]] | map(.worktreeId = $wt))' \
   "$HERE/fixtures/terminal-list.json" > "$P/aterms2.json"
: > "$STUB_ORCA_LOG"
STUB_ORCA_TERMINALS_FIXTURE="$P/aterms2.json" cmd_attach probe implement >/dev/null 2>&1
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--terminal term_live')" "1" \
  "attach implement: 에이전트 터미널이 둘이면 목록의 마지막을 쓴다"
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--terminal term_reap_1')" "0" \
  "attach implement: 목록의 첫째를 고르지 않는다"
out="$(STUB_ORCA_TERMINALS_FIXTURE="$P/aterms2.json" cmd_attach probe review 2>&1 >/dev/null)"
assert_eq "$(printf '%s' "$out" | grep -c '남아 있는 에이전트 터미널(term_reap_1 term_live)은 그대로 둔다')" "1" \
  "attach review: 남은 에이전트 터미널을 전부 보인다"
assert_eq "$(printf '%s' "$out" | grep -cE 'terminal close --terminal (term_reap_1|term_live)$')" "2" \
  "attach review: 핸들마다 하나씩 끄는 명령을 보인다"
# 진행 중인 Dispatch 는 마지막 터미널이 아니라 남은 터미널 전부에서 찾는다.
: > "$STUB_ORCA_LOG"
assert_status 1 "attach review: 첫째 터미널의 진행 중인 Dispatch 도 거부 사유가 된다" \
  env STUB_ORCA_TERMINALS_FIXTURE="$P/aterms2.json" STUB_ORCA_WORKERS_FIXTURE="$P/liveworker.json" \
  bash -c '. "$0"; cmd_attach probe review' "$SUT"
assert_eq "$(grep -c 'orchestration worker-start' "$STUB_ORCA_LOG")" "0" \
  "attach review: 터미널이 둘이어도 거부하면 worker-start 까지 가지 않는다"
# 반대쪽: 진행 중인 Dispatch 가 둘째(마지막) 터미널에만 있어도 거부한다 — 첫째만 보면 놓친다.
: > "$STUB_ORCA_LOG"
jq '.result.workers[0].agentTerminalHandle = "term_live"' "$P/liveworker.json" > "$P/liveworker2.json"
assert_status 1 "attach review: 둘째 터미널의 진행 중인 Dispatch 도 거부 사유가 된다" \
  env STUB_ORCA_TERMINALS_FIXTURE="$P/aterms2.json" STUB_ORCA_WORKERS_FIXTURE="$P/liveworker2.json" \
  bash -c '. "$0"; cmd_attach probe review' "$SUT"
assert_eq "$(grep -c 'orchestration worker-start' "$STUB_ORCA_LOG")" "0" \
  "attach review: 둘째 터미널 사례도 worker-start 까지 가지 않는다"

# 터미널이 하나도 남지 않았어도 워크트리 세팅은 살린다.
jq '.result.terminals = []' "$HERE/fixtures/terminal-list.json" > "$P/noterms.json"
: > "$STUB_ORCA_LOG"
STUB_ORCA_TERMINALS_FIXTURE="$P/noterms.json" cmd_attach probe chore >/dev/null 2>&1
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--agent claude --model sonnet')" "1" \
  "살아 있는 터미널이 없으면 --agent 로 새로 띄운다"
assert_eq "$(grep -c 'worktree create' "$STUB_ORCA_LOG")" "0" \
  "그래도 워크트리는 다시 만들지 않는다"

# H2 — attach 는 복구 경로다. 워크트리의 .env 를 덮으면 워커가 바꿔 둔
# 포트·DB 경로가 조용히 최상위 값으로 돌아가고, gitignore 라 되돌릴 이력이 없다.
# **verb 를 통과하는 경로로 잰다** — sync_local_config 만 재면 호출부가 정책을
# 안 넘겨도 통과한다.
mkdir -p "$P/.worktrees/$PB/probe"
printf 'TOP\n' > "$P/.env"
printf 'WORKER-EDITED\n' > "$P/.worktrees/$PB/probe/.env"
cmd_attach probe chore >/dev/null 2>&1
assert_eq "$(cat "$P/.worktrees/$PB/probe/.env")" "WORKER-EDITED" \
  "attach 는 워크트리의 .env 를 덮지 않는다"
cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(cat "$P/.worktrees/$PB/probe/.env")" "TOP" \
  "spawn(새 워크트리)은 지금까지처럼 최상위 값으로 맞춘다"
printf 'WORKER-EDITED\n' > "$P/.worktrees/$PB/probe/.env"

# M2 — --terminal 로 받은 핸들이 이 워크트리 것인지 잰다.
# 확인 없이 넘기면 다른 워크트리(다른 프로젝트일 수도 있다)에서 도는 워커에
# 브리프가 주입된다. 이것은 중복 주입이 아니라 오폭이라 --force 로도 뚫지 않는다.
: > "$STUB_ORCA_LOG"
assert_status 1 "남의 워크트리 핸들은 거부한다" cmd_attach probe chore --terminal term_foreign
assert_eq "$(grep -c 'orchestration task-create' "$STUB_ORCA_LOG")" "0" \
  "거부할 때는 Task 도 만들지 않는다(소속 위반)"
assert_eq "$(grep -c 'orchestration worker-start' "$STUB_ORCA_LOG")" "0" \
  "거부하면 worker-start 까지 가지 않는다"
assert_status 1 "--force 로도 소속 검사는 못 뚫는다" \
  cmd_attach probe chore --terminal term_foreign --force
out="$(cmd_attach probe chore --terminal term_foreign 2>&1 >/dev/null)"
assert_eq "$(printf '%s' "$out" | grep -c '것이 아니다')" "1" "왜 거부하는지 말한다"
# 그 워크트리의 핸들이면 통과한다.
assert_status 0 "그 워크트리의 핸들이면 --terminal 을 받는다" \
  cmd_attach probe chore --terminal term_reap_1

# L5 — 실패한 Dispatch 의 교체를 --retry-of 로 잇는다(스킬 정본). 없으면 이력이 끊긴다.
jq --arg h term_reap_1 \
   '.result.workers = [{dispatchId:"ctx_prev",taskId:"task_prev",runId:"run_a",workerState:"failed",dispatchStatus:"failed",agentTerminalHandle:$h,terminalState:"retained",resource:null}]' \
   "$HERE/fixtures/worker-list.json" > "$P/prevworker.json"
: > "$STUB_ORCA_LOG"
STUB_ORCA_WORKERS_FIXTURE="$P/prevworker.json" cmd_attach probe chore >/dev/null 2>&1
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--retry-of ctx_prev')" "1" \
  "직전 Dispatch 가 실패했으면 --retry-of 로 잇는다"
: > "$STUB_ORCA_LOG"
cmd_attach probe chore >/dev/null 2>&1
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--retry-of')" "0" \
  "이을 Dispatch 가 없으면 --retry-of 를 붙이지 않는다"

# 성공한 Dispatch 는 잇지 않는다. 새 Task 는 그것의 재시도가 아니다 —
# 상태를 안 보고 직전 것을 집으면 이 verb 가 복구 경로로 서 있는 바로 그 자리
# (앞선 붙이기는 실패했지만 그 전 작업은 성공한 터미널)에서 뜻이 뒤집힌다.
jq --arg h term_reap_1 \
   '.result.workers = [{dispatchId:"ctx_done",taskId:"task_done",runId:"run_a",workerState:"completed",dispatchStatus:"completed",agentTerminalHandle:$h,terminalState:"retained",resource:null}]' \
   "$HERE/fixtures/worker-list.json" > "$P/doneworker.json"
: > "$STUB_ORCA_LOG"
STUB_ORCA_WORKERS_FIXTURE="$P/doneworker.json" cmd_attach probe chore >/dev/null 2>&1
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--retry-of')" "0" \
  "성공한 Dispatch 는 --retry-of 로 잇지 않는다"

# 직전이 성공이면 그 앞의 실패도 잇지 않는다. 이을 것은 「교체하는 그 시도」뿐이다.
jq --arg h term_reap_1 \
   '.result.workers = [{dispatchId:"ctx_old_fail",taskId:"task_o",runId:"run_a",workerState:"failed",dispatchStatus:"failed",agentTerminalHandle:$h,terminalState:"retained",resource:null},
                       {dispatchId:"ctx_done",taskId:"task_done",runId:"run_a",workerState:"completed",dispatchStatus:"completed",agentTerminalHandle:$h,terminalState:"retained",resource:null}]' \
   "$HERE/fixtures/worker-list.json" > "$P/staleworker.json"
: > "$STUB_ORCA_LOG"
STUB_ORCA_WORKERS_FIXTURE="$P/staleworker.json" cmd_attach probe chore >/dev/null 2>&1
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--retry-of')" "0" \
  "직전이 성공이면 그 앞의 실패를 끌어와 잇지 않는다"

# 없는 워크트리에 attach 하면 spawn 을 쓰라고 말한다.
assert_status 1 "워크트리가 없으면 거부한다" cmd_attach 없다 chore
assert_status 2 "<슬러그> <역할> 이 없으면 사용법 오류다" cmd_attach probe

# 붙이기에 실패하면 attach 도 wait 로 잡히지 않음을 말한다.
out="$(STUB_ORCA_WS_FAIL_MODE=clean ORCA_WORKER_ATTACH_BUDGET_SEC=0 ORCA_WORKER_RETRY_SLEEP=0 \
       cmd_attach probe chore 2>&1 >/dev/null)"
assert_eq "$(printf '%s' "$out" | grep -c 'wait` 로 잡히지 않는다')" "1" \
  "attach 가 실패해도 wait 로 잡히지 않음을 말한다"
assert_eq "$(printf '%s' "$out" | grep -c 'terminal read --terminal term_reap_1')" "1" \
  "읽어야 할 터미널을 핸들까지 찍어 준다"

echo "tiergear 연동"
TG="$HERE/stub-tiergear.sh"
export STUB_TG_LOG="$(mktemp)"
jq '.result.terminals = []' "$HERE/fixtures/terminal-list.json" > "$P/tg-noterms.json"
STUB_ORCA_TERMINALS_FIXTURE="$P/tg-noterms.json"; export STUB_ORCA_TERMINALS_FIXTURE
TGWT="$P/.worktrees/$PB/probe"

# 1. tiergear 없음 — 지금과 같다(역할 기본 모델, --effort 없음).
: > "$STUB_ORCA_LOG"
out="$(cmd_spawn probe chore --base main 2>&1)"
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--agent claude --model sonnet --timeout-ms')" "1" \
  "tiergear 가 없으면 spawn 은 역할 기본 모델로 띄운다(--effort 없음)"
assert_eq "$(printf '%s' "$out" | grep -c '모델: sonnet (역할 기본값 chore)')" "1" \
  "요약에 역할 기본값 출처를 적는다"
: > "$STUB_ORCA_LOG"
cmd_attach probe chore >/dev/null 2>&1
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--agent claude --model sonnet --timeout-ms')" "1" \
  "tiergear 가 없으면 attach 도 역할 기본 모델로 띄운다(--effort 없음)"

# 2. tiergear 있음 — 스텁 출력의 --model·--effort 가 worker-start 로 간다.
: > "$STUB_ORCA_LOG"; : > "$STUB_TG_LOG"
out="$(TIERGEAR_COMMAND="$TG" cmd_spawn probe review --base main 2>&1)"
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--agent claude --model opus --effort xhigh --timeout-ms')" "1" \
  "spawn: tiergear 가 고른 --model·--effort 를 worker-start 에 넘긴다"
assert_eq "$(printf '%s' "$out" | grep -c '^tiergear: judged deep, applied deep')" "1" \
  "tiergear 의 stderr 를 사용자에게 그대로 보인다"
assert_eq "$(printf '%s' "$out" | grep -c '모델: opus/xhigh (tiergear: judged deep, applied deep, 역할 review)')" "1" \
  "요약에 effort 와 출처를 함께 적는다"
: > "$STUB_ORCA_LOG"
TIERGEAR_COMMAND="$TG" cmd_attach probe review >/dev/null 2>&1
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--agent claude --model opus --effort xhigh --timeout-ms')" "1" \
  "attach: 새로 띄울 때 tiergear 가 고른 값을 넘긴다"

# 3. 범위와 --worktree.
: > "$STUB_TG_LOG"
TIERGEAR_COMMAND="$TG" cmd_spawn probe review --base main >/dev/null 2>&1
assert_eq "$(grep -c -- '--min-tier deep' "$STUB_TG_LOG")" "1" "review 는 --min-tier deep"
assert_eq "$(grep -c -- '--max-tier' "$STUB_TG_LOG")" "0" "review 는 --max-tier 가 없다"
: > "$STUB_TG_LOG"
TIERGEAR_COMMAND="$TG" cmd_spawn probe verify --base main >/dev/null 2>&1
assert_eq "$(grep -c -- '--max-tier standard' "$STUB_TG_LOG")" "1" "verify 는 --max-tier standard"
: > "$STUB_TG_LOG"
TIERGEAR_COMMAND="$TG" cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep -c -- '--max-tier standard' "$STUB_TG_LOG")" "1" "chore 는 --max-tier standard"
: > "$STUB_TG_LOG"
TIERGEAR_COMMAND="$TG" cmd_spawn probe implement --base main >/dev/null 2>&1
assert_eq "$(grep -c -- '-tier' "$STUB_TG_LOG")" "0" "implement 는 범위 인자 없이 부른다"
assert_eq "$(grep -c '^launch ' "$STUB_TG_LOG")" "1" "implement 도 tiergear launch 를 부른다"
assert_eq "$(grep -c -- "--worktree $TGWT" "$STUB_TG_LOG")" "1" "--worktree 에 워크트리 경로를 넘긴다"
: > "$STUB_TG_LOG"; : > "$STUB_ORCA_LOG"
BR="$(mktemp)"; printf '브리프 원문 ABC\n' > "$BR"
TIERGEAR_COMMAND="$TG" cmd_spawn probe implement --base main --brief "$BR" >/dev/null 2>&1
assert_eq "$(grep -c '브리프 원문 ABC' "$STUB_TG_LOG")" "1" "tiergear 에는 task-create --spec 과 같은 브리프를 넘긴다"
rm -f "$BR"

# 4. --model 재정의·--terminal 이면 부르지 않는다.
: > "$STUB_TG_LOG"; : > "$STUB_ORCA_LOG"
TIERGEAR_COMMAND="$TG" cmd_spawn probe implement --model sonnet --base main >/dev/null 2>&1
assert_eq "$(wc -l < "$STUB_TG_LOG" | tr -d ' ')" "0" "spawn --model 이면 tiergear 를 부르지 않는다"
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--agent claude --model sonnet --timeout-ms')" "1" \
  "--model 재정의가 그대로 간다(--effort 없음)"
: > "$STUB_TG_LOG"
TIERGEAR_COMMAND="$TG" cmd_attach probe implement --model sonnet >/dev/null 2>&1
assert_eq "$(wc -l < "$STUB_TG_LOG" | tr -d ' ')" "0" "attach --model 이면 tiergear 를 부르지 않는다"
STUB_ORCA_TERMINALS_FIXTURE="$P/aterms.json"
: > "$STUB_TG_LOG"; : > "$STUB_ORCA_LOG"
TIERGEAR_COMMAND="$TG" cmd_attach probe chore --terminal term_reap_1 >/dev/null 2>&1
assert_eq "$(wc -l < "$STUB_TG_LOG" | tr -d ' ')" "0" "attach --terminal 이면 tiergear 를 부르지 않는다"
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--model')" "0" "--terminal 이면 모델을 넘기지 않는다"
# 살아 있는 터미널이 있어도 리뷰는 새로 띄우므로 tiergear 를 거쳐 범위가 걸린다.
: > "$STUB_TG_LOG"; : > "$STUB_ORCA_LOG"
TIERGEAR_COMMAND="$TG" cmd_attach probe review >/dev/null 2>&1
assert_eq "$(grep -c -- '--min-tier deep' "$STUB_TG_LOG")" "1" \
  "attach review: 살아 있는 터미널이 있어도 tiergear 를 --min-tier deep 으로 부른다"
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--agent claude --model opus --effort xhigh --timeout-ms')" "1" \
  "attach review: 살아 있는 터미널이 있어도 tiergear 가 고른 값으로 새로 띄운다"
STUB_ORCA_TERMINALS_FIXTURE="$P/tg-noterms.json"

# 5. 실패는 경고 + 역할 기본값. 워커 기동은 막지 않는다.
tg_fallback() {
  # $1 설명, $2 STUB_TG_OUT, $3 STUB_TG_RC
  : > "$STUB_ORCA_LOG"
  local o
  o="$(TIERGEAR_COMMAND="$TG" STUB_TG_OUT="$2" STUB_TG_RC="$3" cmd_spawn probe chore --base main 2>&1)"
  assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--agent claude --model sonnet --timeout-ms')" "1" \
    "$1: 역할 기본값으로 worker-start 를 부른다"
  assert_eq "$(printf '%s' "$o" | grep -c '^경고: tiergear')" "1" "$1: 경고 한 줄을 낸다"
}
tg_fallback "launch 가 exit 1" "claude --model opus --effort xhigh" 1
tg_fallback "출력이 비었다" "" 0
tg_fallback "모델이 없는 출력" "claude --effort high" 0
tg_fallback "이상한 모델 토큰" 'claude --model opus;rm --effort high' 0
tg_fallback "이상한 effort 토큰" 'claude --model opus --effort $(x)' 0

# 6. effort 없는 출력이면 --effort 를 넘기지 않는다.
: > "$STUB_ORCA_LOG"
TIERGEAR_COMMAND="$TG" STUB_TG_OUT="claude --model haiku" cmd_spawn probe chore --base main >/dev/null 2>&1
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--agent claude --model haiku --timeout-ms')" "1" \
  "effort 가 없으면 --model 만 넘긴다"
assert_eq "$(grep 'worker-start' "$STUB_ORCA_LOG" | grep -c -- '--effort')" "0" "--effort 를 넘기지 않는다"
out="$(TIERGEAR_COMMAND="$TG" STUB_TG_OUT="claude --model fable[1m] --effort max" cmd_spawn probe chore --base main 2>&1)"
assert_eq "$(printf '%s' "$out" | grep -c '모델: fable\[1m\]/max')" "1" "[ ] 를 낀 모델 별칭도 받는다"
assert_eq "$(grep -c '^REJECTED' "$STUB_ORCA_LOG")" "0" "tiergear 경로의 Orca 호출도 인자 검증을 통과한다"

# 7. 브리프가 `-` 로 시작해도 tiergear 가 옵션으로 읽지 않게 옵션 뒤 `--` 한 인자로 간다.
for lead in '--- title' '- 항목' '-x'; do
  : > "$STUB_TG_LOG"
  TIERGEAR_COMMAND="$TG" select_worker_model review opus "" "$lead" "$TGWT" 2>/dev/null
  assert_eq "$(cat "$STUB_TG_LOG")" "launch --worktree $TGWT --min-tier deep -- $lead" \
    "'$lead' 로 시작하는 브리프는 옵션이 앞, \`--\` 뒤 한 인자로 간다"
done
: > "$STUB_TG_LOG"
TIERGEAR_COMMAND="$TG" select_worker_model implement opus "" "- 항목" "$TGWT" 2>/dev/null
assert_eq "$(cat "$STUB_TG_LOG")" "launch --worktree $TGWT -- - 항목" "implement 도 범위 없이 \`--\` 뒤로 보낸다"

# 8. 출력 파싱은 글롭 확장을 타지 않는다 — cwd 에 걸리는 파일이 있어도 글자 그대로다.
GD="$(mktemp -d)"; : > "$GD/fable1"; : > "$GD/aaa"
got="$(cd "$GD" && TIERGEAR_COMMAND="$TG" STUB_TG_OUT='claude --model fable[1m] --effort max' \
  select_worker_model chore sonnet "" x "$TGWT" 2>/dev/null; echo "$WM_MODEL/$WM_EFFORT")"
assert_eq "$got" 'fable[1m]/max' "[1m] 이 든 출력이 파일 이름(fable1)으로 바뀌지 않는다"
got="$(cd "$GD" && TIERGEAR_COMMAND="$TG" STUB_TG_OUT='claude --model * --effort high' \
  select_worker_model chore sonnet "" x "$TGWT" 2>/dev/null; echo "$WM_MODEL/$WM_EFFORT")"
assert_eq "$got" 'sonnet/' "글롭 문자뿐인 모델은 토큰 검사에서 걸러진다(파일 이름 aaa 가 되지 않는다)"
case "$-" in *f*) glob_state=off ;; *) glob_state=on ;; esac
assert_eq "$glob_state" "on" "파싱 뒤 글롭 설정이 원래대로 돌아온다"
rm -rf "$GD"

# 9. 값이 없어 다음 옵션이 모델로 잡히면 못 뽑은 것으로 본다.
tg_fallback "--model 뒤에 값이 없음" "claude --model --effort high" 0
tg_fallback "--effort 뒤에 값이 없음" "claude --model opus --effort --foo" 0

rm -f "$STUB_TG_LOG"; unset STUB_TG_LOG

unset ORCA_WORKER_WORKTREES_DIR STUB_ORCA_TERMINALS_FIXTURE STUB_ORCA_WORKERS_FIXTURE

rm -f "$STUB_ORCA_LOG"; rm -rf "$P"
unset STUB_ORCA_LOG STUB_ORCA_LIST_FIXTURE ORCA_WORKER_REPO_ROOT

echo "wait"
export STUB_ORCA_LOG="$(mktemp)"
cmd_wait --timeout-ms 1000 >/dev/null 2>&1
line="$(grep 'orchestration check' "$STUB_ORCA_LOG" | head -1)"
assert_eq "$(printf '%s' "$line" | grep -c -- '--wait')" "1" "check --wait 를 쓴다"
assert_eq "$(printf '%s' "$line" | grep -c 'worker_done')" "1" "worker_done 을 구독한다"
assert_eq "$(printf '%s' "$line" | grep -c 'escalation')" "1" "escalation 을 구독한다"
assert_eq "$(printf '%s' "$line" | grep -c 'question')" "1" "question 을 구독한다"

# 종료코드 계약: 타임아웃(3)과 수신(0)을 가른다.
assert_status 3 "아무것도 안 오면 체크포인트(exit 3)" cmd_wait --timeout-ms 1000
W="$(mktemp -d)"
printf '%s\n' '{"ok":true,"result":{"count":1,"messages":[{"type":"worker_done","subject":"끝","body":"본문"}]}}' \
  > "$W/done.json"
STUB_ORCA_CHECK_FIXTURE="$W/done.json"; export STUB_ORCA_CHECK_FIXTURE
assert_status 0 "worker_done 을 받으면 exit 0" cmd_wait --timeout-ms 1000
assert_eq "$(cmd_wait --timeout-ms 1000 | grep -c '본문')" "1" "받은 본문을 그대로 낸다"
# heartbeat 는 --types 로 걸러지지 않는다(런타임이 무시한다). heartbeat 만 온 배치를
# 보고 돌아가면 코디네이터가 그때마다 깨고, 워커의 question 은 다음 호출까지 방치된다 —
# 2026-09-01 seg-apply 배치에서 워커가 두 번 물은 판정이 그렇게 묻혔다.
: > "$STUB_ORCA_LOG"
HB="$(mktemp -u)"
# 이 블록은 ack 횟수를 세므로 **deliveryId 가 있는** 픽스처를 쓴다.
# (deliveryId 가 없을 때 경고를 내는 경로는 아래 F5 블록이 따로 지킨다)
printf '%s\n' '{"ok":true,"result":{"count":1,"deliveryId":"dlv_done","messages":[{"type":"worker_done","subject":"끝","body":"본문"}]}}' \
  > "$W/done_dlv.json"
STUB_ORCA_CHECK_FIXTURE="$W/done_dlv.json"
STUB_ORCA_CHECK_HEARTBEAT_ONCE="$HB"; export STUB_ORCA_CHECK_HEARTBEAT_ONCE
assert_status 0 "heartbeat 만 온 배치는 넘기고 계속 기다려 exit 0 으로 끝난다" \
  cmd_wait --timeout-ms 1000
assert_eq "$(grep 'orchestration check' "$STUB_ORCA_LOG" | grep -c -- '--wait')" "2" \
  "heartbeat 를 받으면 같은 호출 안에서 다시 기다린다"
assert_eq "$(grep 'orchestration check' "$STUB_ORCA_LOG" | grep -c -- '--ack')" "2" \
  "heartbeat 배치도 확인 처리한다(재생 방지)"
rm -f "$HB"
: > "$STUB_ORCA_LOG"
STUB_ORCA_CHECK_HEARTBEAT_ONCE="$HB"
assert_eq "$(cmd_wait --timeout-ms 1000 | grep -c 'heartbeat')" "0" \
  "heartbeat 는 보고 본문으로 내지 않는다"
rm -f "$HB"
unset STUB_ORCA_CHECK_HEARTBEAT_ONCE

# 응답이 깨져도 완료로 착각하지 않는다.
printf 'not json\n' > "$W/broken.json"
STUB_ORCA_CHECK_FIXTURE="$W/broken.json"
assert_status 3 "응답이 깨지면 완료가 아니라 체크포인트로 본다" cmd_wait --timeout-ms 1000
unset STUB_ORCA_CHECK_FIXTURE
rm -rf "$W"
rm -f "$STUB_ORCA_LOG"; unset STUB_ORCA_LOG

# ---------------------------------------------------------------------------
# 리뷰 지적(F3·F4·F13) — 파괴 경로의 판정
# ---------------------------------------------------------------------------
echo "생존 판정 — agents 여러 개 (F3)"
assert_eq "$(classify_worktree working 0 yes 0)" "waiting" "working 은 도는 워커다"
# 마지막 원소만 보면 done 이 이기는 배치. 하나라도 살아 있으면 waiting 이어야 한다.
assert_eq "$(is_worker_live working)" "yes" "working 은 살아 있다"

echo "터미널이 살아 있으면 폐기 대상이 아니다 (F4)"
assert_eq "$(classify_worktree none 3 yes 0)" "waiting" "agent 기록이 없어도 터미널이 살아 있으면 기다린다"
assert_eq "$(classify_worktree '' 3 yes 0)"   "waiting" "빈 상태 + 터미널 살아 있음도 기다린다"
assert_eq "$(classify_worktree none 0 yes 0)" "reap"    "터미널이 0이면 폐기 가능하다"
assert_eq "$(classify_worktree done 3 yes 0)" "recover" "done + 터미널은 회수 대상이다"

echo "파괴 경로 end-to-end (F3·F4·F13)"
export STUB_ORCA_LOG="$(mktemp)"
D="$(mktemp -d)"
git -C "$D" init -q -b main
printf 'x\n' > "$D/f.txt"; git -C "$D" add f.txt
git -C "$D" -c user.email=t@t -c user.name=t commit -qm base
DB="$(basename "$D")"
for w in mixed fresh plain; do
  git -C "$D" worktree add -q "$D/.worktrees/$DB/$w" -b "$w"
done
# mixed: agents 가 [{working},{done}] — 마지막만 보면 done 으로 보인다
# fresh: agents 가 [] 인데 터미널 3개 (갓 spawn 한 워크트리)
# plain: agents 없음, 터미널 0 — 진짜 폐기 대상
jq -n --arg m "$D/.worktrees/$DB/mixed" --arg f "$D/.worktrees/$DB/fresh" \
      --arg p "$D/.worktrees/$DB/plain" '
  {ok:true,result:{worktrees:[
    {worktreeId:("repo1::"+$m),repoId:"repo1",path:$m,branch:"refs/heads/mixed",
     isMainWorktree:false,displayName:"mixed",liveTerminalCount:2,
     agents:[{state:"working"},{state:"done"}]},
    {worktreeId:("repo1::"+$f),repoId:"repo1",path:$f,branch:"refs/heads/fresh",
     isMainWorktree:false,displayName:"fresh",liveTerminalCount:3,agents:[]},
    {worktreeId:("repo1::"+$p),repoId:"repo1",path:$p,branch:"refs/heads/plain",
     isMainWorktree:false,displayName:"plain",liveTerminalCount:0,agents:[]}
  ]}}' > "$D/ps.json"
STUB_ORCA_PS_FIXTURE="$D/ps.json"; ORCA_WORKER_REPO_ID=repo1; ORCA_WORKER_REPO_ROOT="$D"
export STUB_ORCA_PS_FIXTURE ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

assert_eq "$(collect_worktrees | awk -F'\t' '$1=="mixed"{print $2}')" "working" \
  "agents 중 하나라도 살아 있으면 그 상태를 대표로 쓴다"
assert_eq "$(cmd_status --porcelain --base main | awk -F'\t' '$2=="mixed"{print $1}')" "waiting" \
  "도는 워커가 섞인 워크트리는 waiting 이다"
assert_eq "$(cmd_status --porcelain --base main | awk -F'\t' '$2=="fresh"{print $1}')" "waiting" \
  "갓 spawn 한 워크트리는 waiting 이다"

: > "$STUB_ORCA_LOG"
cmd_reap --all-merged --base main >/dev/null 2>&1
assert_eq "$(grep 'worktree rm' "$STUB_ORCA_LOG" | grep -c 'mixed')" "0" \
  "도는 워커가 섞인 워크트리에 worktree rm 이 나가지 않는다"
assert_eq "$(grep 'worktree rm' "$STUB_ORCA_LOG" | grep -c 'fresh')" "0" \
  "갓 spawn 한 워크트리에 worktree rm 이 나가지 않는다"
assert_eq "$(grep 'worktree rm' "$STUB_ORCA_LOG" | grep -c 'plain')" "1" \
  "진짜 폐기 대상만 지운다"
assert_eq "$(grep -c '^REJECTED' "$STUB_ORCA_LOG")" "0" \
  "reap 의 모든 Orca 호출이 실물 인자 검증을 통과한다(종료코드를 삼키는 것까지)"

# F13 — 슬러그를 찍어도 살아 있는 워커는 거부한다
: > "$STUB_ORCA_LOG"
assert_status 1 "슬러그를 찍어도 도는 워커는 거부한다" cmd_reap mixed --base main
assert_eq "$(grep -c 'worktree rm' "$STUB_ORCA_LOG")" "0" \
  "거부된 표적 reap 은 삭제 명령을 내지 않는다"

# F10 — 없는 슬러그
assert_status 1 "없는 슬러그는 실패로 알린다" cmd_reap 없는슬러그 --base main

# F8 — 일괄 + --force 금지
: > "$STUB_ORCA_LOG"
assert_status 2 "--all-merged 와 --force 는 함께 못 쓴다" cmd_reap --all-merged --force --base main
assert_eq "$(grep -c -E 'worker-release|terminal stop|worktree rm' "$STUB_ORCA_LOG")" "0" \
  "거부된 조합은 어떤 파괴 명령도 실행하지 않는다"
# 개별 슬러그 + --force 는 여전히 허용된다
printf 'wip\n' > "$D/.worktrees/$DB/plain/wip.txt"
: > "$STUB_ORCA_LOG"
cmd_reap plain --base main --force >/dev/null 2>&1
assert_eq "$(grep 'worktree rm' "$STUB_ORCA_LOG" | grep -c -- '--force')" "1" \
  "--force 로 게이트를 넘겼으면 worktree rm 도 --force 로 부른다"
rm -f "$D/.worktrees/$DB/plain/wip.txt"

rm -f "$STUB_ORCA_LOG"; rm -rf "$D"
unset STUB_ORCA_LOG STUB_ORCA_PS_FIXTURE ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

# ---------------------------------------------------------------------------
# 리뷰 지적(F5) — Delivery 확인 처리
# ---------------------------------------------------------------------------
echo "wait 의 Delivery 확인 처리 (F5)"
export STUB_ORCA_LOG="$(mktemp)"
A="$(mktemp -d)"
printf '%s\n' '{"ok":true,"result":{"deliveryId":"dlv_1","count":1,"messages":[{"type":"worker_done","subject":"끝","body":"본문"}]}}' \
  > "$A/done.json"
STUB_ORCA_CHECK_FIXTURE="$A/done.json"; export STUB_ORCA_CHECK_FIXTURE
cmd_wait --timeout-ms 1000 >/dev/null 2>&1
assert_eq "$(grep -c -- '--ack dlv_1' "$STUB_ORCA_LOG")" "1" \
  "받은 Delivery 를 --ack 로 확인 처리한다"
assert_eq "$(grep -c '^REJECTED' "$STUB_ORCA_LOG")" "0" \
  "wait 의 모든 Orca 호출이 실물 인자 검증을 통과한다"
# 확인 처리는 메시지를 처리한 뒤여야 한다 — 순서를 로그로 본다.
assert_eq "$(grep -n -E -- '--wait|--ack dlv_1' "$STUB_ORCA_LOG" | grep -c '^1:.*--wait')" "1" \
  "먼저 받고(--wait) 그 다음에 확인 처리한다"

# 아무것도 못 받았으면 확인 처리할 것도 없다.
: > "$STUB_ORCA_LOG"
unset STUB_ORCA_CHECK_FIXTURE
cmd_wait --timeout-ms 1000 >/dev/null 2>&1
assert_eq "$(grep -c -- '--ack' "$STUB_ORCA_LOG")" "0" "타임아웃이면 확인 처리하지 않는다"

# deliveryId 가 없으면 조용히 넘어가지 않고 경고한다.
printf '%s\n' '{"ok":true,"result":{"count":1,"messages":[{"type":"worker_done","subject":"s","body":"b"}]}}' \
  > "$A/nodlv.json"
STUB_ORCA_CHECK_FIXTURE="$A/nodlv.json"; export STUB_ORCA_CHECK_FIXTURE
assert_eq "$(cmd_wait --timeout-ms 1000 2>&1 >/dev/null | grep -c 'deliveryId')" "1" \
  "deliveryId 를 못 찾으면 경고한다"
unset STUB_ORCA_CHECK_FIXTURE

# F12 — 빈 응답에서 count 가 빈 문자열이 되는 경로. jq 는 빈 입력에 exit 0 + 무출력이다.
: > "$A/empty.json"
STUB_ORCA_CHECK_FIXTURE="$A/empty.json"; export STUB_ORCA_CHECK_FIXTURE
assert_status 3 "응답이 통째로 비어도 완료로 착각하지 않는다" cmd_wait --timeout-ms 1000
unset STUB_ORCA_CHECK_FIXTURE
rm -f "$STUB_ORCA_LOG"; rm -rf "$A"; unset STUB_ORCA_LOG

# ---------------------------------------------------------------------------
# 리뷰 지적(F6) — spawn 의 검증 단계
# ---------------------------------------------------------------------------
echo "verify_base (F6)"
V="$(mktemp -d)"
git -C "$V" init -q -b main
printf 'a\n' > "$V/f.txt"; git -C "$V" add f.txt
git -C "$V" -c user.email=t@t -c user.name=t commit -qm base
VB="$(basename "$V")"
git -C "$V" worktree add -q "$V/.worktrees/$VB/behind" -b behind
# 기준 브랜치를 한 커밋 앞으로 보낸다 → 워크트리가 1커밋 뒤처진다
printf 'b\n' >> "$V/f.txt"
git -C "$V" -c user.email=t@t -c user.name=t commit -qam ahead

assert_eq "$(git -C "$V/.worktrees/$VB/behind" rev-list --count behind..main)" "1" \
  "되감기 전에는 1커밋 뒤처져 있다"
verify_base "$V/.worktrees/$VB/behind" main >/dev/null 2>&1
assert_eq "$(git -C "$V/.worktrees/$VB/behind" rev-list --count behind..main)" "0" \
  "verify_base 가 기준으로 되감는다"
assert_status 1 "없는 경로는 실패로 알린다(조용히 넘어가지 않는다)" verify_base "$V/없다" main
assert_status 1 "존재하지 않는 기준 브랜치도 실패로 알린다" \
  verify_base "$V/.worktrees/$VB/behind" 없는브랜치
rm -rf "$V"

echo "verify_setup (F6)"
# 가짜 pnpm 을 PATH 앞에 두고 호출됐는지 로그로 본다.
S2="$(mktemp -d)"
mkdir -p "$S2/bin" "$S2/wt"
cat > "$S2/bin/pnpm" <<'PNPMEOF'
#!/bin/bash
printf 'pnpm %s\n' "$*" >> "$SETUP_LOG"
PNPMEOF
chmod +x "$S2/bin/pnpm"
SETUP_LOG="$S2/setup.log"; export SETUP_LOG
: > "$SETUP_LOG"
OLDPATH="$PATH"; PATH="$S2/bin:$PATH"; export PATH
verify_setup "$S2/wt" >/dev/null 2>&1
assert_eq "$(grep -c 'pnpm install' "$SETUP_LOG")" "1" \
  "node_modules 가 없으면 pnpm install 을 돌린다"
: > "$SETUP_LOG"
mkdir -p "$S2/wt/node_modules"
verify_setup "$S2/wt" >/dev/null 2>&1
assert_eq "$(grep -c 'pnpm install' "$SETUP_LOG")" "0" \
  "node_modules 가 있으면 pnpm install 을 돌리지 않는다"
PATH="$OLDPATH"; export PATH
unset SETUP_LOG
rm -rf "$S2"

echo ".env — attach 는 덮지 않는다 (H2)"
# attach 는 이미 사람이나 워커가 손댄 워크트리에 적용되는 복구 경로다.
# .env 는 gitignore 라 덮으면 되돌릴 이력이 없고, 워커가 바꿔 둔 포트·DB 경로가
# 조용히 최상위 값으로 돌아가면 워크트리 앱이 최상위 앱과 충돌한다.
HH="$(mktemp -d)"
git -C "$HH" init -q -b main
printf 'x\n' > "$HH/f.txt"
printf 'TOP\n' > "$HH/.env"
git -C "$HH" add f.txt >/dev/null 2>&1
git -C "$HH" -c user.email=t@t -c user.name=t commit -qm base
HB="$(basename "$HH")"
mkdir -p "$HH/.worktrees/$HB/w"
printf 'WORKER-EDITED\n' > "$HH/.worktrees/$HB/w/.env"
ORCA_WORKER_REPO_ROOT="$HH"; export ORCA_WORKER_REPO_ROOT

sync_local_config "$HH/.worktrees/$HB/w" preserve >/dev/null 2>&1
assert_eq "$(cat "$HH/.worktrees/$HB/w/.env")" "WORKER-EDITED" \
  "preserve 는 워크트리에서 바꾼 값을 덮지 않는다"
out="$(sync_local_config "$HH/.worktrees/$HB/w" preserve 2>&1 >/dev/null)"
assert_eq "$(printf '%s' "$out" | grep -c '덮지 않고 그대로 둔다')" "1" \
  "다르면 조용히 넘어가지 않고 알린다"

# 비어 있으면 채운다 — 「없어서 환경 변수 없이 뜨는」 사고는 그대로 막아야 한다.
rm -f "$HH/.worktrees/$HB/w/.env"
sync_local_config "$HH/.worktrees/$HB/w" preserve >/dev/null 2>&1
assert_eq "$(cat "$HH/.worktrees/$HB/w/.env" 2>/dev/null)" "TOP" \
  "preserve 도 비어 있으면 최상위에서 채운다"

# spawn(새 워크트리)은 그대로 덮는다.
printf 'WORKER-EDITED\n' > "$HH/.worktrees/$HB/w/.env"
sync_local_config "$HH/.worktrees/$HB/w" >/dev/null 2>&1
assert_eq "$(cat "$HH/.worktrees/$HB/w/.env")" "TOP" \
  "기본값(overwrite)은 지금까지처럼 덮는다"
rm -rf "$HH"; unset ORCA_WORKER_REPO_ROOT

echo "attach_worker 의 퓨즈 (M1)"
assert_status 0 "0 은 정수다" is_uint 0
assert_status 0 "240 은 정수다" is_uint 240
assert_status 1 "abc 는 정수가 아니다" is_uint abc
assert_status 1 "앞뒤 공백이 붙으면 정수가 아니다" is_uint " 240 "
assert_status 1 "16진수 표기는 정수가 아니다" is_uint 0x10
assert_status 1 "음수는 정수가 아니다" is_uint -1
assert_status 1 "빈 값은 정수가 아니다" is_uint ""
assert_eq "$(FOO=abc uint_env FOO 240 2>/dev/null)" "240" "정수가 아니면 기본값으로 되돌린다"
assert_eq "$(FOO=7 uint_env FOO 240 2>/dev/null)" "7" "정수면 그 값을 쓴다"
assert_eq "$(uint_env FOO_UNSET_XYZ 240 2>/dev/null)" "240" "없으면 기본값을 쓴다"
assert_eq "$(FOO=abc uint_env FOO 240 2>&1 >/dev/null | grep -c '정수가 아니다')" "1" \
  "되돌릴 때 조용히 넘어가지 않는다"

# 예산이 유일한 퓨즈면 그 한 값이 정수가 아닌 순간 루프가 끝나지 않는다
# (`[ 5 -ge abc ]` 는 rc=2 로 죽고 `if` 가 그것을 거짓으로 삼킨다).
# 그래서 **시도 횟수 상한**이 두 번째 퓨즈다.
export STUB_ORCA_LOG="$(mktemp)"
FUSE="$(mktemp -d)"
: > "$STUB_ORCA_LOG"
assert_status 1 "예산이 정수가 아니어도 끝난다(횟수 상한이 받는다)" \
  env ORCA_CLI_COMMAND="$HERE/stub-orca.sh" \
      STUB_ORCA_WS_FAIL_MODE=clean ORCA_WORKER_ATTACH_BUDGET_SEC=abc \
      ORCA_WORKER_ATTACH_MAX_TRIES=2 ORCA_WORKER_RETRY_SLEEP=0 \
  bash -c '. "$0"; attach_worker "$1" --task t --terminal h --json' "$SUT" "$FUSE/r.json"
assert_eq "$(grep -c 'orchestration worker-start' "$STUB_ORCA_LOG")" "2" \
  "횟수 상한만큼만 부른다"
# 값이 정수가 아니면 **알리고** 기본값을 쓴다. 조용히 그 값을 그대로 쓰면
# `[ 5 -ge abc ]` 가 rc=2 로 죽고 `if` 가 거짓으로 삼켜 예산 퓨즈가 꺼진다.
fuse_out="$(ORCA_CLI_COMMAND="$HERE/stub-orca.sh" \
  STUB_ORCA_WS_FAIL_MODE=clean ORCA_WORKER_ATTACH_BUDGET_SEC=abc \
  ORCA_WORKER_ATTACH_MAX_TRIES=2 ORCA_WORKER_RETRY_SLEEP=0 \
  bash -c '. "$0"; attach_worker "$1" --task t --terminal h --json' "$SUT" "$FUSE/r.json" 2>&1 >/dev/null)"
assert_eq "$(printf '%s' "$fuse_out" | grep -c 'ORCA_WORKER_ATTACH_BUDGET_SEC=abc 는 정수가 아니다')" "1" \
  "예산이 정수가 아니면 그 사실을 알린다(조용히 퓨즈를 끄지 않는다)"
: > "$STUB_ORCA_LOG"
ORCA_CLI_COMMAND="$HERE/stub-orca.sh" STUB_ORCA_WS_FAIL_MODE=clean \
  ORCA_WORKER_ATTACH_BUDGET_SEC=" 240 " ORCA_WORKER_ATTACH_MAX_TRIES=3 ORCA_WORKER_RETRY_SLEEP=0 \
  bash -c '. "$0"; attach_worker "$1" --task t --terminal h --json' "$SUT" "$FUSE/r.json" \
  >/dev/null 2>&1
assert_eq "$(grep -c 'orchestration worker-start' "$STUB_ORCA_LOG")" "3" \
  "앞뒤 공백이 붙은 예산에도 끝난다"
rm -f "$STUB_ORCA_LOG"; rm -rf "$FUSE"; unset STUB_ORCA_LOG

echo "verify_submitted (F6)"
export STUB_ORCA_LOG="$(mktemp)"
R2="$(mktemp -d)"
# ---------------------------------------------------------------------------
# 픽스처는 실물 `terminal read --screen --json` 을 세 가지 성질까지 흉내낸다.
#
# 1) **상태줄에 진짜 NBSP(0xc2 0xa0)가 들어간다.** 실물 상태줄의 낱말 사이는 보통 공백이
#    아니라 U+00A0 다:  C t x c2a0 U s e d : c2a0 <게이지> c2a0 1 2 . 0 %
#    보통 공백으로 지으면 **실물에서 절대 맞지 않는 패턴이 여기서 초록으로 통과한다.**
# 2) **`tail` 이 화면 줄의 배열이고 응답이 여러 줄로 pretty-print 된다.** 실물이 그렇다.
# 3) **스크롤백이 함께 들어 있다.** 실물 화면에는 워커가 읽은 브리프·문서가 떠 있어
#    `Ctx Used` 라는 글자가 산문으로도 나타난다 — 실물에서 그 글자를 담은 tail 줄이
#    여섯이었고 **그중 다섯이 산문**이었다. 상태줄만 든 픽스처는 그 자리를 재지 못한다.
# ---------------------------------------------------------------------------
nbsp_status() { printf '\xc2\xa0Ctx\xc2\xa0Used:\xc2\xa0\xe2\x96\x93\xe2\x96\x91\xc2\xa0%s\xc2\xa0\xc2\xa05m\xc2\xa0\xc2\xa0|\xc2\xa0\xc2\xa0\xe2\x8e\x87\xc2\xa0probe' "$1"; }
# 실물처럼 여러 줄로 pretty-print 된 --screen 응답을 만든다. 인자가 화면 줄이다.
screen_json() {
  jq -n --args '{ok:true,result:{terminal:{handle:"term_x",status:"running",tail:$ARGS.positional}}}' "$@"
}
# 산문 스크롤백 — 앵커는 있지만 퍼센트가 없다(이 규칙을 인용하는 브리프의 한 줄).
SCROLLBACK='  Ctx Used 로 브리프 제출을 확인한다 (브리프 본문 — 스크롤백)'
# **미끼** — 앵커와 0.0% 를 한 줄에 함께 가진 산문. `last` 가 아니면 이것에 속는다.
DECOY='  상태줄의 Ctx Used 가 0.0% 면 모델이 한 번도 돌지 않은 것이다'

screen_json "$SCROLLBACK" "$(nbsp_status '0.0%')"  > "$R2/zero.json"
screen_json "$SCROLLBACK" "$(nbsp_status '12.3%')" > "$R2/used.json"
screen_json '화면을 읽지 못했다'                     > "$R2/blank.json"
# A — 상태줄이 아예 없고 스크롤백에만 앵커가 있다(워커는 미제출 상태다).
screen_json "$SCROLLBACK" '' '❯ 브리프가 입력창에 그대로 남아 있다' > "$R2/scrollback-only.json"
# D — 미끼(0.0%)가 위에 있고 진짜 상태줄은 11.0% 다(워커는 제출됐다).
screen_json "$DECOY" "$(nbsp_status '11.0%')" > "$R2/decoy.json"

# 픽스처가 실물처럼 NBSP 를 담고 있는지부터 잰다. 이 단언이 무너지면 아래 전부가
# 「보통 공백 상태줄」을 재는 것이 되어 뜻을 잃는다.
assert_eq "$(grep -c "$(printf 'Ctx\xc2\xa0Used')" "$R2/zero.json")" "1" \
  "픽스처 상태줄의 Ctx 와 Used 사이는 진짜 NBSP(0xc2 0xa0)다"
assert_eq "$(grep -c 'Ctx Used' "$R2/zero.json")" "1" \
  "보통 공백 'Ctx Used' 는 산문 스크롤백에만 있다(옛 패턴이 잡는 것이 그것이다)"
assert_eq "$([ "$(grep -c '' "$R2/zero.json")" -gt 1 ] && printf yes || printf no)" "yes" \
  "픽스처 응답은 실물처럼 여러 줄이다(한 줄이면 줄 단위 성질을 못 잰다)"

STUB_ORCA_READ_FIXTURE="$R2/used.json"; export STUB_ORCA_READ_FIXTURE
: > "$STUB_ORCA_LOG"
assert_status 0 "Ctx Used 가 0 보다 크면 제출된 것이다" verify_submitted term_x
assert_eq "$(grep -c 'terminal send' "$STUB_ORCA_LOG")" "0" "제출됐으면 엔터를 보내지 않는다"
assert_eq "$(grep 'terminal read' "$STUB_ORCA_LOG" | grep -c -- '--screen')" "1" \
  "상태줄은 --screen 으로 읽는다(기본 읽기는 조각난다)"
out="$(verify_submitted term_x 2>&1 >/dev/null)"
assert_eq "$(printf '%s\n' "$out" | grep -c '안 잡힌다')" "0" \
  "NBSP 상태줄을 「아직 안 그려졌다」로 읽지 않는다"

# **「대괄호가 아니라 교체(`|`)」 규칙을 스위트가 직접 지킨다.**
# 대괄호로 되돌리면 `[ <NBSP>]` 가 C 로케일에서 **한 바이트**만 세어 두 바이트짜리
# NBSP 를 놓친다. 그런데 그 회귀는 개발자 기계의 UTF-8 로케일에서는 **초록으로 통과하고**
# 컨테이너·cron·launchd·`env -i` 같은 C 로케일에서만 깨진다 — 그러면 규칙을 주석과
# 문서가 가르치는데 아무도 못 지킨다. 그래서 여기서 로케일을 명시로 고정해 잰다.
assert_eq "$(printf '%s' "$(nbsp_status '0.0%')" | LC_ALL=C grep -cE "$CTX_USED_RE")" "1" \
  "C 로케일에서도 NBSP 상태줄 앵커가 맞는다(대괄호로 되돌리면 여기서 깨진다)"
assert_eq "$(printf '%s' "$(nbsp_status '0.0%')" \
  | LC_ALL=C grep -cE "$CTX_USED_RE"'[^0-9]*0\.0%')" "1" \
  "C 로케일에서도 0.0% 갈래가 맞는다"
assert_eq "$(printf 'Ctx Used: 0.0%%' | LC_ALL=C grep -cE "$CTX_USED_RE")" "1" \
  "C 로케일에서 보통 공백 상태줄도 그대로 맞는다(둘 다 받는다)"

# **이 갈래가 이 장치의 존재 이유다.** 상태줄을 못 찾으면 여기 도달하지 못하고,
# 도달하지 못하는 것은 「제출을 확인했다」와 출력으로 구별되지 않는다.
STUB_ORCA_READ_FIXTURE="$R2/zero.json"
: > "$STUB_ORCA_LOG"
assert_status 1 "Ctx Used 0.0% 는 미제출이고 시도를 소진한 뒤 실패로 알린다" verify_submitted term_x
assert_eq "$(grep -c 'terminal send' "$STUB_ORCA_LOG")" "6" "미제출이면 시도 횟수만큼 엔터를 보낸다"
out="$(ORCA_WORKER_SUBMIT_TRIES=1 verify_submitted term_x 2>&1 >/dev/null)"
assert_eq "$(printf '%s\n' "$out" | grep -c '브리프가 제출되지 않았다')" "1" \
  "NBSP 상태줄에서도 0.0% 갈래에 실제로 도달한다"
assert_eq "$(printf '%s\n' "$out" | grep -c '안 잡힌다')" "0" \
  "0.0% 를 「상태줄을 못 읽었다」로 흘리지 않는다"
: > "$STUB_ORCA_LOG"
ORCA_WORKER_SUBMIT_TRIES=2 verify_submitted term_x >/dev/null 2>&1
assert_eq "$(grep -c 'terminal send' "$STUB_ORCA_LOG")" "2" \
  "시도 횟수는 ORCA_WORKER_SUBMIT_TRIES 가 정한다"

STUB_ORCA_READ_FIXTURE="$R2/blank.json"
assert_status 1 "상태줄을 못 읽으면 제출된 것으로 넘기지 않는다(fail-open 금지)" \
  verify_submitted term_x

# ---------------------------------------------------------------------------
# **탐지는 응답 전체가 아니라 상태줄 한 줄에 앵커돼야 한다.**
#
# `--screen` 이 내는 것은 렌더된 화면이고, 거기에는 워커가 읽은 브리프·문서가 그대로
# 떠 있다. 그 산문에 `Ctx Used` 라는 글자가 있으면 두 갈래가 함께 깨진다 — 그리고
# **이 규칙 자체가 산문이라** 이 규칙을 인용하는 브리프로 워커를 띄우면 그 워커의
# 미제출 탐지가 꺼진다. 실물 화면에서 그 글자를 담은 tail 줄이 여섯이었고 그중 다섯이
# 산문이었으며, **퍼센트를 함께 가진 것은 상태줄 하나뿐**이었다.
# ---------------------------------------------------------------------------
# A — 상태줄이 없고 스크롤백에만 앵커가 있다. 응답 전체를 훑으면 **경고 없이 「제출됨」** 이다.
STUB_ORCA_READ_FIXTURE="$R2/scrollback-only.json"
: > "$STUB_ORCA_LOG"
assert_status 1 "A: 스크롤백의 산문을 상태줄로 착각하지 않는다(제출됨으로 넘기지 않는다)" \
  verify_submitted term_x
out="$(ORCA_WORKER_SUBMIT_TRIES=1 verify_submitted term_x 2>&1 >/dev/null)"
assert_eq "$(printf '%s\n' "$out" | grep -c '안 잡힌다')" "1" \
  "A: 상태줄을 못 읽었다고 말한다(조용히 넘어가지 않는다)"
assert_eq "$(printf '%s\n' "$out" | grep -c '브리프가 제출되지 않았다')" "0" \
  "A: 퍼센트가 없는 산문을 0.0% 로 읽지도 않는다"

# D — 미끼(앵커+0.0%)가 위에 있고 진짜 상태줄은 11.0% 다. 응답 전체를 훑으면
# **멀쩡히 일하는 워커의 입력창에 엔터를 다시 보낸다.**
STUB_ORCA_READ_FIXTURE="$R2/decoy.json"
: > "$STUB_ORCA_LOG"
assert_status 0 "D: 스크롤백의 0.0% 미끼에 속지 않는다(진짜 상태줄이 11.0% 다)" \
  verify_submitted term_x
assert_eq "$(grep -c 'terminal send' "$STUB_ORCA_LOG")" "0" \
  "D: 도는 워커에 엔터를 다시 보내지 않는다"

# 상태줄 고르기 자체 — 매치가 여럿이면 **맨 아래**가 상태줄이다.
assert_eq "$(status_line "$(cat "$R2/decoy.json")" | grep -c '11.0%')" "1" \
  "앵커에 맞는 줄이 여럿이면 마지막(화면 맨 아래) 줄을 상태줄로 고른다"
assert_eq "$(status_line "$(cat "$R2/scrollback-only.json")")" "" \
  "퍼센트를 함께 갖지 않는 줄은 상태줄이 아니다"
assert_eq "$(status_line '{"ok":true,"result":{"text":"Ctx Used 0.0%"}}')" "" \
  "모르는 응답 모양에서는 상태줄을 고르지 않는다(fail closed)"

# 앞의 A·D 절이 픽스처를 바꿔 놓았다. 여기부터는 「상태줄을 못 읽는」 픽스처로 돌아간다 —
# 안 그러면 아래 대기 측정이 「곧바로 제출됨으로 끝난 시간」을 재게 된다.
STUB_ORCA_READ_FIXTURE="$R2/blank.json"

# H1 — 「상태줄이 안 잡힌다」 갈래에 **대기가 있어야 한다.** 대기가 없으면 세 번이
# 0.5초에 소진돼, 갓 뜬 TUI 가 상태줄을 그리기도 전에 시도가 끝나고 **미제출을 잡아
# 엔터를 다시 보내는 갈래에 영원히 도달하지 못한다.** 그래서 실제로 잰다.
t0="$(date +%s)"
ORCA_WORKER_SUBMIT_SLEEP=1 ORCA_WORKER_SUBMIT_TRIES=2 verify_submitted term_x >/dev/null 2>&1
t1="$(date +%s)"
assert_eq "$([ "$((t1 - t0))" -ge 2 ] && printf yes || printf no)" "yes" \
  "상태줄이 안 잡히면 그려질 때까지 실제로 기다린다(대기 없이 시도를 태우지 않는다)"
unset STUB_ORCA_READ_FIXTURE
rm -f "$STUB_ORCA_LOG"; rm -rf "$R2"; unset STUB_ORCA_LOG

# ---------------------------------------------------------------------------
# 리뷰 지적(F7) — 이미 쌓인 잔해에 닿는가
# ---------------------------------------------------------------------------
echo "prune_leftovers (F7)"
L="$(mktemp -d)"
git -C "$L" init -q -b main
printf 'x\n' > "$L/f.txt"; git -C "$L" add f.txt
git -C "$L" -c user.email=t@t -c user.name=t commit -qm base
LB="$(basename "$L")"
mkdir -p "$L/.worktrees/$LB/shell/node_modules" "$L/.worktrees/$LB/real"
printf 'work\n' > "$L/.worktrees/$LB/real/keep.txt"

assert_status 0 "빌드 산출물뿐이면 제거한다" prune_leftovers "$L/.worktrees/$LB/shell" "$L"
assert_eq "$([ -d "$L/.worktrees/$LB/shell" ] && printf yes || printf no)" "no" \
  "껍데기 디렉터리가 실제로 사라진다"
assert_status 1 "빌드 산출물이 아닌 내용이 있으면 지우지 않는다" \
  prune_leftovers "$L/.worktrees/$LB/real" "$L"
assert_eq "$([ -f "$L/.worktrees/$LB/real/keep.txt" ] && printf yes || printf no)" "yes" \
  "지우지 않은 디렉터리의 파일은 그대로 남는다"
assert_status 0 "--force 면 내용이 있어도 제거한다" \
  prune_leftovers "$L/.worktrees/$LB/real" "$L" yes
assert_eq "$([ -d "$L/.worktrees/$LB/real" ] && printf yes || printf no)" "no" \
  "--force 제거가 실제로 반영된다"

# git worktree prune 을 정말 부르는지 — 등록만 남은 유령 워크트리로 확인한다.
git -C "$L" worktree add -q "$L/.worktrees/$LB/ghost" -b ghost
rm -rf "$L/.worktrees/$LB/ghost"
assert_eq "$(git -C "$L" worktree list --porcelain | grep -c '^worktree .*ghost')" "1" \
  "디렉터리만 지우면 등록은 남는다"
mkdir -p "$L/.worktrees/$LB/tmp2"
prune_leftovers "$L/.worktrees/$LB/tmp2" "$L" >/dev/null 2>&1
assert_eq "$(git -C "$L" worktree list --porcelain | grep -c '^worktree .*ghost')" "0" \
  "prune_leftovers 가 git worktree prune 까지 돌린다"
rm -rf "$L"

echo "보호 표시 (.orca-keep)"
K="$(mktemp -d)"
git -C "$K" init -q -b main
printf 'x\n' > "$K/f.txt"; git -C "$K" add f.txt
git -C "$K" -c user.email=t@t -c user.name=t commit -qm base
KB="$(basename "$K")"
git -C "$K" worktree add -q "$K/.worktrees/$KB/kept" -b kept
git -C "$K" worktree add -q "$K/.worktrees/$KB/plain" -b plain
jq -n --arg a "$K/.worktrees/$KB/kept" --arg b "$K/.worktrees/$KB/plain" '
  {ok:true,result:{worktrees:[
    {worktreeId:("repo1::"+$a),repoId:"repo1",path:$a,branch:"refs/heads/kept",
     isMainWorktree:false,displayName:"kept",liveTerminalCount:3,agents:[{state:"done"}]},
    {worktreeId:("repo1::"+$b),repoId:"repo1",path:$b,branch:"refs/heads/plain",
     isMainWorktree:false,displayName:"plain",liveTerminalCount:3,agents:[{state:"done"}]}
  ]}}' > "$K/ps.json"
export STUB_ORCA_LOG="$(mktemp)"
STUB_ORCA_PS_FIXTURE="$K/ps.json"; ORCA_WORKER_REPO_ID=repo1; ORCA_WORKER_REPO_ROOT="$K"
export STUB_ORCA_PS_FIXTURE ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

# 표시가 없으면 둘 다 회수 대상이다.
assert_eq "$(cmd_status --porcelain --base main | awk -F'\t' '$2=="kept"{print $1}')" "recover" \
  "표시가 없으면 보통대로 판정한다"

touch "$K/.worktrees/$KB/kept/.orca-keep"

assert_eq "$(is_kept "$K/.worktrees/$KB/kept" && printf yes || printf no)" "yes" \
  ".orca-keep 이 있으면 보호 상태다"
assert_eq "$(is_kept "$K/.worktrees/$KB/plain" && printf yes || printf no)" "no" \
  "표시가 없으면 보호 상태가 아니다"
assert_eq "$(cmd_status --porcelain --base main | awk -F'\t' '$2=="kept"{print $1}')" "keep" \
  "보호된 워크트리는 keep 으로 분류된다"
assert_eq "$(is_unsettled keep)" "no" \
  "보호된 워크트리는 미정리로 세지 않는다 — 훅이 조용해야 한다"
assert_eq "$(cmd_status --porcelain --base main | awk -F'\t' '$2=="plain"{print $1}')" "recover" \
  "옆 워크트리는 영향받지 않는다"

# 사람이 쓰는 중이라는 표시다. --all-merged 는 무조건 건너뛴다.
: > "$STUB_ORCA_LOG"
cmd_reap --all-merged --base main >/dev/null 2>&1
assert_eq "$(grep 'worktree rm' "$STUB_ORCA_LOG" | grep -c 'kept')" "0" \
  "--all-merged 는 보호된 워크트리를 건드리지 않는다"
assert_eq "$(grep 'worktree rm' "$STUB_ORCA_LOG" | grep -c 'plain')" "1" \
  "보호되지 않은 워크트리는 그대로 정리된다"
assert_eq "$([ -d "$K/.worktrees/$KB/kept" ] && printf yes || printf no)" "yes" \
  "보호된 워크트리 디렉터리가 남아 있다"

# 슬러그를 직접 지정해도 거부한다. --force 로도 뚫리지 않는다.
: > "$STUB_ORCA_LOG"
assert_status 1 "슬러그를 직접 줘도 보호된 것은 거부한다" cmd_reap kept --base main
assert_status 1 "--force 로도 보호를 뚫지 못한다" cmd_reap kept --base main --force
assert_eq "$(grep -c 'worktree rm' "$STUB_ORCA_LOG")" "0" \
  "거부된 동안 삭제 명령이 나가지 않는다"
assert_eq "$(cmd_reap kept --base main 2>&1 >/dev/null | grep -c 'orca-keep')" "1" \
  "거부 사유가 해제 방법을 알려준다"

# keep 명령으로 표시를 붙이고 뗀다.
: > "$STUB_ORCA_LOG"
assert_status 0 "keep 이 표시를 붙인다" cmd_keep plain
assert_eq "$(is_kept "$K/.worktrees/$KB/plain" && printf yes || printf no)" "yes" \
  "keep 뒤에는 보호 상태다"
assert_status 0 "keep --remove 가 표시를 뗀다" cmd_keep plain --remove
assert_eq "$(is_kept "$K/.worktrees/$KB/plain" && printf yes || printf no)" "no" \
  "해제 뒤에는 보호 상태가 아니다"
assert_status 1 "없는 슬러그에 keep 은 실패한다" cmd_keep 없다

rm -f "$STUB_ORCA_LOG"; rm -rf "$K"
unset STUB_ORCA_LOG STUB_ORCA_PS_FIXTURE ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

echo "고아 디렉터리 탐지 (F7)"
export STUB_ORCA_LOG="$(mktemp)"
O="$(mktemp -d)"
git -C "$O" init -q -b main
printf 'x\n' > "$O/f.txt"; git -C "$O" add f.txt
git -C "$O" -c user.email=t@t -c user.name=t commit -qm base
OB="$(basename "$O")"
git -C "$O" worktree add -q "$O/.worktrees/$OB/live" -b live
# Orca 도 git 도 모르는 껍데기. 내용은 빌드 산출물뿐이다.
mkdir -p "$O/.worktrees/$OB/dead/node_modules"
jq -n --arg l "$O/.worktrees/$OB/live" '
  {ok:true,result:{worktrees:[
    {worktreeId:("repo1::"+$l),repoId:"repo1",path:$l,branch:"refs/heads/live",
     isMainWorktree:false,displayName:"live",liveTerminalCount:0,agents:[]}
  ]}}' > "$O/ps.json"
STUB_ORCA_PS_FIXTURE="$O/ps.json"; ORCA_WORKER_REPO_ID=repo1; ORCA_WORKER_REPO_ROOT="$O"
export STUB_ORCA_PS_FIXTURE ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

assert_eq "$(collect_orphans | cut -f1 | tr '\n' ',')" "dead," \
  "git 에도 Orca 에도 없는 디렉터리만 고아로 센다"
assert_eq "$(cmd_status --porcelain --base main | awk -F'\t' '$2=="dead"{print $1}')" "orphan" \
  "status 가 고아를 보고한다"
assert_eq "$(is_unsettled orphan)" "yes" "고아는 미정리다"
assert_status 1 "고아가 있으면 status 가 exit 1 이다" cmd_status --base main

: > "$STUB_ORCA_LOG"
cmd_reap dead --base main --dry-run >/dev/null 2>&1
assert_eq "$(grep -c -E 'worker-release|terminal stop|worktree rm' "$STUB_ORCA_LOG")" "0" \
  "고아 dry-run 은 어떤 Orca 명령도 부르지 않는다"
assert_eq "$([ -d "$O/.worktrees/$OB/dead" ] && printf yes || printf no)" "yes" \
  "dry-run 은 고아를 지우지 않는다"
cmd_reap dead --base main >/dev/null 2>&1
assert_eq "$([ -d "$O/.worktrees/$OB/dead" ] && printf yes || printf no)" "no" \
  "reap 이 고아를 실제로 치운다"
assert_eq "$([ -d "$O/.worktrees/$OB/live" ] && printf yes || printf no)" "yes" \
  "살아 있는 워크트리는 건드리지 않는다"

# 옛 경로(.worktrees/<슬러그>)의 잔해. git worktree add 로 만든 워크트리를
# 지우면 여기 남는데, 스캔이 .worktrees/<저장소>/ 만 보면 영원히 누락된다.
mkdir -p "$O/.worktrees/old-style/node_modules"
assert_eq "$(collect_orphans | cut -f1 | sort | tr '\n' ',')" "old-style," \
  "옛 경로 .worktrees/<슬러그> 의 잔해도 고아로 잡는다"
assert_eq "$(cmd_status --porcelain --base main | awk -F'\t' '$2=="old-style"{print $1}')" "orphan" \
  "status 가 옛 경로 잔해를 보고한다"
cmd_reap old-style --base main >/dev/null 2>&1
assert_eq "$([ -d "$O/.worktrees/old-style" ] && printf yes || printf no)" "no" \
  "reap 이 옛 경로 잔해를 치운다"
assert_eq "$([ -d "$O/.worktrees/$OB" ] && printf yes || printf no)" "yes" \
  "저장소별 묶음 디렉터리 자신은 고아로 지우지 않는다"
rm -f "$STUB_ORCA_LOG"; rm -rf "$O"
unset STUB_ORCA_LOG STUB_ORCA_PS_FIXTURE ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

# ---------------------------------------------------------------------------
# 리뷰 지적(F11·F12) — 사람이 읽는 출력과 repo_id 경로
# ---------------------------------------------------------------------------
echo "다음 행동 문구 (F11·F12)"
assert_eq "$(next_action reap w 0)"    "폐기: reap w" "reap 은 폐기를 권한다"
assert_eq "$(next_action recover w 0)" "회수: reap w" "미커밋이 없는 recover 는 reap 을 권한다"
# F11: recover 가 blocked 보다 먼저 걸려 미커밋 정보가 사라지던 자리다.
assert_eq "$(next_action recover w 4 | grep -c '미커밋 4개')" "1" \
  "미커밋이 있는 recover 는 게이트에 걸린다는 사실을 알린다"
assert_eq "$(next_action recover w 4 | grep -c 'reap w')" "1" \
  "그래도 어떤 명령인지는 알려준다"
assert_eq "$(next_action blocked w 2 | grep -c '미커밋 2개')" "1" "blocked 는 미커밋 수를 낸다"
assert_eq "$(next_action orphan w 0 | grep -c 'reap w')" "1" "고아는 reap 을 권한다"
assert_eq "$(next_action waiting w 0)" "대기 중" "waiting 은 기다리라고 한다"
assert_eq "$(next_action active w 0)"  "작업 중" "active 는 작업 중이다"

echo "repo_id 조회 경로 (F12)"
# 테스트가 늘 ORCA_WORKER_REPO_ID 를 주입해 이 경로를 한 번도 타지 않았다.
I="$(mktemp -d)"
jq -n --arg r "$I" '
  {ok:true,result:{worktrees:[
    {worktreeId:("repo-xyz::"+$r),repoId:"repo-xyz",path:$r,branch:"refs/heads/main",
     isMainWorktree:true,displayName:"main",liveTerminalCount:0,agents:[]}
  ]}}' > "$I/ps.json"
STUB_ORCA_PS_FIXTURE="$I/ps.json"; ORCA_WORKER_REPO_ROOT="$I"
export STUB_ORCA_PS_FIXTURE ORCA_WORKER_REPO_ROOT
assert_eq "$(repo_id)" "repo-xyz" "최상위 경로와 일치하는 워크트리에서 repoId 를 얻는다"
ORCA_WORKER_REPO_ID=injected; export ORCA_WORKER_REPO_ID
assert_eq "$(repo_id)" "injected" "주입값이 있으면 그것을 쓴다"
unset ORCA_WORKER_REPO_ID
rm -rf "$I"
unset STUB_ORCA_PS_FIXTURE ORCA_WORKER_REPO_ROOT

echo ".env 복사 (sync_local_config)"
# gitignore 라 워크트리에 따라오지 않는 로컬 설정. 안 옮기면 워크트리 앱이 환경 변수
# 없이 떠서 설정 검증에 실패하거나 다른 Gateway·DB 경로를 향한다.
S="$(mktemp -d)"
mkdir -p "$S/root" "$S/wt"
echo 'PORT=3000' > "$S/root/.env"
ORCA_WORKER_REPO_ROOT="$S/root"; export ORCA_WORKER_REPO_ROOT

assert_status 0 "원본이 있으면 복사한다" sync_local_config "$S/wt"
assert_eq "$(cat "$S/wt/.env" 2>/dev/null)" \
  "PORT=3000" "워크트리에 최상위 값이 들어간다"

# 워크트리에 이미 다른 값이 있어도 기본값(overwrite)은 최상위로 맞춘다.
echo 'PORT=9999' > "$S/wt/.env"
assert_status 0 "이미 채워져 있어도 통과한다" sync_local_config "$S/wt"
assert_eq "$(cat "$S/wt/.env")" \
  "PORT=3000" "워크트리 값을 최상위 값으로 덮어쓴다"

mkdir -p "$S/bare"
ORCA_WORKER_REPO_ROOT="$S/bare"
assert_status 1 "원본에 .env 가 없으면 실패로 알린다" sync_local_config "$S/wt2"
assert_eq "$(sync_local_config "$S/wt2" 2>&1 >/dev/null | grep -c '환경 변수 없이')" "1" \
  "무엇이 잘못되는지(환경 변수 없이 뜬다)를 말한다"

ORCA_WORKER_REPO_ROOT="$S/root"
assert_status 0 "최상위 자신을 가리키면 아무것도 하지 않는다" sync_local_config "$S/root"
assert_eq "$(cat "$S/root/.env")" "PORT=3000" \
  "자기 복사로 원본을 비우지 않는다"

rm -rf "$S"
unset ORCA_WORKER_REPO_ROOT

# 워크트리 안에서 부르는 경우. repo_root 를 쓰면 원본=대상이 되어 조용히 아무 일도
# 일어나지 않는다 — 실물 git 워크트리로 그 경로를 잰다.
W="$(mktemp -d)"
git -C "$W" init -q -b main
printf 'x\n' > "$W/f.txt"
git -C "$W" add f.txt
git -C "$W" -c user.email=t@t -c user.name=t commit -qm base
echo 'PORT=3000' > "$W/.env"
git -C "$W" worktree add -q -b feat "$W/wt" >/dev/null 2>&1
ORCA_WORKER_REPO_ROOT="$W/wt"; export ORCA_WORKER_REPO_ROOT
assert_status 0 "워크트리 안에서 불러도 동작한다" sync_local_config "$W/wt"
assert_eq "$(cat "$W/wt/.env" 2>/dev/null)" \
  "PORT=3000" "워크트리 안에서 불러도 최상위를 원본으로 잡는다"
rm -rf "$W"
unset ORCA_WORKER_REPO_ROOT

# ---------------------------------------------------------------------------
# 워커 회수의 소유 증명과 회수 대상 판정 (owned_workers · release_disposition ·
# release_workers)
#
# worker-list 는 머신 전역이고 항목에 worktreeId 라는 최상위 필드가 **없다**.
# 없는 필드로 거르면 항상 0건이 되어 worker-release 가 한 번도 불리지 않고,
# 반대로 느슨하게 거르면 남의 프로젝트 워커를 회수한다. 양쪽을 다 잰다.
#
# 그 위에 판정이 하나 더 있다 — **증명됐다고 다 회수되는 것이 아니다.**
# retained·released 는 부르면 no-op 인데 건수에는 들어간다. 그 거짓도 여기서 잰다.
#
# 픽스처의 상태 조합은 실물 worker-list 에서 관측된 것만 쓴다:
#   reclaimable = owned + not_requested        · released = released + released
#   retained    = external / user_owned / 자원기록 없음 / identity_unproven
#   active      = owned + not_requested + 아직 dispatched(도는 워커)
# ---------------------------------------------------------------------------
echo "워커 회수의 소유 증명"
export STUB_ORCA_LOG="$(mktemp)"
X="$(mktemp -d)"
git -C "$X" init -q -b main
printf 'x\n' > "$X/f.txt"; git -C "$X" add f.txt
git -C "$X" -c user.email=t@t -c user.name=t commit -qm base
for w in w-recover w-reap w-live w-keep; do
  git -C "$X" worktree add -q "$X/.worktrees/lms-base/$w" -b "$w"
done
sed "s#REPO#$X#g" "$HERE/fixtures/worker-list.json"   > "$X/workers.json"
sed "s#REPO#$X#g" "$HERE/fixtures/terminal-list.json" > "$X/terminals.json"
jq -n --arg r "$X/.worktrees/lms-base/w-recover" --arg p "$X/.worktrees/lms-base/w-reap" \
      --arg l "$X/.worktrees/lms-base/w-live"    --arg k "$X/.worktrees/lms-base/w-keep" '
  {ok:true,result:{worktrees:[
    {worktreeId:("repo1::"+$r),repoId:"repo1",path:$r,branch:"refs/heads/w-recover",
     isMainWorktree:false,displayName:"w-recover",liveTerminalCount:0,agents:[{state:"done"}]},
    {worktreeId:("repo1::"+$p),repoId:"repo1",path:$p,branch:"refs/heads/w-reap",
     isMainWorktree:false,displayName:"w-reap",liveTerminalCount:2,agents:[{state:"done"}]},
    {worktreeId:("repo1::"+$l),repoId:"repo1",path:$l,branch:"refs/heads/w-live",
     isMainWorktree:false,displayName:"w-live",liveTerminalCount:1,agents:[{state:"working"}]},
    {worktreeId:("repo1::"+$k),repoId:"repo1",path:$k,branch:"refs/heads/w-keep",
     isMainWorktree:false,displayName:"w-keep",liveTerminalCount:1,agents:[{state:"done"}]},
    {worktreeId:"other::/tmp/other-project/.worktrees/other-project/other-wt",repoId:"other",
     path:"/tmp/other-project/.worktrees/other-project/other-wt",branch:"refs/heads/other-wt",
     isMainWorktree:false,displayName:"other-wt",liveTerminalCount:1,agents:[{state:"done"}]}
  ]}}' > "$X/ps.json"
STUB_ORCA_PS_FIXTURE="$X/ps.json"
STUB_ORCA_WORKERS_FIXTURE="$X/workers.json"
STUB_ORCA_TERMINALS_FIXTURE="$X/terminals.json"
ORCA_WORKER_REPO_ID=repo1
ORCA_WORKER_REPO_ROOT="$X"
export STUB_ORCA_PS_FIXTURE STUB_ORCA_WORKERS_FIXTURE STUB_ORCA_TERMINALS_FIXTURE
export ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

# 스텁이 실물처럼 --worktree 를 정확 일치로 해석하는지 먼저 잰다.
# 스텁이 실물보다 관대하면 범위를 넘긴 코드가 여기 단언을 통과한다.
assert_eq "$("$HERE/stub-orca.sh" terminal list --worktree "id:repo1::$X/.worktrees/lms-base/w-reap" --json \
  | jq -r '[.result.terminals[].handle] | sort | join(",")')" "term_reap_1,term_reap_2" \
  "스텁의 terminal list --worktree 가 실물처럼 정확 일치로 거른다"
assert_eq "$("$HERE/stub-orca.sh" terminal list --json | jq -r '.result.terminals | length')" "4" \
  "셀렉터를 안 주면 전역 목록을 낸다(머신 전역이라는 사실을 픽스처가 재현한다)"

# 증명 ①: resource.worktreeId. 터미널이 이미 죽었어도 자원 기록은 남는다 —
# w-recover 의 term_recover_dead 는 터미널 목록에 없다.
assert_eq "$(owned_workers "repo1::$X/.worktrees/lms-base/w-recover" | cut -f1 | sort | tr '\n' ',')" \
  "ctx_recover,ctx_recover_done," "터미널이 죽어도 resource.worktreeId 로 dispatch 를 찾아낸다"
# 증명 ②: resource 가 null 인 비감독 dispatch 는 살아 있는 핸들 집합으로 줍는다.
#
# **이 길이 좁아지면 안 된다.** 실물 전역 목록의 1/4 이 resource 가 없는 항목이고,
# 그 항목을 이 워크트리 것으로 묶어 주는 것은 핸들 교집합뿐이다. 상태로 거르는 판정이
# 들어와도 **소유 증명 단계에서는 걸러지지 않아야** 조율자가 「무엇을 건너뛰었는지」를 본다.
assert_eq "$(owned_workers "repo1::$X/.worktrees/lms-base/w-reap" | cut -f1 | sort | tr '\n' ',')" \
  "ctx_reap,ctx_taken,ctx_unsupervised," "resource 와 핸들 집합 양쪽으로 찾는다"
assert_eq "$(owned_workers "repo1::$X/.worktrees/lms-base/w-reap" \
  | awk -F'\t' '$1=="ctx_unsupervised"{print $4}')" "handle" \
  "resource 가 없는 항목은 핸들 교집합으로 잡히고 그 증명 경로를 그대로 낸다"
# 남의 프로젝트 dispatch 는 어느 워크트리에서도 나오면 안 된다.
# 픽스처는 ctx_foreign 의 핸들을 이 워크트리 터미널의 preview 본문에 **지어 넣었다** —
# 실물 미리보기에서 관측된 적은 없고, JSON 의 .handle 만 읽는지를 재기 위한 덫이다.
assert_eq "$(owned_workers "repo1::$X/.worktrees/lms-base/w-reap" | grep -c 'ctx_foreign')" "0" \
  "미리보기 본문의 문자열을 핸들로 줍지 않는다(지어낸 덫)"
assert_eq "$(for w in w-recover w-reap w-live w-keep; do
    owned_workers "repo1::$X/.worktrees/lms-base/$w"; done | grep -c -E 'ctx_foreign|ctx_released')" "0" \
  "다른 저장소의 dispatch 는 어느 워크트리에서도 나오지 않는다"
# 어느 증명도 대지 못하는 항목은 낸다면 그것이 fail-open 이다.
assert_eq "$(for w in w-recover w-reap w-live w-keep; do
    owned_workers "repo1::$X/.worktrees/lms-base/$w"; done | grep -c 'ctx_nowhere')" "0" \
  "소유를 증명하지 못하는 dispatch 는 건너뛴다(fail closed)"
assert_eq "$(owned_workers "repo1::$X/.worktrees/lms-base/없는워크트리" | grep -c '')" "0" \
  "없는 워크트리 셀렉터는 0건이다(광범위 폴백이 없다)"

# dispatchId 가 없는 항목을 jq 의 `empty` 로 지우면 **배열이 한 칸 밀려**
# terminalState 가 dispatchId 자리에 온다 — 그러면
# `worker-release --dispatch reclaimable` 을 부르게 된다. 통째로 빼야 한다.
jq '.result.workers += [{taskId:"task_noid",workerState:"succeeded",dispatchStatus:"completed",
    agentTerminalHandle:"term_reap_1",terminalState:"reclaimable",resource:null}]' \
  "$X/workers.json" > "$X/workers-noid.json"
assert_eq "$( export STUB_ORCA_WORKERS_FIXTURE="$X/workers-noid.json"
              owned_workers "repo1::$X/.worktrees/lms-base/w-reap" | cut -f1 | sort | tr '\n' ',' )" \
  "ctx_reap,ctx_taken,ctx_unsupervised," \
  "dispatchId 가 없는 항목은 내지 않는다(줄이 밀리지 않는다)"

# ---------------------------------------------------------------------------
# 회수 대상 판정 (release_disposition)
#
# `worker-release --help`: *Never closes ... user-taken-over terminals, or unproven
# identities. Idempotent: repeating the call reports already_released.*
# 즉 retained 는 서버가 거절하고 released 는 이미 끝났다 — 부르면 no-op 인데
# 「회수 N건」에는 들어간다. 그 거짓을 여기서 막는다.
# ---------------------------------------------------------------------------
assert_eq "$(release_disposition reclaimable)" "release" "reclaimable 만 회수 대상이다"
assert_eq "$(release_disposition released | cut -d: -f1)" "skip" "이미 released 인 것은 부르지 않는다"
assert_eq "$(release_disposition retained | cut -d: -f1)" "skip" "retained 는 서버가 거절하므로 부르지 않는다"
assert_eq "$(release_disposition active | cut -d: -f1)" "skip" "active 는 settled 가 아니므로 부르지 않는다"
assert_eq "$(release_disposition release_pending | cut -d: -f1)" "skip" "회수 진행 중인 것은 다시 부르지 않는다"
assert_eq "$(release_disposition release_unknown | cut -d: -f1)" "skip" "런타임이 결과를 모르는 것은 부르지 않는다"
assert_eq "$(release_disposition '' | cut -d: -f1)" "skip" "빈 상태는 판정 불가다(fail closed)"
assert_eq "$(release_disposition 지어낸상태 | cut -d: -f1)" "skip" "모르는 상태는 판정 불가다(fail closed)"

# release_workers 가 실제로 worker-release 를 부르는지. 이것이 죽어 있던 자리다.
: > "$STUB_ORCA_LOG"
out="$(release_workers "repo1::$X/.worktrees/lms-base/w-reap" 2>&1)"
assert_eq "$(grep -c 'worker-release' "$STUB_ORCA_LOG")" "1" \
  "회수 대상(reclaimable)에만 worker-release 를 부른다"
assert_eq "$(grep 'worker-release' "$STUB_ORCA_LOG" | grep -c -- '--dispatch ctx_reap')" "1" \
  "worker-release 에 dispatchId 를 넘긴다"
assert_eq "$(grep 'worker-release' "$STUB_ORCA_LOG" | grep -c -E 'ctx_foreign|ctx_nowhere|ctx_released')" "0" \
  "증명되지 않은 dispatch 는 회수하지 않는다"
assert_eq "$(grep -c '^REJECTED' "$STUB_ORCA_LOG")" "0" \
  "회수 경로의 모든 Orca 호출이 실물 인자 검증을 통과한다"

# **건수가 사실이어야 한다.** 부르지 못할 것까지 세면 다음 사람이 「회수됐구나」로 읽는다.
assert_eq "$(printf '%s\n' "$out" | grep -c '워커 1건 회수 · 2건 건너뜀 · 0건 실패')" "1" \
  "회수한 것과 건너뛴 것을 나눠 센다"
assert_eq "$(printf '%s\n' "$out" | grep -c '건너뜀: ctx_taken')" "1" \
  "사용자가 넘겨받은 터미널은 건너뛴다고 말한다"
assert_eq "$(printf '%s\n' "$out" | grep -c '사용자가 넘겨받았다')" "1" \
  "건너뛴 이유를 retainedReason 으로 말한다"
assert_eq "$(printf '%s\n' "$out" | grep -c '회수할 터미널 자원 기록이 없다')" "1" \
  "자원 기록이 없는 비감독 dispatch 는 그 이유를 말한다"

# 이미 회수된 것을 다시 세지 않는다(already_released 는 아무것도 닫지 않는다).
: > "$STUB_ORCA_LOG"
out="$(release_workers "repo1::$X/.worktrees/lms-base/w-recover" 2>&1)"
assert_eq "$(grep 'worker-release' "$STUB_ORCA_LOG" | grep -c -- '--dispatch ctx_recover_done')" "0" \
  "이미 released 인 dispatch 에는 worker-release 를 부르지 않는다"
assert_eq "$(printf '%s\n' "$out" | grep -c '워커 1건 회수 · 1건 건너뜀 · 0건 실패')" "1" \
  "이미 회수된 것을 회수 건수에 넣지 않는다"
assert_eq "$(printf '%s\n' "$out" | grep -c '이미 회수됐다')" "1" \
  "이미 회수된 것은 그렇다고 말한다"

# **도는 워커의 터미널은 끊지 않는다.** worker-release 는 settled 워커의 뒷정리다.
: > "$STUB_ORCA_LOG"
out="$(release_workers "repo1::$X/.worktrees/lms-base/w-live" 2>&1)"
assert_eq "$(grep -c 'worker-release' "$STUB_ORCA_LOG")" "0" \
  "active 인 워커에는 worker-release 를 부르지 않는다"
assert_eq "$(printf '%s\n' "$out" | grep -c 'settled')" "1" \
  "도는 워커를 건너뛴 이유를 말한다"

# worker-release 가 실패하면 회수 건수에 넣지 않는다.
: > "$STUB_ORCA_LOG"
out="$( export STUB_ORCA_FAIL="orchestration worker-release"
        release_workers "repo1::$X/.worktrees/lms-base/w-reap" 2>&1 )"
assert_eq "$(printf '%s\n' "$out" | grep -c '워커 0건 회수 · 2건 건너뜀 · 1건 실패')" "1" \
  "회수에 실패한 것을 회수했다고 세지 않는다"

# 0건은 조용히 넘어가지 않는다 — 정상인지 필터가 죽은 것인지 구별되어야 한다.
: > "$STUB_ORCA_LOG"
assert_eq "$(release_workers "repo1::$X/.worktrees/lms-base/w-keep" | grep -c '증명된 dispatch 가 없어')" "1" \
  "증명된 것이 없으면 부르지 않았다고 말한다"
assert_eq "$(grep -c 'worker-release' "$STUB_ORCA_LOG")" "0" \
  "증명된 것이 없으면 worker-release 를 한 번도 부르지 않는다"

# 「0건」과 「목록을 못 읽었다」는 다르다. 같은 말로 내면 필터가 죽은 날 조용히 넘어간다.
: > "$STUB_ORCA_LOG"
( export STUB_ORCA_FAIL="orchestration worker-list"
  owned_workers "repo1::$X/.worktrees/lms-base/w-reap" ) >/dev/null 2>&1
assert_eq "$?" "1" "worker-list 를 못 읽으면 rc=1 이다(0건과 구별된다)"
out="$( export STUB_ORCA_FAIL="orchestration worker-list"
        release_workers "repo1::$X/.worktrees/lms-base/w-reap" 2>&1 )"
assert_eq "$(printf '%s\n' "$out" | grep -c '판정하지 못했다')" "1" \
  "목록을 못 읽으면 0건이 아니라 판정 불가라고 말한다"
assert_eq "$(grep -c 'worker-release' "$STUB_ORCA_LOG")" "0" \
  "목록을 못 읽으면 아무것도 회수하지 않는다(fail closed)"

# reap 경로 end-to-end. w-reap 은 병합·클린이고 터미널이 있으므로 recover 다.
: > "$STUB_ORCA_LOG"
cmd_reap w-reap --base main >/dev/null 2>&1
assert_eq "$(grep 'worker-release' "$STUB_ORCA_LOG" | grep -c -- '--dispatch ctx_reap')" "1" \
  "reap 이 이 워크트리 워커를 실제로 회수한다"
assert_eq "$(grep 'worker-release' "$STUB_ORCA_LOG" | grep -c -- '--dispatch ctx_taken')" "0" \
  "reap 이 사용자가 넘겨받은 터미널을 회수하려 들지 않는다"
assert_eq "$(grep -c '^REJECTED' "$STUB_ORCA_LOG")" "0" \
  "reap 의 모든 Orca 호출이 실물 인자 검증을 통과한다"

# ---------------------------------------------------------------------------
# stop — 워크트리에 붙은 터미널만 정지한다
#
# 이 verb 가 없으면 사람이 `terminal list | grep` 루프를 즉흥으로 짠다. 그 목록은
# 머신 전역이고 항목 길이가 가변이라 창이 남의 항목을 삼킨다.
# ---------------------------------------------------------------------------
echo "stop — 저장소 범위 터미널 정지"
: > "$STUB_ORCA_LOG"
assert_status 0 "슬러그를 찍으면 성공한다" cmd_stop w-reap
assert_eq "$(grep 'terminal stop' "$STUB_ORCA_LOG" | grep -c -- "--worktree id:repo1::$X/.worktrees/lms-base/w-reap")" "1" \
  "정확 일치 셀렉터로 terminal stop 을 부른다"
assert_eq "$(grep -c 'terminal stop' "$STUB_ORCA_LOG")" "1" \
  "지정한 워크트리 하나에만 나간다"
assert_eq "$(grep -c '^REJECTED' "$STUB_ORCA_LOG")" "0" \
  "stop 의 모든 Orca 호출이 실물 인자 검증을 통과한다"
assert_eq "$(grep -c 'terminal close' "$STUB_ORCA_LOG")" "0" \
  "핸들 단위 terminal close 를 쓰지 않는다"

# 저장소 밖 슬러그는 셀렉터조차 만들지 않는다.
: > "$STUB_ORCA_LOG"
assert_status 1 "다른 저장소의 슬러그는 거부한다" cmd_stop other-wt
assert_eq "$(grep -c 'terminal stop' "$STUB_ORCA_LOG")" "0" \
  "다른 저장소 슬러그에는 아무 명령도 나가지 않는다"
assert_status 1 "없는 슬러그는 실패로 알린다" cmd_stop 없는슬러그
assert_status 2 "슬러그도 --all 도 없으면 사용법 오류다" cmd_stop
assert_status 2 "알 수 없는 인자는 거부한다" cmd_stop w-reap --nope

# dry-run 은 아무것도 부르지 않는다.
: > "$STUB_ORCA_LOG"
cmd_stop w-reap --dry-run >/dev/null 2>&1
assert_eq "$(grep -c 'terminal stop' "$STUB_ORCA_LOG")" "0" \
  "dry-run 은 terminal stop 을 부르지 않는다"

# 도는 워커는 --force 없이 끊지 않는다.
: > "$STUB_ORCA_LOG"
assert_status 1 "도는 워커는 --force 없이 거부한다" cmd_stop w-live
assert_eq "$(grep -c 'terminal stop' "$STUB_ORCA_LOG")" "0" \
  "거부된 stop 은 명령을 내지 않는다"
: > "$STUB_ORCA_LOG"
assert_status 0 "--force 면 도는 워커도 끊는다" cmd_stop w-live --force
assert_eq "$(grep 'terminal stop' "$STUB_ORCA_LOG" | grep -c 'w-live')" "1" \
  "--force 는 실제로 그 워크트리에 나간다"

# 보호 표시는 stop 에서도 최우선이고 --force 로도 뚫리지 않는다.
touch "$X/.worktrees/lms-base/w-keep/.orca-keep"
: > "$STUB_ORCA_LOG"
assert_status 1 "보호된 워크트리는 stop 도 거부한다" cmd_stop w-keep
assert_status 1 "--force 로도 보호를 뚫지 못한다" cmd_stop w-keep --force
assert_eq "$(grep -c 'terminal stop' "$STUB_ORCA_LOG")" "0" \
  "보호된 워크트리에는 명령이 나가지 않는다"

# 자기가 서 있는 워크트리는 끄지 않는다 — 사고의 절반이 이것이었다.
: > "$STUB_ORCA_LOG"
( cd "$X/.worktrees/lms-base/w-reap" && cmd_stop --all ) >/dev/null 2>&1
assert_eq "$(grep 'terminal stop' "$STUB_ORCA_LOG" | grep -c 'w-reap')" "0" \
  "자기가 서 있는 워크트리의 터미널은 끄지 않는다"
: > "$STUB_ORCA_LOG"
( cd "$X/.worktrees/lms-base/w-reap" && cmd_stop w-reap ) >/dev/null 2>&1
assert_eq "$(grep -c 'terminal stop' "$STUB_ORCA_LOG")" "0" \
  "슬러그를 직접 찍어도 자기 발밑은 끄지 않는다"

# --all 과 --force 는 함께 못 쓴다. 합치면 이 저장소의 도는 워커를 한 번에 끊는다 —
# reap 의 --all-merged --force 금지와 같은 관문이다.
: > "$STUB_ORCA_LOG"
assert_status 2 "--all 과 --force 는 함께 못 쓴다" cmd_stop --all --force
assert_eq "$(grep -c 'terminal stop' "$STUB_ORCA_LOG")" "0" \
  "거부된 조합은 어떤 정지 명령도 실행하지 않는다"
assert_eq "$(cmd_stop --all --force 2>&1 >/dev/null | grep -c -- '--all --dry-run')" "1" \
  "거부하면서 대신 무엇을 하라고 알려준다"
# 각각 따로는 여전히 쓸 수 있다.
assert_status 0 "--all 단독은 그대로 쓸 수 있다" cmd_stop --all --dry-run
assert_status 0 "슬러그 + --force 는 그대로 쓸 수 있다" cmd_stop w-live --force --dry-run

# --all 은 이 저장소의 워크트리만 훑는다.
: > "$STUB_ORCA_LOG"
cmd_stop --all >/dev/null 2>&1
assert_eq "$(grep -c 'terminal stop' "$STUB_ORCA_LOG")" "1" \
  "--all 은 보호·도는 워커·터미널 0을 빼고 남은 것에만 나간다"
assert_eq "$(grep 'terminal stop' "$STUB_ORCA_LOG" | grep -c 'other-project')" "0" \
  "--all 이 다른 저장소의 워크트리를 건드리지 않는다"
rm -f "$X/.worktrees/lms-base/w-keep/.orca-keep"

# 빈 셀렉터는 실물에서 **오류가 아니라 전역 목록**이다(`--worktree ""` → 머신 전체).
# 그러므로 셀렉터를 조립하는 자리마다 두 가지가 보장돼야 한다 —
# ① 값이 비면 셀렉터를 만들기 전에 멈춘다 ② 만드는 값은 항상 `id:` 로 시작한다.
: > "$STUB_ORCA_LOG"
cmd_stop --all >/dev/null 2>&1
cmd_reap w-reap --base main >/dev/null 2>&1
assert_eq "$(grep -o -E -- '--worktree [^ ]*' "$STUB_ORCA_LOG" | grep -c -v -- '--worktree id:')" "0" \
  "스크립트가 내보내는 --worktree 값은 전부 id: 로 시작한다"
assert_eq "$(grep -c -E -- '--worktree( |$)' "$STUB_ORCA_LOG" | tr -d ' ')" \
  "$(grep -c -E -- '--worktree id:[^ ]' "$STUB_ORCA_LOG" | tr -d ' ')" \
  "빈 값이나 값 없는 --worktree 를 내보내지 않는다(전역으로 새는 자리)"
# 스텁도 실물처럼 빈 셀렉터에 전역을 낸다 — 그래야 위 단언이 재는 값이 있다.
assert_eq "$("$HERE/stub-orca.sh" terminal list --worktree "" --json | jq -r '.result.terminals | length')" "4" \
  "빈 셀렉터는 오류가 아니라 전역 목록이다(실물과 같은 함정을 스텁도 갖는다)"

# repoId 를 얻지 못하면 셀렉터를 만들기 전에 멈춘다.
: > "$STUB_ORCA_LOG"
assert_status 1 "repoId 를 얻지 못하면 stop 이 중단한다" \
  env -u ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT="$X/없는최상위" \
  bash -c 'ORCA_WORKER_LIB=1 . "$0"; cmd_stop --all' "$SUT"
assert_eq "$(grep -c 'terminal stop' "$STUB_ORCA_LOG")" "0" \
  "repoId 가 없으면 어떤 정지 명령도 내보내지 않는다"

rm -f "$STUB_ORCA_LOG"; rm -rf "$X"
unset STUB_ORCA_LOG STUB_ORCA_PS_FIXTURE STUB_ORCA_WORKERS_FIXTURE STUB_ORCA_TERMINALS_FIXTURE
unset ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

# ---------------------------------------------------------------------------
# 잔해(orphan) 루프의 터미널 확인
#
# 워크트리 루프는 classify_worktree 가 터미널 생존을 보고 waiting 으로 빼 주지만,
# 잔해 루프에는 그 판정이 없어 곧장 rm -rf 로 간다.
# ---------------------------------------------------------------------------
echo "잔해 디렉터리에 붙은 터미널"
export STUB_ORCA_LOG="$(mktemp)"
Y="$(mktemp -d)"
git -C "$Y" init -q -b main
printf 'x\n' > "$Y/f.txt"; git -C "$Y" add f.txt
git -C "$Y" -c user.email=t@t -c user.name=t commit -qm base
YB="$(basename "$Y")"
mkdir -p "$Y/.worktrees/$YB/busy/node_modules" "$Y/.worktrees/$YB/dead/node_modules"
printf '{"ok":true,"result":{"worktrees":[]}}\n' > "$Y/ps.json"
# busy 에는 터미널이 붙어 있고 dead 에는 없다. 실물처럼 worktreePath 가 빈 항목도 둔다 —
# 그때는 worktreeId 의 `::<경로>` 꼬리로 판정해야 한다.
jq -n --arg b "$Y/.worktrees/$YB/busy" '
  {ok:true,result:{terminals:[
    {handle:"term_busy_1",worktreeId:("repo1::"+$b),worktreePath:$b,connected:true,preview:"<empty>"},
    {handle:"term_busy_2",worktreeId:("repo1::"+$b),worktreePath:"",connected:true,preview:"<empty>"}
  ]}}' > "$Y/terminals.json"
STUB_ORCA_PS_FIXTURE="$Y/ps.json"; STUB_ORCA_TERMINALS_FIXTURE="$Y/terminals.json"
ORCA_WORKER_REPO_ID=repo1; ORCA_WORKER_REPO_ROOT="$Y"
export STUB_ORCA_PS_FIXTURE STUB_ORCA_TERMINALS_FIXTURE ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

assert_eq "$(terminals_at_path "$Y/.worktrees/$YB/busy")" "2" \
  "worktreePath 가 비어 있어도 worktreeId 의 경로 꼬리로 센다"
assert_eq "$(terminals_at_path "$Y/.worktrees/$YB/dead")" "0" \
  "붙은 터미널이 없으면 0"
assert_eq "$(STUB_ORCA_FAIL='terminal list' terminals_at_path "$Y/.worktrees/$YB/dead")" "unknown" \
  "셀 수 없으면 0 이라고 하지 않는다(fail-open 금지)"

assert_eq "$(cmd_status --porcelain --base main | awk -F'\t' '$2=="busy"{print $1}')" "orphan-live" \
  "터미널이 붙은 잔해는 orphan-live 로 분류한다"
assert_eq "$(cmd_status --porcelain --base main | awk -F'\t' '$2=="busy"{print $4}')" "2" \
  "status 가 잔해의 터미널 수를 세어서 낸다(0 을 찍고 넘어가지 않는다)"
assert_eq "$(cmd_status --porcelain --base main | awk -F'\t' '$2=="dead"{print $1}')" "orphan" \
  "터미널이 없는 잔해는 그대로 orphan 이다"
# 이 침묵은 **의도다 — 결함으로 보고 뒤집지 마라.** orphan-live 를 미정리로 올리면 훅이 매
# 프롬프트마다 「지금은 지울 수 없는 것」을 알리게 되고, 그러면 신호 자체가 무뎌진다.
# 대신 훅이 **다른 이유로 이미 돌 때는 그 줄을 함께 낸다**(.claude/hooks/orca-worker-check.sh
# 의 case 에 orphan-live 분기가 있다. 아래 「훅이 orphan-live 를 빠뜨리지 않는다」 참고).
assert_eq "$(is_unsettled orphan-live)" "no" \
  "터미널이 붙어 있으면 미정리로 세지 않는다 — 훅이 권할 안전한 명령이 없다"
assert_eq "$(cmd_status --base main | grep -c '터미널 2개가 붙어 있다')" "1" \
  "사람이 읽는 표가 왜 제거되지 않는지 말한다"

: > "$STUB_ORCA_LOG"
assert_status 1 "터미널이 붙은 잔해는 reap 이 거부한다" cmd_reap busy --base main
assert_eq "$([ -d "$Y/.worktrees/$YB/busy" ] && printf yes || printf no)" "yes" \
  "거부된 잔해 디렉터리가 그대로 남는다"
assert_status 1 "--force 로도 뚫지 못한다" cmd_reap busy --base main --force
assert_eq "$([ -d "$Y/.worktrees/$YB/busy" ] && printf yes || printf no)" "yes" \
  "--force 여도 터미널이 붙은 디렉터리는 지우지 않는다"
cmd_reap --all-merged --base main >/dev/null 2>&1
assert_eq "$([ -d "$Y/.worktrees/$YB/busy" ] && printf yes || printf no)" "yes" \
  "--all-merged 도 건너뛴다"
assert_eq "$([ -d "$Y/.worktrees/$YB/dead" ] && printf yes || printf no)" "no" \
  "터미널이 없는 잔해는 그대로 치운다"

rm -f "$STUB_ORCA_LOG"; rm -rf "$Y"
unset STUB_ORCA_LOG STUB_ORCA_PS_FIXTURE STUB_ORCA_TERMINALS_FIXTURE
unset ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

# ---------------------------------------------------------------------------
# 자기-워크트리 가드의 심링크 정규화 (F1)
#
# $PWD 는 논리 경로이고 Orca·git 이 주는 path 는 실물 경로다. 글자로 비교하면
# 심링크를 사이에 둔 같은 디렉터리가 서로 다른 문자열이 되어 가드가 통째로 빠진다.
# **두 경로가 갈리도록 심링크를 직접 만들어야 이 갈래를 밟는다** — mktemp -d 를
# 양쪽에 다 쓰면 논리·실물이 우연히 같아져 단언이 아무것도 재지 않는다.
# ---------------------------------------------------------------------------
echo "자기-워크트리 가드의 심링크 정규화 (F1)"
export STUB_ORCA_LOG="$(mktemp)"
Z0="$(mktemp -d)"
ZR="$(cd "$Z0" && pwd -P)"          # 실물 경로
mkdir -p "$ZR/real"
ln -s "$ZR/real" "$ZR/link"         # 논리 경로 — 같은 디렉터리를 다른 글자로 가리킨다
ZB=real
git -C "$ZR/real" init -q -b main
printf 'x\n' > "$ZR/real/f.txt"; git -C "$ZR/real" add f.txt
git -C "$ZR/real" -c user.email=t@t -c user.name=t commit -qm base
git -C "$ZR/real" worktree add -q "$ZR/real/.worktrees/$ZB/w-self"  -b w-self
git -C "$ZR/real" worktree add -q "$ZR/real/.worktrees/$ZB/w-other" -b w-other

# 가드가 갈리는지부터 직접 잰다 — 논리 경로에서 부르면 옛 글자 비교는 놓친다.
assert_eq "$(cd "$ZR/link/.worktrees/$ZB/w-self" && printf '%s' "$PWD")" \
  "$ZR/link/.worktrees/$ZB/w-self" \
  "논리 경로로 cd 하면 \$PWD 가 심링크 표기 그대로다(전제 확인)"
assert_eq "$(cd "$ZR/link/.worktrees/$ZB/w-self" \
  && case "$PWD/" in ("$ZR/real/.worktrees/$ZB/w-self"/*) printf yes ;; (*) printf no ;; esac)" \
  "no" "옛 글자 비교는 같은 디렉터리를 못 알아본다(이 테스트가 재는 갈래)"
assert_status 0 "is_inside_path 는 심링크 너머로도 알아본다" \
  bash -c 'cd "$1" && ORCA_WORKER_LIB=1 . "$0" && is_inside_path "$2"' \
  "$SUT" "$ZR/link/.worktrees/$ZB/w-self" "$ZR/real/.worktrees/$ZB/w-self"
assert_status 1 "옆 워크트리는 여전히 밖이다" \
  bash -c 'cd "$1" && ORCA_WORKER_LIB=1 . "$0" && is_inside_path "$2"' \
  "$SUT" "$ZR/link/.worktrees/$ZB/w-self" "$ZR/real/.worktrees/$ZB/w-other"

# ps 픽스처는 Orca 가 주는 대로 **실물 경로**를 담는다.
jq -n --arg s "$ZR/real/.worktrees/$ZB/w-self" --arg o "$ZR/real/.worktrees/$ZB/w-other" '
  {ok:true,result:{worktrees:[
    {worktreeId:("repo1::"+$s),repoId:"repo1",path:$s,branch:"refs/heads/w-self",
     isMainWorktree:false,displayName:"w-self",liveTerminalCount:1,agents:[{state:"done"}]},
    {worktreeId:("repo1::"+$o),repoId:"repo1",path:$o,branch:"refs/heads/w-other",
     isMainWorktree:false,displayName:"w-other",liveTerminalCount:1,agents:[{state:"done"}]}
  ]}}' > "$ZR/ps.json"
printf '{"ok":true,"result":{"terminals":[]}}\n' > "$ZR/terminals.json"
STUB_ORCA_PS_FIXTURE="$ZR/ps.json"; STUB_ORCA_TERMINALS_FIXTURE="$ZR/terminals.json"
ORCA_WORKER_REPO_ID=repo1; ORCA_WORKER_REPO_ROOT="$ZR/real"
export STUB_ORCA_PS_FIXTURE STUB_ORCA_TERMINALS_FIXTURE ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

: > "$STUB_ORCA_LOG"
( cd "$ZR/link/.worktrees/$ZB/w-self" && cmd_stop --all ) >/dev/null 2>&1
assert_eq "$(grep 'terminal stop' "$STUB_ORCA_LOG" | grep -c 'w-self')" "0" \
  "심링크 경로로 서 있어도 자기 터미널은 끄지 않는다(stop)"
assert_eq "$(grep 'terminal stop' "$STUB_ORCA_LOG" | grep -c 'w-other')" "1" \
  "옆 워크트리는 그대로 정지된다(가드가 전부를 막아 통과하는 것이 아니다)"

: > "$STUB_ORCA_LOG"
( cd "$ZR/link/.worktrees/$ZB/w-self" && cmd_reap --all-merged --base main ) >/dev/null 2>&1
assert_eq "$(grep 'worktree rm' "$STUB_ORCA_LOG" | grep -c 'w-self')" "0" \
  "심링크 경로로 서 있어도 자기 워크트리를 지우지 않는다(reap)"
assert_eq "$([ -d "$ZR/real/.worktrees/$ZB/w-self" ] && printf yes || printf no)" "yes" \
  "자기 워크트리 디렉터리가 남아 있다"

: > "$STUB_ORCA_LOG"
# 잔해는 여기서 만든다 — 앞의 --all-merged 가 잔해 루프까지 돌아 먼저 치워 버린다.
mkdir -p "$ZR/real/.worktrees/$ZB/o-self/node_modules"
( cd "$ZR/link/.worktrees/$ZB/o-self" && cmd_reap o-self --base main ) >/dev/null 2>&1
assert_eq "$([ -d "$ZR/real/.worktrees/$ZB/o-self" ] && printf yes || printf no)" "yes" \
  "심링크 경로로 서 있는 잔해 디렉터리도 자기 발밑이면 지우지 않는다"

rm -f "$STUB_ORCA_LOG"; rm -rf "$Z0" "$ZR"
unset STUB_ORCA_LOG STUB_ORCA_PS_FIXTURE STUB_ORCA_TERMINALS_FIXTURE
unset ORCA_WORKER_REPO_ID ORCA_WORKER_REPO_ROOT

# ---------------------------------------------------------------------------
# 훅이 orphan-live 를 빠뜨리지 않는다 (F3)
#
# orphan-live 는 미정리가 아니라 훅을 스스로 깨우지 않는다(위 「의도」 주석).
# 그러나 훅이 **다른 것 때문에 이미 돌 때** case 에 분기가 없으면 그 줄만 조용히 빠져,
# 터미널이 붙은 잔해는 사람이 status 를 직접 칠 때만 보이게 된다.
# ---------------------------------------------------------------------------
echo "훅이 orphan-live 를 빠뜨리지 않는다 (F3)"
HOOK="$HERE/../../.claude/hooks/orca-worker-check.sh"
HK="$(mktemp -d)"
HKR="$(cd "$HK" && pwd -P)"
git -C "$HKR" init -q -b main
printf 'x\n' > "$HKR/f.txt"; git -C "$HKR" add f.txt
git -C "$HKR" -c user.email=t@t -c user.name=t commit -qm base
HKB="$(basename "$HKR")"
git -C "$HKR" worktree add -q "$HKR/.worktrees/$HKB/w-rec" -b w-rec
mkdir -p "$HKR/.worktrees/$HKB/busy/node_modules"
jq -n --arg r "$HKR/.worktrees/$HKB/w-rec" '
  {ok:true,result:{worktrees:[
    {worktreeId:("repo1::"+$r),repoId:"repo1",path:$r,branch:"refs/heads/w-rec",
     isMainWorktree:false,displayName:"w-rec",liveTerminalCount:3,agents:[{state:"done"}]}
  ]}}' > "$HKR/ps.json"
jq -n --arg b "$HKR/.worktrees/$HKB/busy" '
  {ok:true,result:{terminals:[
    {handle:"term_b1",worktreeId:("repo1::"+$b),worktreePath:$b,connected:true,preview:"<empty>"},
    {handle:"term_b2",worktreeId:("repo1::"+$b),worktreePath:$b,connected:true,preview:"<empty>"}
  ]}}' > "$HKR/terminals.json"

hook_ctx() {
  ORCA_CLI_COMMAND="$HERE/stub-orca.sh" \
  STUB_ORCA_PS_FIXTURE="$HKR/ps.json" \
  STUB_ORCA_TERMINALS_FIXTURE="$HKR/terminals.json" \
  ORCA_WORKER_REPO_ID=repo1 ORCA_WORKER_REPO_ROOT="$HKR" ORCA_WORKER_LIB= \
    bash "$HOOK" UserPromptSubmit 2>/dev/null \
    | jq -r '.hookSpecificOutput.additionalContext // ""'
}

# 전제 — status 가 두 토큰을 다 낸다(훅이 볼 입력).
assert_eq "$(ORCA_CLI_COMMAND="$HERE/stub-orca.sh" STUB_ORCA_PS_FIXTURE="$HKR/ps.json" \
  STUB_ORCA_TERMINALS_FIXTURE="$HKR/terminals.json" ORCA_WORKER_REPO_ID=repo1 \
  ORCA_WORKER_REPO_ROOT="$HKR" ORCA_WORKER_LIB= bash "$SUT" status --porcelain 2>/dev/null \
  | cut -f1 | sort | tr '\n' ',')" "orphan-live,recover," \
  "status 가 recover 와 orphan-live 를 함께 낸다(훅의 입력)"

assert_eq "$(hook_ctx | grep -c 'w-rec')" "1" \
  "훅이 다른 미정리(recover) 때문에 실제로 돈다"
assert_eq "$(hook_ctx | grep -c 'busy')" "1" \
  "훅이 이미 돌 때 orphan-live 줄을 함께 낸다"
assert_eq "$(hook_ctx | grep -c '터미널 2개')" "1" \
  "그 줄이 붙어 있는 터미널 수까지 말한다"
# orphan-live 는 미정리 수에 들어가지 않는다 — 훅을 스스로 깨우지 않는다는 계약.
assert_eq "$(ORCA_CLI_COMMAND="$HERE/stub-orca.sh" STUB_ORCA_PS_FIXTURE="$HKR/ps.json" \
  STUB_ORCA_TERMINALS_FIXTURE="$HKR/terminals.json" ORCA_WORKER_REPO_ID=repo1 \
  ORCA_WORKER_REPO_ROOT="$HKR" ORCA_WORKER_LIB= bash "$HOOK" UserPromptSubmit 2>/dev/null \
  | jq -r '.systemMessage' | grep -o -E '[0-9]+건')" "1건" \
  "미정리 건수에는 orphan-live 를 세지 않는다"

# 워커 세션에서는 침묵한다 — 훅 파일이 워크트리(`/.worktrees/`) 안에 있고 저장소를 따로 주지 않으면
# 미정리가 있어도 아무것도 내지 않는다(워커에게 자기 워크트리를 회수하라고 말하지 않게).
mkdir -p "$HKR/.worktrees/$HKB/w-rec/.claude/hooks"
cp "$HOOK" "$HKR/.worktrees/$HKB/w-rec/.claude/hooks/orca-worker-check.sh"
mkdir -p "$HKR/.worktrees/$HKB/w-rec/scripts"
cp "$SUT" "$HKR/.worktrees/$HKB/w-rec/scripts/orca-worker.sh"
assert_eq "$(ORCA_CLI_COMMAND="$HERE/stub-orca.sh" STUB_ORCA_PS_FIXTURE="$HKR/ps.json" \
  STUB_ORCA_TERMINALS_FIXTURE="$HKR/terminals.json" ORCA_WORKER_REPO_ID=repo1 ORCA_WORKER_LIB= \
  bash "$HKR/.worktrees/$HKB/w-rec/.claude/hooks/orca-worker-check.sh" UserPromptSubmit 2>/dev/null | wc -c | tr -d ' ')" "0" \
  "워크트리 안의 훅은 저장소를 따로 주지 않으면 침묵한다"

rm -rf "$HK" "$HKR"

finish

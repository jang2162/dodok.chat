#!/bin/bash
# SessionStart: 저장소가 mise.toml 로 핀한 Node·pnpm 을 이 세션의 Bash 도구 PATH 맨 앞에 둔다.
#
# 이유 — Claude Code 의 Bash 도구는 비대화형 셸이라 `mise activate` 의 프롬프트 훅이 돌지 않고,
# ~/.zshrc 가 앞세우는 ~/.local/bin(다른 도구의 node 심링크)이 mise 보다 먼저 잡힌다.
# Claude Code 는 SessionStart 훅이 $CLAUDE_ENV_FILE 에 적은 export 를 이후 Bash 호출에 적용한다.
# mise 가 없거나 핀이 없으면 조용히 통과한다. 어떤 경우에도 세션을 막지 않는다(항상 exit 0).
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$ROOT/mise.toml" ] || exit 0
command -v mise >/dev/null 2>&1 || exit 0
[ -n "${CLAUDE_ENV_FILE:-}" ] || exit 0

# 워크트리의 mise.toml 은 `mise trust` 목록에 없을 수 있다(신뢰는 경로 단위). 그러면 mise 가 아예 실행을 거부하므로
# MISE_TRUSTED_CONFIG_PATHS 로 이 디렉터리를 이 호출에 한해 신뢰한다(2026-09-15 phase1-prep 워커 실측: 훅이 조용히 실패해 Node 22).
# spawn 도 워크트리를 만들 때 `mise trust` 를 한다(대화형 셸의 mise activate 용).
node_dir="$(cd "$ROOT" && MISE_TRUSTED_CONFIG_PATHS="$ROOT" mise where node 2>/dev/null)" || exit 0
pnpm_dir="$(cd "$ROOT" && MISE_TRUSTED_CONFIG_PATHS="$ROOT" mise where npm:pnpm 2>/dev/null)" || pnpm_dir=""
prefix="$node_dir/bin"
[ -n "$pnpm_dir" ] && prefix="$prefix:$pnpm_dir/bin"
printf 'export PATH="%s:$PATH"\n' "$prefix" >> "$CLAUDE_ENV_FILE"
exit 0

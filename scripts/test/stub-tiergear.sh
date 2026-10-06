#!/bin/bash
# 테스트용 스텁 tiergear.
#   - 인자를 $STUB_TG_LOG 에 한 줄로 기록한다
#   - $STUB_TG_OUT 을 stdout 에, "tiergear: judged deep, applied deep" 를 stderr 에 낸다
#   - $STUB_TG_RC 가 있으면 그 종료코드로 끝난다(기본 0)
set -u
[ -z "${STUB_TG_LOG:-}" ] || printf '%s\n' "$*" >> "$STUB_TG_LOG"
printf 'tiergear: judged deep, applied deep\n' >&2
printf '%s\n' "${STUB_TG_OUT-claude --model opus --effort xhigh}"
exit "${STUB_TG_RC:-0}"

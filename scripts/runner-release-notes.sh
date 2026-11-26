#!/usr/bin/env bash
# 러너 GitHub 릴리스 본문 — runner-v<판본> 태그와 그 앞 runner-v* 태그 사이의 feat·fix 커밋 제목으로 만든다.
# runner-publish 워크플로가 부르고, 빠진 릴리스를 손으로 채울 때도 같은 것을 쓴다(docs/guides/runner-release.md 「GitHub 릴리스」).
# macOS 기본 bash 3.2 에서도 돌게 배열 함수(mapfile)를 쓰지 않는다.
# 쓰기: scripts/runner-release-notes.sh runner-v0.13.0 > notes.md
set -euo pipefail

tag="${1:?usage: runner-release-notes.sh runner-v<version>}"
version="${tag#runner-v}"
# 앞 태그가 없으면(첫 판) 처음부터 센다
prev="$(git describe --tags --abbrev=0 --match 'runner-v*' "${tag}^" 2>/dev/null || true)"
range="${prev:+$prev..}$tag"
max_others=20

subjects() { git log --no-merges --format='%s' "$range" "$@" | grep -E '^(feat|fix)' || true; }

# 러너 쪽 — 러너 패키지와 러너가 품는 shared 의 러너 프롬프트·계약
runner="$(subjects -- packages/claude-runner packages/shared/src/runner)"
# 러너 줄은 함께 들어간 목록에서 뺀다
if [ -n "$runner" ]; then
  others="$(subjects | grep -vxF -- "$runner" || true)"
else
  others="$(subjects)"
fi

printf '## @dodok/runner %s\n\n' "$version"
printf '```bash\nnpm i -g @dodok/runner@%s\ndodok-runner\n```\n\n' "$version"
printf '설정 → 연결의 러너 상세 「업데이트」로도 이 판으로 올린다.\n\n'
printf '### 러너\n\n'
if [ -z "$runner" ]; then
  printf -- '- 러너 코드 변경 없음(판본만 올림)\n'
else
  printf '%s\n' "$runner" | sed 's/^/- /'
fi
if [ -n "$others" ]; then
  n="$(printf '%s\n' "$others" | wc -l | tr -d ' ')"
  printf '\n### 함께 들어간 서버·웹 변경 (같은 `main`)\n\n'
  printf '%s\n' "$others" | head -n "$max_others" | sed 's/^/- /'
  if [ "$n" -gt "$max_others" ]; then printf -- '- 외 %d건\n' "$((n - max_others))"; fi
fi
if [ -n "$prev" ]; then printf '\n비교: https://github.com/jang2162/dodok.chat/compare/%s...%s\n' "$prev" "$tag"; fi

#!/usr/bin/env bash
# Caddy 앞단 검사 — 라우팅·SPA 폴백·캐시·보안 헤더를 curl 로 단언한다. 줄마다 PASS/FAIL, 하나라도 FAIL 이면 exit 1.
# 사용: bash infra/check-caddy.sh https://localhost:8443   (로컬 검증은 compose.local.yml 머리의 명령으로 띄운 뒤)
# 웹훅 토큰이 Caddy 로그에 원문으로 남지 않는지는 CADDY_LOG_CMD(Caddy 로그를 찍는 명령)를 줄 때만 본다 — 없으면 SKIP 줄. 로컬 검증은
#   CADDY_LOG_CMD='docker compose --env-file infra/local.env -f infra/compose.yml -f infra/compose.local.yml logs --no-log-prefix caddy' \
#     bash infra/check-caddy.sh https://localhost:8443
# 인증서는 검사하지 않는다(-k) — 로컬 검증은 Caddy 내부 CA 다. 운영 도메인에 쓰면 인증서 확인은 따로 한다.
# CSP 는 헤더 글자만 본다 — 정책이 앱을 깨지 않는지(위반 0)는 브라우저 검증 몫이다. 보지 않는 것: 업로드 상한(19·21 MiB)·WebSocket 연결·X-Forwarded-For 가 서버의 request.ip 로 들어가는지 — 브라우저·서버 로그 검증 몫
set -uo pipefail

origin="${1:?사용: bash infra/check-caddy.sh <https://호스트:포트>}"
origin="${origin%/}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fails=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() {
  printf 'FAIL  %s — %s\n' "$1" "$2"
  fails=$((fails + 1))
}

# GET 한 번 — $tmp/h(헤더)·$tmp/b(본문), 상태 코드를 찍는다
get() {
  : >"$tmp/h"
  : >"$tmp/b"
  curl -sk --max-time 10 -D "$tmp/h" -o "$tmp/b" -w '%{http_code}' "$origin$1" 2>/dev/null || true # 연결 실패면 curl 이 -w 로 000 을 찍는다
}
# 응답 헤더 값(이름은 대소문자 무시, 마지막 것)
header() { grep -i "^$1:" "$tmp/h" | tail -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }

# check <라벨> <경로> <기대 상태> [content-type 접두] [Cache-Control 에 들어 있어야 할 낱말]
check() {
  local label="$1" path="$2" want="$3" type="${4:-}" cache="${5:-}" code
  code="$(get "$path")"
  if [[ "$code" != "$want" ]]; then
    fail "$label" "$path → $code (기대 $want)"
    return
  fi
  if [[ -n "$type" && "$(header content-type)" != "$type"* ]]; then
    fail "$label" "$path content-type '$(header content-type)' (기대 ${type}…)"
    return
  fi
  if [[ -n "$cache" && "$(header cache-control)" != *"$cache"* ]]; then
    fail "$label" "$path Cache-Control '$(header cache-control)' (기대 $cache 포함)"
    return
  fi
  pass "$label"
}

# 상태 코드만 보면 /healthz 가 @backend 에서 빠져도 SPA 폴백의 index.html 200 으로 통과한다 — 서버가 내는 JSON 필드를 본다
check "/healthz 200 JSON (서버까지 프록시)" /healthz 200 application/json
if grep -qF '"db":"ok"' "$tmp/b"; then pass "/healthz 본문이 서버의 응답(db: ok)"; else fail "/healthz 본문이 서버의 응답(db: ok)" "본문 '$(head -c 120 "$tmp/b" | tr '\n' ' ')'"; fi
check "/ 200 HTML · no-cache" / 200 text/html no-cache
check "SPA 깊은 경로 /c/<id> 200 HTML · no-cache" /c/00000000-0000-0000-0000-000000000000 200 text/html no-cache
# 없는 API 가 SPA 폴백(index.html 200)으로 떨어지면 웹이 JSON 대신 HTML 을 파싱하다 엉뚱하게 깨진다
check "없는 /api/v1/… 는 서버의 JSON 404" /api/v1/does-not-exist 404 application/json
if grep -qi '<html' "$tmp/b"; then fail "없는 /api/v1/… 본문이 HTML 이 아니다" "본문에 <html"; else pass "없는 /api/v1/… 본문이 HTML 이 아니다"; fi
# 서버는 serveClient: false — engine.io 의 400 이 그대로 와야 서버까지 간 것이다(Caddy 의 SPA 폴백이면 200 HTML)
check "/socket.io/socket.io.js 는 서버의 400" /socket.io/socket.io.js 400
# 플러그인의 첨부 HTTP — 토큰 없이 부르면 서버가 거절한다. SPA 폴백이면 200 HTML
check "/bridge/attachments/… 는 서버로(토큰 없이 401 JSON)" /bridge/attachments/00000000-0000-0000-0000-000000000000 401 application/json
# 러너의 첨부 HTTP — 같은 규칙
check "/runner/attachments/… 는 서버로(토큰 없이 401 JSON)" /runner/attachments/00000000-0000-0000-0000-000000000000 401 application/json
# 노드 설치 안내서 — 서버가 채우는 평문. SPA 폴백이면 200 HTML 이라 content-type 과 본문의 절 제목을 본다
# 자동화 웹훅 — 모르는 토큰은 서버의 404 JSON. SPA 폴백이면 200 HTML
check "/hooks/whk_nope 는 서버로(404 JSON)" /hooks/whk_nope 404 application/json
check "/llms.txt 는 서버의 평문" /llms.txt 200 text/plain
if grep -qF '## OpenClaw Gateway 호스트' "$tmp/b"; then pass "/llms.txt 본문이 서버의 안내서"; else fail "/llms.txt 본문이 서버의 안내서" "본문 '$(head -c 120 "$tmp/b" | tr '\n' ' ')'"; fi
check "/sw.js no-cache" /sw.js 200 "" no-cache
check "/manifest.webmanifest no-cache" /manifest.webmanifest 200 "" no-cache

# 빌드 산출물 하나 — 이름에 해시가 붙어 빌드마다 달라서 index.html 에서 찾는다
get / >/dev/null
asset="$(grep -oE '/assets/[^"]+\.js' "$tmp/b" | head -1)"
if [[ -z "$asset" ]]; then
  fail "/assets/<빌드 파일> immutable" "index.html 에서 /assets/*.js 를 못 찾았다"
else
  check "/assets/<빌드 파일> immutable ($asset)" "$asset" 200 "" immutable
fi
# 없는 청크가 index.html 로 200·1년 캐시되면 옛 탭이 HTML 을 JS 로 받는다
check "없는 /assets/… 는 404(SPA 폴백 아님)" /assets/does-not-exist.js 404
# 404 도 휴리스틱 캐시 대상이다 — immutable 이 붙으면 없는 청크의 404 를 1년 보관한다
if [[ "$(header cache-control)" == *immutable* ]]; then fail "없는 /assets/… 404 는 immutable 아님" "Cache-Control '$(header cache-control)'"; else pass "없는 /assets/… 404 는 immutable 아님"; fi

# 보안 헤더 — 정적 응답과 프록시 응답 둘 다
for path in / /healthz; do
  get "$path" >/dev/null
  hsts="$(header strict-transport-security)"
  nosniff="$(header x-content-type-options)"
  referrer="$(header referrer-policy)"
  if [[ "$hsts" == *"max-age="* && "$nosniff" == "nosniff" && "$referrer" == "strict-origin-when-cross-origin" ]]; then
    pass "보안 헤더 HSTS·nosniff·Referrer-Policy ($path)"
  else
    fail "보안 헤더 HSTS·nosniff·Referrer-Policy ($path)" "HSTS='$hsts' nosniff='$nosniff' referrer='$referrer'"
  fi
  # CSP 는 강제(Report-Only 가 아니다)이고 스크립트는 'self' 만 — 인라인·eval 허용이 끼면 FAIL
  csp="$(header content-security-policy)"
  script_src="$(tr ';' '\n' <<<"$csp" | sed 's/^ *//' | grep '^script-src ' || true)"
  if [[ "$script_src" == "script-src 'self'" && "$csp" == *"default-src 'self'"* && "$csp" == *"frame-ancestors 'none'"* ]]; then
    pass "CSP 강제 · script-src 'self' 만 ($path)"
  else
    fail "CSP 강제 · script-src 'self' 만 ($path)" "Content-Security-Policy '$csp'"
  fi
done

# 웹훅 토큰 가림(Caddyfile 전역 log default 필터) — 본문을 Content-Length 보다 적게 보내고 끊으면 업스트림이 살아 있어도 Caddy 가
# 502 와 함께 오류 로그 한 줄(request.uri)을 남긴다. 가린 줄(whk_ + 6자 뒤 「…」)이 있어야 PASS — 줄이 없으면 가림을 본 것이 아니다
if [[ -n "${CADDY_LOG_CMD:-}" ]]; then
  hook_token="whk_$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' | head -c 43)"
  curl -sk --max-time 2 -o /dev/null -X POST -H 'Content-Type: text/plain' -H 'Content-Length: 1000' \
    --data-binary 'abc' "$origin/hooks/$hook_token?delivery=1" 2>/dev/null || true
  sleep 1
  bash -c "$CADDY_LOG_CMD" >"$tmp/caddy.log" 2>&1 || true
  label="웹훅 토큰이 Caddy 오류 로그에 원문으로 없다(본문 도중 끊기)"
  if grep -qF "${hook_token:10}" "$tmp/caddy.log"; then
    fail "$label" "토큰 뒷부분이 로그에 있다 — Caddyfile 의 request>uri 필터"
  elif ! grep -qF "/hooks/${hook_token:0:10}…" "$tmp/caddy.log"; then
    fail "$label" "가린 줄(/hooks/${hook_token:0:10}…)을 로그에서 못 찾았다 — CADDY_LOG_CMD 가 이 Caddy 의 로그를 찍는가"
  else
    pass "$label"
  fi
else
  printf 'SKIP  웹훅 토큰이 Caddy 오류 로그에 원문으로 없다 — CADDY_LOG_CMD 가 없어 안 봤다\n'
fi

if ((fails > 0)); then
  printf '\ncheck-caddy: %d 개 FAIL\n' "$fails"
  exit 1
fi
printf '\ncheck-caddy: 전부 PASS\n'

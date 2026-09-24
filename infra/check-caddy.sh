#!/usr/bin/env bash
# Caddy 앞단 검사 — 라우팅·SPA 폴백·캐시·보안 헤더를 curl 로 단언한다. 줄마다 PASS/FAIL, 하나라도 FAIL 이면 exit 1.
# 사용: bash infra/check-caddy.sh https://localhost:8443   (로컬 검증은 compose.local.yml 머리의 명령으로 띄운 뒤)
# 인증서는 검사하지 않는다(-k) — 로컬 검증은 Caddy 내부 CA 다. 운영 도메인에 쓰면 인증서 확인은 따로 한다.
# 보지 않는 것: 업로드 상한(19·21 MiB)·WebSocket 연결·X-Forwarded-For 가 서버의 request.ip 로 들어가는지 — 브라우저·서버 로그 검증 몫
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
done

if ((fails > 0)); then
  printf '\ncheck-caddy: %d 개 FAIL\n' "$fails"
  exit 1
fi
printf '\ncheck-caddy: 전부 PASS\n'

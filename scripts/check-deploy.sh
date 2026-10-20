#!/usr/bin/env bash
# 배포 검사 — 앱 컨테이너 하나(루트 compose.yaml)가 웹·백엔드를 바르게 내는지 curl 로 단언한다. 줄마다 PASS/FAIL/SKIP, 끝줄에
# 「PASS n / FAIL n / SKIP n」, 하나라도 FAIL 이면 exit 1. 사용(저장소 루트에서):
#
#   bash scripts/check-deploy.sh app <origin> [컨테이너]
#     이미 떠 있는 앱을 두드린다(프록시 앞이든 앱 직결이든). 컨테이너 이름이나 id 를 주면 그 컨테이너 로그(docker logs)에 웹훅·개인
#     토큰 원문이 없는지도 본다 — 서버가 LOG_LEVEL=info 이상으로 요청 줄을 남겨야 한다. 예:
#       bash scripts/check-deploy.sh app http://127.0.0.1:3000 "$(docker compose ps -q app)"
#
#   bash scripts/check-deploy.sh proxy
#     프록시 뒤 꼴을 이 머신에서 흉내 낸다 — 이름이 dodok-check-<pid> 인 네트워크(서브넷 지정)·Caddy 컨테이너(고정 IP, 내부 CA HTTPS)·
#     앱(-f compose.yaml + 임시 덮어쓰기 파일: ports !reset, 그 네트워크, TRUST_PROXY=<Caddy IP>/32)을 만들고, app 모드 검사에 더해
#     HTTPS 로그인 쿠키 Secure·WebSocket 업그레이드·20 MiB 첨부·XFF 위조 거부·config 에 호스트 포트 없음을 잰 뒤 만든 것만 지운다(trap).
#     개발용 .env 와 부딪히지 않게 임시 env 파일을 DODOK_ENV_FILE 로 준다. 호스트 포트 하나(기본 127.0.0.1:8443, DODOK_CHECK_HTTPS_PORT)
#     를 연다. 이미지는 compose 가 빌드한다(처음이면 몇 분).
#
# 보지 않는 것 — 실제 도메인 인증서(로컬은 Caddy 내부 CA 라 -k), 바깥 프록시 자신의 접근 로그 가림(앱은 막을 수 없다 —
# docs/guides/docker-deploy.md 「프록시 접근 로그」), 실기기 푸시, 브라우저에서 CSP 위반 0(헤더 글자만 본다)
set -uo pipefail

mode="${1:-}"
here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
passes=0
fails=0
skips=0

pass() {
  printf 'PASS  %s\n' "$1"
  passes=$((passes + 1))
}
fail() {
  printf 'FAIL  %s — %s\n' "$1" "$2"
  fails=$((fails + 1))
}
skip() {
  printf 'SKIP  %s — %s\n' "$1" "$2"
  skips=$((skips + 1))
}
summary() {
  printf '\ncheck-deploy %s: PASS %d / FAIL %d / SKIP %d\n' "$mode" "$passes" "$fails" "$skips"
  ((fails == 0))
}

# 요청 한 번 — $tmp/h(헤더)·$tmp/b(본문), 상태 코드를 찍는다(연결 실패면 000). 둘째 인자부터 curl 옵션
req() {
  local path="$1"
  shift
  : >"$tmp/h"
  : >"$tmp/b"
  curl -sk --max-time 20 -D "$tmp/h" -o "$tmp/b" -w '%{http_code}' "$@" "$origin$path" 2>/dev/null || true
}
# 응답 헤더 값(이름은 대소문자 무시, 마지막 것)
header() { grep -i "^$1:" "$tmp/h" | tail -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }
body_head() { head -c 160 "$tmp/b" | tr '\n' ' '; }

# check <라벨> <경로> <기대 상태> [content-type 접두] [Cache-Control 에 들어 있어야 할 낱말] — 경로 뒤 curl 옵션은 없다
check() {
  local label="$1" path="$2" want="$3" type="${4:-}" cache="${5:-}" code
  code="$(req "$path")"
  if [[ "$code" != "$want" ]]; then
    fail "$label" "$path → $code (기대 $want) 본문 '$(body_head)'"
  elif [[ -n "$type" && "$(header content-type)" != "$type"* ]]; then
    fail "$label" "$path content-type '$(header content-type)' (기대 ${type}…)"
  elif [[ -n "$cache" && "$(header cache-control)" != *"$cache"* ]]; then
    fail "$label" "$path Cache-Control '$(header cache-control)' (기대 $cache 포함)"
  else
    pass "$label"
  fi
}

rand_b64url() { head -c 48 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' | head -c "$1"; }

# 앱이 내는 것 — 프록시 앞에서든 직결이든 같다. $1 은 로그를 볼 컨테이너(없으면 SKIP)
app_checks() {
  local container="${1:-}" code asset csp script_src
  # 상태 코드만 보면 /healthz 가 SPA 폴백(index.html 200)으로 떨어져도 통과한다 — 서버의 JSON 필드를 본다
  check "/healthz 200 JSON" /healthz 200 application/json
  if grep -qF '"db":"ok"' "$tmp/b"; then pass "/healthz 본문이 서버의 응답(db: ok)"; else fail "/healthz 본문이 서버의 응답(db: ok)" "본문 '$(body_head)'"; fi
  check "/ 200 HTML · no-cache" / 200 text/html no-cache
  if grep -qi '<html' "$tmp/b"; then pass "/ 본문이 index.html"; else fail "/ 본문이 index.html" "본문 '$(body_head)'"; fi
  code="$(req / -I)"
  if [[ "$code" == 200 && "$(header cache-control)" == no-cache ]]; then pass "HEAD / 200 · no-cache"; else fail "HEAD / 200 · no-cache" "→ $code Cache-Control '$(header cache-control)'"; fi
  check "SPA 깊은 경로 /c/<id> 200 HTML · no-cache" /c/00000000-0000-0000-0000-000000000000 200 text/html no-cache
  check "/sw.js no-cache" /sw.js 200 text/javascript no-cache
  check "/manifest.webmanifest no-cache" /manifest.webmanifest 200 application/manifest+json no-cache

  # 빌드 산출물 하나 — 이름에 해시가 붙어 빌드마다 달라서 index.html 에서 찾는다
  req / >/dev/null
  asset="$(grep -oE '/assets/[^"]+\.js' "$tmp/b" | head -1)"
  if [[ -z "$asset" ]]; then
    fail "/assets/<빌드 파일> immutable" "index.html 에서 /assets/*.js 를 못 찾았다"
  else
    check "/assets/<빌드 파일> immutable ($asset)" "$asset" 200 text/javascript immutable
    code="$(req "$asset" -H 'Accept-Encoding: br, gzip')"
    if [[ "$code" == 200 && "$(header content-encoding)" == br && "$(header vary)" == *Accept-Encoding* ]]; then
      pass "/assets/<빌드 파일> 은 미리 압축한 br(Accept-Encoding: br)"
    else
      fail "/assets/<빌드 파일> 은 미리 압축한 br(Accept-Encoding: br)" "→ $code Content-Encoding '$(header content-encoding)' Vary '$(header vary)'"
    fi
  fi
  # 없는 청크가 index.html 로 200·1년 캐시되면 옛 탭이 HTML 을 JS 로 받는다. 404 도 휴리스틱 캐시 대상이라 immutable 이 붙으면 안 된다
  check "없는 /assets/… 는 404(SPA 폴백 아님)" /assets/does-not-exist.js 404
  if [[ "$(header cache-control)" == *immutable* ]]; then fail "없는 /assets/… 404 는 immutable 아님" "Cache-Control '$(header cache-control)'"; else pass "없는 /assets/… 404 는 immutable 아님"; fi

  # 백엔드 경로는 SPA 폴백을 타지 않는다 — 없는 API 가 index.html 200 이면 웹이 JSON 대신 HTML 을 파싱하다 엉뚱하게 깨진다
  check "없는 /api/v1/… 는 서버의 JSON 404" /api/v1/does-not-exist 404 application/json
  check "/socket.io/socket.io.js 는 서버(engine.io)의 400" /socket.io/socket.io.js 400
  code="$(req '/socket.io/?EIO=4&transport=polling')"
  if [[ "$code" == 200 && "$(head -c 2 "$tmp/b")" == '0{' ]]; then pass "Socket.IO 폴링 핸드셰이크 200"; else fail "Socket.IO 폴링 핸드셰이크 200" "→ $code 본문 '$(body_head)'"; fi
  check "/bridge/attachments/… 는 서버로(토큰 없이 401 JSON)" /bridge/attachments/00000000-0000-0000-0000-000000000000 401 application/json
  check "/runner/attachments/… 는 서버로(토큰 없이 401 JSON)" /runner/attachments/00000000-0000-0000-0000-000000000000 401 application/json
  check "/hooks/whk_nope 는 서버로(404 JSON)" /hooks/whk_nope 404 application/json
  code="$(req /mcp -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    --data-binary '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')"
  if [[ "$code" == 401 && "$(header content-type)" == application/json* ]] && grep -qF '"UNAUTHORIZED"' "$tmp/b"; then
    pass "/mcp 는 서버로(토큰 없이 401 JSON)"
  else
    fail "/mcp 는 서버로(토큰 없이 401 JSON)" "POST /mcp → $code content-type '$(header content-type)' 본문 '$(body_head)'"
  fi
  check "/llms.txt 는 서버의 평문" /llms.txt 200 text/plain
  if grep -qF '## OpenClaw Gateway 호스트' "$tmp/b"; then pass "/llms.txt 본문이 서버의 안내서"; else fail "/llms.txt 본문이 서버의 안내서" "본문 '$(body_head)'"; fi

  # 보안 헤더 — 정적 응답과 API 응답 둘 다. HSTS 는 https 오리진일 때만 있어야 한다
  for path in / /healthz; do
    req "$path" >/dev/null
    local hsts nosniff referrer
    hsts="$(header strict-transport-security)"
    nosniff="$(header x-content-type-options)"
    referrer="$(header referrer-policy)"
    if [[ "$nosniff" == nosniff && "$referrer" == strict-origin-when-cross-origin ]]; then
      pass "보안 헤더 nosniff·Referrer-Policy ($path)"
    else
      fail "보안 헤더 nosniff·Referrer-Policy ($path)" "nosniff='$nosniff' referrer='$referrer'"
    fi
    if [[ "$origin" == https://* ]]; then
      if [[ "$hsts" == max-age=31536000 ]]; then pass "HSTS max-age=31536000 ($path, https)"; else fail "HSTS max-age=31536000 ($path, https)" "'$hsts'"; fi
    elif [[ -z "$hsts" ]]; then
      pass "HSTS 없음 ($path, http 오리진)"
    else
      fail "HSTS 없음 ($path, http 오리진)" "'$hsts'"
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

  # 토큰 가림 — 서버 요청 로그(redactUrl)가 /hooks/ 경로와 쿼리에 잘못 실린 dpt_ 를 앞부분만 남긴다. 원문 판정은 토큰 끝 12자로 한다
  # (가림이 중간에서 멈추면 끝이 드러난다). 가린 줄이 있어야 PASS — 줄이 없으면 가림을 본 것이 아니다
  if [[ -z "$container" ]]; then
    skip "웹훅·개인 토큰이 앱 로그에 원문으로 없다" "컨테이너를 주지 않아 안 봤다"
  else
    local hook_token mcp_query
    hook_token="whk_$(rand_b64url 43)"
    mcp_query="dpt_$(rand_b64url 10)-$(rand_b64url 32)"
    req "/hooks/$hook_token" -X POST -H 'Content-Type: application/json' --data-binary '{}' >/dev/null
    req "/mcp?token=$mcp_query" -X POST -H 'Content-Type: application/json' --data-binary '{}' >/dev/null
    sleep 1
    docker logs "$container" >"$tmp/app.log" 2>&1 || true
    for pair in "/hooks/ 경로|${hook_token: -12}|/hooks/${hook_token:0:10}…" "/mcp 쿼리의 dpt_|${mcp_query: -12}|token=${mcp_query:0:10}…"; do
      IFS='|' read -r what tail masked <<<"$pair"
      if grep -qF -- "$tail" "$tmp/app.log"; then
        fail "토큰이 앱 로그에 원문으로 없다 — $what" "토큰 끝부분이 로그에 있다(apps/server/src/logger.ts redactUrl)"
      elif ! grep -qF -- "$masked" "$tmp/app.log"; then
        fail "토큰이 앱 로그에 원문으로 없다 — $what" "가린 줄($masked)을 못 찾았다 — LOG_LEVEL=info 인가, 그 컨테이너인가"
      else
        pass "토큰이 앱 로그에 원문으로 없다 — $what"
      fi
    done
  fi
}

# ── proxy 모드 ──────────────────────────────────────────────────────────────────────────────────────────────
name="dodok-check-$$"
net="$name-net"
compose() { docker compose -p "$name" --project-directory "$here" -f "$here/compose.yaml" -f "$tmp/override.yaml" "$@"; }
cleanup() {
  if [[ "$mode" == proxy ]]; then
    # 만든 것만 이름으로 지운다 — prune 을 쓰지 않는다(데몬을 다른 프로젝트와 같이 쓴다)
    docker rm -f "$name-caddy" >/dev/null 2>&1 || true
    DODOK_ENV_FILE="$tmp/check.env" compose down -v --rmi local >/dev/null 2>&1 || true
    docker network rm "$net" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

# 같은 네트워크의 다른 컨테이너에서 node fetch 로 요청을 n 번 보내고 상태 코드를 공백으로 잇는다 — 이미지는 방금 빌드한 앱 이미지
# (node 가 있다). XFF 는 요청마다 다른 문서용 주소(198.51.100.x)로 꾸민다
from_neighbor() {
  local ip="$1" url="$2" count="$3"
  docker run --rm --network "$net" --ip "$ip" --entrypoint node "$image" -e '
    const [url, count] = process.argv.slice(1);
    (async () => {
      const codes = [];
      for (let i = 0; i < Number(count); i++) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${10 + i}` },
          body: JSON.stringify({ token: "wrong-token-xxxxxxxxxxxxxxxx" }),
        });
        codes.push(res.status);
      }
      console.log(codes.join(" "));
    })().catch((e) => { console.log("error " + e.message); });
  ' "$url" "$count" 2>&1 | tail -1
}

proxy_checks() {
  local port="${DODOK_CHECK_HTTPS_PORT:-8443}" prefix="" caddy_ip neighbor_direct neighbor_via forger container code
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "검증 프록시 포트 127.0.0.1:$port" "이미 쓰이고 있다 — DODOK_CHECK_HTTPS_PORT 로 다른 포트를"
    return
  fi
  # 서브넷을 정해야 고정 IP 를 줄 수 있다 — 겹치면 다른 서브넷으로 다시
  for _ in 1 2 3 4 5; do
    prefix="10.250.$((RANDOM % 200 + 20))"
    docker network create --subnet "$prefix.0/24" "$net" >/dev/null 2>&1 && break
    prefix=""
  done
  if [[ -z "$prefix" ]]; then
    fail "검증 네트워크 만들기" "10.250.x.0/24 서브넷을 못 잡았다"
    return
  fi
  caddy_ip="$prefix.10"
  neighbor_direct="$prefix.20"
  neighbor_via="$prefix.21"
  forger="$prefix.22"
  origin="https://localhost:$port"

  local local_token
  local_token="$(rand_b64url 40)"
  cat >"$tmp/check.env" <<EOF
APP_ORIGIN=$origin
LOCAL_AUTH_TOKEN=$local_token
BETTER_AUTH_SECRET=$(rand_b64url 48)
LOG_LEVEL=info
VAPID_SUBJECT=mailto:check-deploy@example.com
EOF
  # 문서(docs/guides/docker-deploy.md)의 「컨테이너 프록시」 꼴 그대로 — 바꾸면 함께
  cat >"$tmp/override.yaml" <<EOF
services:
  app:
    ports: !reset []
    environment:
      TRUST_PROXY: "$caddy_ip/32"
    networks:
      default:
      proxy:
        aliases: [$name-app]
networks:
  proxy:
    external: true
    name: $net
EOF
  # 바깥 프록시 흉내. trusted_proxies 를 모두로 두고 X-Forwarded-For 를 명시로 덧붙인다 — nginx 의 $proxy_add_x_forwarded_for 처럼
  # 클라이언트가 꾸민 값 뒤에 진짜 주소를 붙이는 가장 흔한(가장 나쁜) 꼴이라야 앱의 판정을 잰다(덮어쓰는 프록시면 위조가 앱에 닿지 않는다)
  cat >"$tmp/Caddyfile" <<EOF
{
	local_certs
	auto_https disable_redirects
	servers {
		trusted_proxies static 0.0.0.0/0 ::/0
	}
}
(app) {
	request_body {
		max_size 32MB
	}
	reverse_proxy $name-app:3000 {
		header_up X-Forwarded-For "{http.request.header.X-Forwarded-For}, {remote_host}"
	}
}
https://localhost {
	import app
}
http://:80 {
	import app
}
EOF

  DODOK_ENV_FILE="$tmp/check.env" compose config >"$tmp/config.yaml" 2>"$tmp/config.err"
  if [[ ! -s "$tmp/config.yaml" ]]; then
    fail "compose config(덮어쓰기 포함)" "$(head -c 300 "$tmp/config.err")"
    return
  elif grep -qE '^\s+published:' "$tmp/config.yaml"; then
    fail "compose config 에 호스트 포트가 없다(ports !reset)" "$(grep -E 'published|host_ip' "$tmp/config.yaml" | tr '\n' ' ')"
  else
    pass "compose config 에 호스트 포트가 없다(ports !reset)"
  fi

  printf '…앱을 빌드하고 띄운다(%s)\n' "$name"
  if ! DODOK_ENV_FILE="$tmp/check.env" compose up -d --build --wait --wait-timeout 180 >"$tmp/up.log" 2>&1; then
    fail "앱 컨테이너 healthy" "$(tail -c 600 "$tmp/up.log")"
    return
  fi
  pass "앱 컨테이너 healthy"
  container="$(DODOK_ENV_FILE="$tmp/check.env" compose ps -q app)"
  image="$(docker inspect -f '{{.Image}}' "$container")"
  # 설정은 bind 마운트 대신 docker cp 로 넣는다 — 데몬이 VM(colima 등)·원격이면 이 임시 디렉터리가 그쪽에 없다
  if ! docker create --name "$name-caddy" --network "$net" --ip "$caddy_ip" -p "127.0.0.1:$port:443" caddy:2.11.4 \
    >/dev/null 2>"$tmp/caddy.err" ||
    ! docker cp "$tmp/Caddyfile" "$name-caddy:/etc/caddy/Caddyfile" >/dev/null 2>>"$tmp/caddy.err" ||
    ! docker start "$name-caddy" >/dev/null 2>>"$tmp/caddy.err"; then
    fail "검증 Caddy 띄우기" "$(head -c 300 "$tmp/caddy.err")"
    return
  fi
  for _ in $(seq 1 30); do
    [[ "$(req /healthz)" == 200 ]] && break
    sleep 1
  done

  app_checks "$container"

  # HTTPS 오리진이면 세션 쿠키에 Secure 가 붙는다(프록시가 X-Forwarded-Proto 를 넘기든 아니든 APP_ORIGIN 으로 정한다)
  code="$(req /api/v1/auth/local -X POST -H 'Content-Type: application/json' --data-binary "{\"token\":\"$local_token\"}")"
  local session
  session="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).sessionToken??"")}catch{}' <"$tmp/b")"
  if [[ "$code" == 200 && -n "$session" ]] && grep -i '^set-cookie:' "$tmp/h" | grep -qi '; *secure'; then
    pass "HTTPS 로그인 · 세션 쿠키 Secure"
  else
    fail "HTTPS 로그인 · 세션 쿠키 Secure" "→ $code Set-Cookie '$(grep -i '^set-cookie:' "$tmp/h" | cut -c1-40 | tr -d '\r')…'"
  fi

  # WebSocket 업그레이드가 프록시를 지나는가 — 101 이면 된다(그 뒤 wire 인증은 앱 몫)
  code="$(curl -sk --http1.1 --max-time 5 -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: $origin" \
    "$origin/socket.io/?EIO=4&transport=websocket" 2>/dev/null || true)"
  if [[ "$code" == 101 ]]; then pass "WebSocket 업그레이드 101(/socket.io)"; else fail "WebSocket 업그레이드 101(/socket.io)" "→ $code"; fi

  # 에이전트 파일 상한(20 MiB) 그대로가 프록시를 지나 앱에 저장된다 — Gateway(닿지 않는 주소로)·채널·브리지 토큰을 만들어 올린다
  if [[ -z "$session" ]]; then
    skip "20 MiB 첨부 업로드" "로그인이 안 돼 못 했다"
  else
    local auth=(-H "Authorization: Bearer $session" -H 'Content-Type: application/json')
    local gateway channel bridge
    req /api/v1/gateways -X POST "${auth[@]}" --data-binary '{"name":"check","url":"wss://host.invalid:9","token":"t"}' >/dev/null
    gateway="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).id??"")}catch{}' <"$tmp/b")"
    req /api/v1/channels -X POST "${auth[@]}" --data-binary '{"name":"check-deploy"}' >/dev/null
    channel="$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write((j.channel??j).id??"")}catch{}' <"$tmp/b")"
    req "/api/v1/gateways/$gateway/bridge-tokens" -X POST "${auth[@]}" --data-binary '{"label":"check-deploy"}' >/dev/null
    bridge="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).token??"")}catch{}' <"$tmp/b")"
    if [[ -z "$gateway" || -z "$channel" || -z "$bridge" ]]; then
      fail "20 MiB 첨부 업로드" "준비 실패 gateway='$gateway' channel='$channel' 토큰 $([[ -n "$bridge" ]] && echo 있음 || echo 없음) — 마지막 본문 '$(body_head)'"
    else
      head -c $((20 * 1024 * 1024)) /dev/urandom >"$tmp/big.bin"
      code="$(req /bridge/attachments -X POST -H "Authorization: Bearer $bridge" -H "x-dodok-channel-id: $channel" \
        -H 'x-dodok-file-name: big.bin' -H 'Content-Type: application/octet-stream' --data-binary "@$tmp/big.bin")"
      if [[ "$code" == 200 ]] && grep -qF '"size":20971520' "$tmp/b"; then
        pass "20 MiB 첨부 업로드(프록시 → 앱 저장)"
      else
        fail "20 MiB 첨부 업로드(프록시 → 앱 저장)" "→ $code 본문 '$(body_head)'"
      fi
    fi
  fi

  # 클라이언트 IP 위조 — 로컬 로그인 상한(분당 5)을 XFF 로 돌려 피하지 못한다
  local codes
  codes="$(from_neighbor "$forger" "http://$caddy_ip/api/v1/auth/local" 6)"
  if [[ "$codes" == "401 401 401 401 401 429" ]]; then
    pass "프록시를 거친 XFF 위조로 로그인 상한을 못 넘는다($codes)"
  else
    fail "프록시를 거친 XFF 위조로 로그인 상한을 못 넘는다" "응답 '$codes'(기대 401×5 → 429)"
  fi
  # 앱이 프록시의 XFF 를 믿기는 하는가 — 다 무시하면 모든 요청이 Caddy 주소 하나로 묶여 방금 막힌 버킷에 걸린다(429)
  codes="$(from_neighbor "$neighbor_via" "http://$caddy_ip/api/v1/auth/local" 1)"
  if [[ "$codes" == "401" ]]; then
    pass "프록시 뒤 다른 클라이언트는 따로 센다($codes)"
  else
    fail "프록시 뒤 다른 클라이언트는 따로 센다" "응답 '$codes'(기대 401)"
  fi
  # 프록시가 아닌 같은 네트워크 컨테이너가 앱에 직접 보낸 XFF 는 무시된다 — 그 컨테이너 주소로 센다
  codes="$(from_neighbor "$neighbor_direct" "http://$name-app:3000/api/v1/auth/local" 6)"
  if [[ "$codes" == "401 401 401 401 401 429" ]]; then
    pass "믿지 않는 이웃이 앱에 직접 보낸 XFF 는 무시된다($codes)"
  else
    fail "믿지 않는 이웃이 앱에 직접 보낸 XFF 는 무시된다" "응답 '$codes'(기대 401×5 → 429)"
  fi
}

case "$mode" in
  app)
    origin="${2:?사용: bash scripts/check-deploy.sh app <origin> [컨테이너]}"
    origin="${origin%/}"
    app_checks "${3:-}"
    ;;
  proxy)
    proxy_checks
    ;;
  *)
    echo "사용: bash scripts/check-deploy.sh app <origin> [컨테이너] | proxy" >&2
    exit 2
    ;;
esac
summary

/**
 * `GET /api/v1/setup/plugin-install.sh` 의 본문 — Gateway 호스트가 `curl … | DODOK_BRIDGE_TOKEN='dbt_…' bash` 한 줄로 돌리는 설치
 * 스크립트(설치 한 줄 명령 스펙 2026-11-02 「2. 스크립트가 하는 일」). 서버가 부팅 때 `llms.txt` 처럼 한 번 렌더한다. 본문에는 이미
 * `/llms.txt` 로 공개된 값(공개 오리진·bridgeUrl·두 sha256)만 들어간다 — 토큰은 실행하는 사람의 환경 변수로만 온다.
 *
 * ⚠ 토큰은 어떤 외부 명령의 argv 에도 싣지 않는다 — curl 은 `-K -`(표준 입력의 설정), 계정 설정은 `openclaw config patch --stdin`,
 * 둘 다 셸 내장 `printf` 가 쓴다(`ps` 에 보이지 않는다). 본문 전체는 함수 하나이고 맨 끝 줄에서만 부른다 — `curl | bash` 가 도중에
 * 끊기면 함수 정의만 남고 아무것도 돌지 않는다. bash 3.2(macOS 기본)에서도 돌게 `[[ =~ ]]`·연관 배열을 쓰지 않는다.
 * 동작은 `test/setup.plugin-install-script.test.ts` 가 가짜 openclaw·curl 위에서 bash 로 그대로 돌려 잰다
 */
import { PLUGIN_INSTALL_SCRIPT_PATH } from "@dodok/shared";
import type { LlmsFileInfo } from "./llms";

export type PluginInstallScriptInput = {
  /** 공개 오리진(`https://…`) — 스크립트가 plugin.tgz 를 이 위에서 받는다 */
  origin: string;
  /** 플러그인 계정 설정의 bridgeUrl */
  bridgeUrl: string;
  /** 서버가 품은 플러그인 tgz 의 두 해시 */
  plugin: LlmsFileInfo;
};

/** 셸 작은따옴표 값 — 공개 주소·hex 라 정상 입력에는 따옴표·줄바꿈이 없다. 있으면 스크립트를 깨뜨리므로 렌더를 멈춘다 */
function quote(name: string, value: string): string {
  if (/['\n\r]/.test(value)) throw new Error(`plugin-install.sh: ${name} 에 셸에 넣을 수 없는 글자가 있다`);
  return `'${value}'`;
}

export function renderPluginInstallScript(input: PluginInstallScriptInput): string {
  const { origin, bridgeUrl, plugin } = input;
  return `#!/usr/bin/env bash
# dodok — OpenClaw 채널 플러그인 설치·업데이트(${origin})
#
# Gateway 호스트에서 설정 → 연결의 그 Gateway 화면 「새 토큰 발급」이 주는 한 줄로 돌린다:
#    (set -o pipefail; curl -fsS ${origin}${PLUGIN_INSTALL_SCRIPT_PATH} | DODOK_BRIDGE_TOKEN='dbt_…' bash)
#
# 하는 일: 플러그인 받기 → 파일 sha256 대조 → Gateway 서비스 확인·내리기(openclaw gateway status·stop) → 설치 → 로드·번들 sha256 대조
#          → 계정 설정(bridgeUrl·토큰, openclaw config patch --stdin) → Gateway 올리기(openclaw gateway start).
# Gateway 를 내린 뒤 실패하면 Gateway 를 다시 올리고 실패로 끝난다.
# Gateway 가 서비스(systemd·launchd)가 아니면 직접 내린 뒤 bash 앞에 DODOK_GATEWAY_SERVICE=0 을 붙여 돌리고, 끝나면 직접 올린다.
# 토큰은 환경 변수 DODOK_BRIDGE_TOKEN 으로만 받고 어떤 명령의 인자에도 싣지 않는다.
# 본문 전체가 함수 하나이고 맨 끝 줄에서만 부른다 — 받다가 끊기면 아무것도 하지 않는다.

dodok_plugin_install() {
  set -u
  dodok_origin=${quote("origin", origin)}
  dodok_bridge_url=${quote("bridgeUrl", bridgeUrl)}
  dodok_file_sha=${quote("sha256", plugin.sha256)}
  dodok_bundle_sha=${quote("bundleSha256", plugin.bundleSha256)}
  dodok_stopped=0
  dodok_dir=""

  dodok_say() { printf 'dodok: %s\\n' "$*"; }
  dodok_err() { printf 'dodok: %s\\n' "$*" >&2; }
  # 실패 — Gateway 를 이 스크립트가 내렸으면 다시 올리고 0 이 아닌 코드로 끝난다
  dodok_fail() {
    dodok_err "$@"
    if [ "$dodok_stopped" = 1 ]; then
      dodok_stopped=0
      dodok_err "Gateway 를 다시 올립니다(openclaw gateway start)."
      openclaw gateway start </dev/null ||
        dodok_err "Gateway 를 올리지 못했습니다 — openclaw gateway start 를 직접 돌리세요."
    fi
    exit 1
  }
  dodok_cleanup() {
    if [ -n "$dodok_dir" ]; then rm -rf "$dodok_dir"; fi
  }
  trap dodok_cleanup EXIT
  trap 'dodok_fail "중단했습니다."' INT TERM

  dodok_token="\${DODOK_BRIDGE_TOKEN:-}"
  unset DODOK_BRIDGE_TOKEN

  # 1. 전제 — 토큰 꼴(dbt_ + 43자)과 도구
  dodok_bad_token="DODOK_BRIDGE_TOKEN 이 비었거나 브리지 토큰(dbt_…) 꼴이 아닙니다 — 설정 → 연결의 그 Gateway 화면에서 「새 토큰 발급」이 주는 명령을 그대로 붙여 넣으세요."
  case "$dodok_token" in dbt_*) ;; *) dodok_fail "$dodok_bad_token" ;; esac
  case "\${dodok_token#dbt_}" in *[!A-Za-z0-9_-]*) dodok_fail "$dodok_bad_token" ;; esac
  [ "\${#dodok_token}" -eq 47 ] || dodok_fail "$dodok_bad_token"
  for dodok_tool in openclaw curl node mktemp; do
    command -v "$dodok_tool" >/dev/null 2>&1 || dodok_fail "$dodok_tool 명령이 없습니다 — 이 호스트의 PATH 에 두고 다시 돌리세요."
  done
  if command -v sha256sum >/dev/null 2>&1; then
    dodok_sha_tool="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    dodok_sha_tool="shasum -a 256"
  else
    dodok_fail "sha256sum 도 shasum 도 없습니다 — 받은 파일을 대조할 수 없어 멈춥니다."
  fi
  dodok_sha() {
    dodok_sum="$($dodok_sha_tool "$1" </dev/null)" || return 1
    printf '%s' "\${dodok_sum%% *}"
  }

  # 2. 임시 자리 — 끝나면(실패해도) trap 이 지운다
  dodok_dir="$(mktemp -d "\${TMPDIR:-/tmp}/dodok.XXXXXX")" || dodok_fail "임시 디렉터리를 만들지 못했습니다."
  dodok_tgz="$dodok_dir/dodok-openclaw-plugin.tgz"

  # 3. 받기 — 토큰은 curl 의 표준 입력(-K -)으로만 간다
  dodok_say "플러그인을 받습니다: $dodok_origin/api/v1/setup/plugin.tgz"
  dodok_code="$(printf 'header = "Authorization: Bearer %s"\\n' "$dodok_token" |
    curl -sS -o "$dodok_tgz" -w '%{http_code}' -K - "$dodok_origin/api/v1/setup/plugin.tgz")" ||
    dodok_fail "플러그인을 받지 못했습니다(curl) — 이 호스트에서 $dodok_origin 에 닿는지 보세요."
  case "$dodok_code" in
    200) ;;
    401) dodok_fail "토큰이 틀렸거나 폐기됐습니다(401) — 설정 → 연결의 그 Gateway 화면에서 토큰을 새로 발급해 그 명령을 다시 돌리세요." ;;
    404) dodok_fail "서버에 플러그인 파일이 없습니다(404 PLUGIN_FILE_MISSING) — 서버 관리자가 플러그인 파일을 만들고 서버를 다시 띄워야 합니다." ;;
    409) dodok_fail "서버의 플러그인 파일이 서버가 뜬 뒤 다시 빌드됐습니다(409) — 서버를 재시작한 뒤 이 명령을 다시 돌리세요." ;;
    429) dodok_fail "요청이 너무 많습니다(429) — 잠시 뒤 다시 돌리세요." ;;
    *) dodok_fail "플러그인을 받지 못했습니다(HTTP $dodok_code)." ;;
  esac

  # 4. 파일 sha256 — 어긋나면 Gateway 를 건드리기 전에 멈춘다
  dodok_got="$(dodok_sha "$dodok_tgz")" || dodok_fail "받은 파일의 sha256 을 재지 못했습니다."
  [ "$dodok_got" = "$dodok_file_sha" ] ||
    dodok_fail "받은 파일의 sha256($dodok_got)이 서버가 알린 값($dodok_file_sha)과 다릅니다 — 설치하지 않고 멈춥니다(Gateway 는 그대로)."

  # 5. Gateway 내리기 — 떠 있는 Gateway 에 설치하면 파일이 바뀌지 않을 수 있다
  if [ "\${DODOK_GATEWAY_SERVICE:-1}" = 0 ]; then
    dodok_say "DODOK_GATEWAY_SERVICE=0 — Gateway 를 내리고 올리는 일은 하지 않습니다(이미 직접 내려 두었어야 합니다)."
  else
    dodok_not_service="Gateway 가 서비스(systemd·launchd)가 아니면 직접 내린 뒤, 같은 명령의 bash 앞에 DODOK_GATEWAY_SERVICE=0 을 붙여(… | DODOK_GATEWAY_SERVICE=0 DODOK_BRIDGE_TOKEN='…' bash) 다시 돌리고 끝나면 직접 올리세요."
    # 서비스인지 먼저 잰다 — 서비스가 없으면 gateway stop 은 실패하지 않고 떠 있는 비관리 Gateway 를 내리는데, 그것은 gateway start 로 다시 올릴 수 없다
    dodok_status="$(openclaw gateway status --json --no-probe </dev/null)" ||
      dodok_fail "Gateway 서비스 상태를 읽지 못해(openclaw gateway status) 설치하지 않았습니다. $dodok_not_service"
    printf '%s' "$dodok_status" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const j = JSON.parse(s.slice(s.indexOf("{")));
  process.exit(j.service && j.service.loaded === true ? 0 : 1);
});' || dodok_fail "이 호스트의 Gateway 가 서비스로 깔려 있지 않아 설치하지 않았습니다(아무것도 바꾸지 않았습니다). $dodok_not_service"
    dodok_say "Gateway 를 내립니다(openclaw gateway stop)."
    # stop 이 실패해도 반쯤 내려갔을 수 있다 — 먼저 내린 것으로 쳐서, 실패하면 dodok_fail 이 start 를 한 번 시도한다
    dodok_stopped=1
    openclaw gateway stop --force </dev/null ||
      dodok_fail "Gateway 서비스를 내리지 못해 설치하지 않았습니다. $dodok_not_service"
  fi

  # 6. 설치
  dodok_say "플러그인을 설치합니다(openclaw plugins install)."
  openclaw plugins install "$dodok_tgz" --force --accept-capabilities </dev/null ||
    dodok_fail "플러그인 설치에 실패했습니다(openclaw plugins install)."

  # 7. 로드 확인과 번들 sha256 — 번들 자리는 inspect 의 rootDir, 없으면 상태 디렉터리의 기본 자리
  dodok_inspect="$(openclaw plugins inspect dodok --json </dev/null)" ||
    dodok_fail "설치한 플러그인을 확인하지 못했습니다(openclaw plugins inspect dodok)."
  dodok_root="$(printf '%s' "$dodok_inspect" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const p = JSON.parse(s.slice(s.indexOf("{"))).plugin || {};
  if (p.status !== "loaded" || !(p.channelIds || []).includes("dodok")) process.exit(1);
  process.stdout.write(typeof p.rootDir === "string" ? p.rootDir : "");
});')" || dodok_fail "플러그인이 로드되지 않았습니다(openclaw plugins inspect dodok 의 status 가 loaded, channelIds 에 dodok 이 아님)."
  if [ -n "$dodok_root" ]; then
    dodok_bundle="$dodok_root/dist/index.js"
  else
    dodok_bundle="\${OPENCLAW_STATE_DIR:-\${OPENCLAW_HOME:-$HOME}/.openclaw}/extensions/dodok/dist/index.js"
  fi
  [ -f "$dodok_bundle" ] ||
    dodok_fail "설치된 번들을 찾지 못했습니다: $dodok_bundle — 상태 디렉터리가 다르면 OPENCLAW_STATE_DIR 을 주고 다시 돌리세요."
  dodok_got="$(dodok_sha "$dodok_bundle")" || dodok_fail "설치된 번들의 sha256 을 재지 못했습니다."
  [ "$dodok_got" = "$dodok_bundle_sha" ] ||
    dodok_fail "설치된 번들($dodok_bundle)의 sha256($dodok_got)이 서버가 품은 빌드($dodok_bundle_sha)와 다릅니다."

  # 8. 계정 설정 — 토큰은 openclaw 의 표준 입력으로만 간다
  dodok_say "계정 설정(bridgeUrl·토큰)을 넣습니다(openclaw config patch --stdin)."
  printf '{"channels":{"dodok":{"accounts":{"default":{"bridgeUrl":"%s","token":"%s"}}}}}\\n' "$dodok_bridge_url" "$dodok_token" |
    openclaw config patch --stdin ||
    dodok_fail "계정 설정을 넣지 못했습니다(openclaw config patch). 이번에 발급한 토큰은 쓰이지 않았으니 설정 → 연결의 그 Gateway 화면에서 폐기하세요."
  dodok_token=""

  # 9. Gateway 올리기
  if [ "$dodok_stopped" = 1 ]; then
    dodok_say "Gateway 를 올립니다(openclaw gateway start)."
    dodok_stopped=0
    openclaw gateway start </dev/null ||
      { dodok_err "설치는 끝났지만 Gateway 를 올리지 못했습니다 — openclaw gateway start 를 직접 돌리세요."; exit 1; }
  else
    dodok_say "설치가 끝났습니다. Gateway 를 직접 올리세요."
  fi
  dodok_say "끝 — 설정 → 연결의 그 Gateway 화면에서 「플러그인」이 「접속됨」·「서버와 같은 빌드입니다」인지 보세요."
  dodok_say "그 Gateway 화면에 기기 페어링 대기가 보이면 openclaw devices approve <요청 id>. 옛 토큰이 있으면 「이제 폐기해도 됩니다」가 뜬 뒤 폐기하세요."
}

dodok_plugin_install "$@"
`;
}

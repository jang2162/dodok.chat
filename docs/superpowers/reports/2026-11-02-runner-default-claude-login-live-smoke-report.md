# 러너 평소 claude 로그인 실연 — 2026-11-02 결과 (runner-default-claude-login, 계획 태스크 7, 모델 런 0회)

> 러너가 `configDir` 없이 이 머신의 평소 Claude Code 로그인을 찾는지와 웹의 표시를 잰 기록 — 계획 `docs/superpowers/plans/2026-11-02-runner-default-claude-login.md` 태스크 7, 스펙 `docs/superpowers/specs/2026-11-02-runner-default-claude-login-design.md` 7장. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다.

**판정: 둘 다 통과, 결함 0.**

## 1. 평소 로그인이 잡히는지 (사람 승인 뒤, 모델 호출 없음)

- 방법: ADR 0007 7의 8 과 같다 — 러너 소스의 `applyClaudeConfigDirEnv`(configDir 없는 `programs.claude`)와 `ENV_ALLOWLIST` 로 러너와 같은 CLI env 를 만들고, 사용자 메시지를 보내지 않는 프롬프트로 `query()` 를 열어 `accountInfo()` 의 `subscriptionType`·`apiProvider` 만 적은 뒤 `close()`. `settingSources: []`·`strictMcpConfig: true`·`persistSession: false`, `cwd` 는 임시 디렉터리. 러너를 띄운 셸에 `CLAUDE_CONFIG_DIR` 은 없었다(`env -u`).
- SDK 0.3.283 · 번들 CLI 2.1.283.
- 결과: CLI env 에 `CLAUDE_CONFIG_DIR` 없음, `ANTHROPIC_*` 키 0개 → `subscriptionType: Claude Max` · `apiProvider: firstParty`. 평소 `~/.claude` 로그인(키체인)이 해시 없는 항목 이름으로 그대로 잡힌다. 이메일·조직은 출력하지도 적지도 않았다.

## 2. 웹 표시 (dev:fake, 런 0회)

- `PORT=3317 APP_ORIGIN=http://rdcl.localhost:5317 pnpm -F @dodok/server dev:fake` + `DODOK_API_ORIGIN=http://127.0.0.1:3317 vite --port 5317 --host 127.0.0.1`, BrowserOS neo 로 `http://rdcl.localhost:5317`(호스트를 갈라 다른 워크트리와 세션 쿠키가 겹치지 않게).
- 「러너」 탭: 「dev-fake」 카드 `Claude Code 2.1.283 · 로그인됨 (평소 로그인) · 권한 상한 acceptEdits`, 「dev-fake 제한」 카드 `Claude Code 2.1.283 · 로그인됨 (전용 로그인) · 권한 상한 plan · 허용 도구 상한 Read, Grep, Glob`.
- 연결 페이지 「설치」 2단계: 평소 로그인 본문·`claude`·번들 CLI(접두사 없음)·이메일/`--resume` 경고, 접힌 「러너 전용 로그인을 따로 쓰려면」을 펼치면 `CLAUDE_CONFIG_DIR=~/.dodok-runner/claude claude`·번들 CLI 판·`"configDir": "~/.dodok-runner/claude"` 안내.

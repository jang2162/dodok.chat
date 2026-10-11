# browseros-neo 세팅

## 확인

- `git check-ignore -q .playwright-mcp/x && echo ignored` 가 `ignored` 를 낸다.

## 세팅

1. `.gitignore` 에 `.playwright-mcp/` 가 없으면 더한다. Ruler 블록(`# START Ruler Generated Files` … `# END Ruler Generated Files`)이 있으면 그 바깥에 쓴다 — 블록 안은 `ruler apply` 가 다시 쓴다.
   ```gitignore
   # Playwright MCP 페이지 스냅샷과 스크린샷
   /.playwright-mcp/
   ```
   Playwright MCP(`@playwright/mcp`, `playwright-neo` 포함)는 확인할 때마다 작업 디렉터리의 `.playwright-mcp/` 에 스냅샷과 스크린샷을 쓴다. 가리지 않으면 추적되지 않은 파일이 쌓여 `git status` 를 덮고, 경로를 지정하지 않는 커밋에 섞인다.
2. 이미 추적 중인 파일이 있으면(`git ls-files .playwright-mcp`) 목록을 사용자에게 보이고, 확인을 받아 `git rm -r --cached .playwright-mcp` 로 추적에서 뺀다.

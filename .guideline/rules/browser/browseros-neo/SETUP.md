# browseros-neo 세팅

## 확인

- `git check-ignore -q .playwright-mcp/x && echo ignored` 가 `ignored` 를 낸다(`.gitignore` 든 `info/exclude` 든).

## 세팅

**개인 범위로 받았으면(`guideline pick --local`) 커밋되는 `.gitignore` 를 고치지 않는다.** 같은 줄을 `"$(git rev-parse --git-common-dir)/info/exclude"` 에 쓴다 — 클론의 모든 워크트리가 함께 읽고 커밋되지 않는다. 프로젝트가 이 스택을 고른 것이면 아래대로 `.gitignore` 에 쓴다.

1. `.gitignore` 에 `.playwright-mcp/` 가 없으면 더한다. 도구가 관리하는 블록(`# START guideline generated files` … `# END guideline generated files`, `# START Ruler Generated Files` … `# END Ruler Generated Files`)이 있으면 그 바깥에 쓴다 — 블록 안은 `guideline apply` 와 ruler 가 다시 쓴다.
   ```gitignore
   # Playwright MCP 페이지 스냅샷과 스크린샷
   /.playwright-mcp/
   ```
   Playwright MCP(`@playwright/mcp`, `playwright-neo` 포함)는 확인할 때마다 작업 디렉터리의 `.playwright-mcp/` 에 스냅샷과 스크린샷을 쓴다. 가리지 않으면 추적되지 않은 파일이 쌓여 `git status` 를 덮고, 경로를 지정하지 않는 커밋에 섞인다.
2. 이미 추적 중인 파일이 있으면(`git ls-files .playwright-mcp`) 목록을 사용자에게 보이고, 확인을 받아 `git rm -r --cached .playwright-mcp` 로 추적에서 뺀다.

# BrowserOS neo 가 있을 때

## BrowserOS neo 가 깔려 있으면 neo 로 본다

`browser` 스택 「무엇이 붙어 있는지 먼저 확인하고 고른다」 의 **고르는 순서만** 바꾼다 — `/Applications/BrowserOS neo.app` 이 있으면 화면 확인은 neo(`mcp__browseros-neo__*`)로 하고, neo 가 없을 때만 그 절의 순서로 고른다. 도구가 없을 때 검증을 건너뛰지 않는 것, 한계에 걸리면 버리지 말고 얹는 것은 그 스택을 따른다.

- **Why:** neo 는 에이전트 전용으로 띄워 둔 **로그인이 살아 있는 실제 브라우저**다. 다른 도구로 새 브라우저를 띄우면 그 로그인과 프로필을 잃고, 사람의 브라우저에 붙는 도구는 사람의 탭과 섞인다.
- **How to apply:**
  - **꺼져 있으면 에이전트가 켠다** — 화면을 뺏지 않게 `-g` 를 준다. MCP 가 열릴 때까지 기다린다(406 이 정상 응답이다). 포트는 neo 설정(`~/Library/Application Support/BrowserClaw/.browseros/config.json`)의 `ports.proxy` 다.
    ```bash
    open -g -a "BrowserOS neo"
    curl -s -o /dev/null -w '%{http_code}\n' --max-time 40 --retry 40 --retry-delay 1 \
      --retry-connrefused http://127.0.0.1:9010/mcp
    ```
  - **세션을 열기 전에 켜 둔다.** 세션이 시작될 때 꺼져 있었으면 켜도 이 세션에는 붙지 않는다 — 고장을 가르는 법은 `browser` 스택 「브라우저 서버가 안 붙을 때」. 앱을 로그인 항목에 넣어 두면 이 조건을 매번 기억하지 않아도 된다.
  - **새 탭은 백그라운드로 연다.** `tabs action="new"` 에는 `background: true` 를 준다. `run` 의 `browser.pages.newPage(url)` 은 기본이 백그라운드다. `windows action="create"` 에는 백그라운드 옵션이 없으니 창 대신 탭으로 연다.
  - neo 가 못 하는 확인(콘솔 `log`, 첫 로드 콘솔, 네트워크, 뷰포트)이면 **neo 에 Playwright 를 얹는다** — 이 스택 「neo 가 못 하는 다섯 가지」·「Playwright 를 neo 에 붙일 때」. 렌더(애니메이션·캔버스)를 재거나 다른 계정의 둘째 클라이언트가 필요한 검증은 neo 가 아니라 독립 브라우저로 한다 — `browser` 스택 「페이지 자동화 도구를 얹을 때」 의 예외.

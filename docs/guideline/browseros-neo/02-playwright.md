# Playwright 를 neo 에 붙일 때

## neo 의 CDP 포트는 neo 설정의 `ports.cdp` 이고, 상시로 쓸 거면 `playwright-neo` MCP 로 붙인다

neo 는 CDP 를 열어 두고 있다. 포트는 `~/Library/Application Support/BrowserClaw/.browseros/config.json` 의 `ports.cdp` 다(기본 `9110`). 원리(새 브라우저를 띄우지 않는다, 붙기 전에 page 대상을 본다, 한 탭을 양쪽에서 만지지 않는다)는 `browser` 스택 「페이지 자동화 도구를 얹을 때」 가 갖는다.

- **Why:** 같은 브라우저·같은 프로필·같은 로그인을 그대로 쓰면서 neo 가 못 하는 다섯 가지 중 앞의 넷이 전부 열린다(보이지 않는 탭의 렌더는 그대로다 — 탭을 백그라운드로 열기 때문) — 첫 로드 콘솔, 요청마다 메서드와 상태 코드, WebSocket 프레임, `setViewportSize` 로 미디어쿼리 발화.
- **How to apply:**
  - 상시로 쓰면 MCP 서버 `playwright-neo` 를 프로젝트에 둔다(문서 저장소 `mcp/playwright-neo/`). 커밋된 설정이라 워커 세션도 같은 것을 받는다. 세션이 시작될 때 읽히므로 항목을 바꿨으면 세션을 새로 연다.
  - 한 번만 필요하면 `playwright-core` 로 붙는다. 끝낼 때 `close()` 는 **연결만 끊는다** — neo 는 살아 있다.
    ```js
    import { chromium } from 'playwright-core';
    const b = await chromium.connectOverCDP('http://127.0.0.1:9110');
    const page = await b.contexts()[0].newPage();   // neo 의 기존 컨텍스트
    // ...
    await b.close();
    ```
  - 포트가 기본값과 다른 머신이면 설정 파일에서 읽어 쓴다 — 포트를 추정하지 않는다.

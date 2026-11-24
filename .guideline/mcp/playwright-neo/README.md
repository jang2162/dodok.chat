---
categories: [browser]
requires: [rules/browser/browseros-neo]
---

# playwright-neo

Playwright MCP 서버(`@playwright/mcp`)를 **새 브라우저를 띄우지 않고** BrowserOS neo 의 CDP 에 붙인다. neo 의 로그인·프로필을 그대로 쓰면서 neo 가 못 하는 확인(첫 로드 콘솔, 상태 코드가 보이는 네트워크, WebSocket 프레임, 뷰포트 변경)을 한다.

## 맞는 스택·프로젝트

`browser/browseros-neo` 스택을 받는 작업자(개인 범위). 이유와 쓰는 때는 그 스택 「Playwright 를 neo 에 붙일 때」.

## 환경 변수

필요 없다.

- `--cdp-endpoint` 의 포트는 neo 설정(`~/Library/Application Support/BrowserClaw/.browseros/config.json`)의 `ports.cdp` 이다. `server.json` 이 `sh -c` 로 이 파일을 읽어 포트를 정하고(`node` 를 쓴다), 파일이 없거나 값이 없으면 기본값 `9110` 을 쓴다. 머신마다 포트가 달라도 항목을 고치지 않는다.
- `--isolated`·`--browser` 를 더하지 않는다. 새 브라우저가 떠서 neo 의 로그인을 잃는다.
- neo 가 꺼져 있으면 도구 호출이 연결 실패로 떨어진다. neo 를 켜면 다음 호출부터 붙는다.

# 브라우저로 화면을 확인할 때

화면을 눈으로 봐야 판단이 서는 검증에서 **이 저장소에만 해당하는 것**을 적는 문서다.
**누가 그 검증을 하는가**는 [워크트리 작업 흐름](worktree-workflow.md) 「예외 — 워커가 가질 수 없는 자원이 필요한 검증」이 갖는다.

**도구를 고르는 순서와 공통 원리는 여기 없다.** `CLAUDE.md` 「BrowserOS neo 가 깔려 있으면 neo 로 본다」(상시)와
`docs/guideline/browser/`·`docs/guideline/browseros-neo/`(문서 저장소 사본 — `CLAUDE.md` 의 두 「참조 지침」 색인)이 갖는다.
켜는 법, 안 붙을 때, 탭을 백그라운드로 여는 법, neo 가 못 하는 것, Playwright 를 neo 에 붙이는 법, 탭 소유권이 그것이다.

이 저장소의 로컬 앱은 평문 HTTP 다 — 웹은 Vite 개발 서버, API·Socket.IO 는 서버 프로세스이고 주소는 `.env` 가 정한다.
인증서·자동 로그인 같은 전제가 없으므로 **도구를 고르고 탭을 여는 규칙만 지키면 된다.**

## 이 저장소에서 달라지는 것

- ⚠ **이 앱은 실시간 앱이다.** 스트리밍 델타·Socket.IO 재접속·브리지 상태 표시처럼 화면만으로는 판단이
  안 서는 확인이 많고, 그때 필요한 것이 **콘솔 로그와 네트워크(WebSocket 프레임)** 다. 둘 다 neo 가
  못 하는 것에 들어가므로, 실시간 동작을 재는 검증은 처음부터 Playwright 를 neo 에 붙여서 한다.
- **`.mcp.json` 에 `playwright-neo`(neo 의 CDP 에 붙는 Playwright MCP)를 넣어 두었다.** 저장소에 커밋되어 있어
  워커 세션도 같은 설정을 받는다.
- `scripts/orca-worker.sh spawn` 은 워커를 띄우기 전에 neo 가 꺼져 있으면 켠다(`ensure_browser`) —
  그러나 **메인 세션 자신**이 시작될 때 꺼져 있었던 것은 스크립트가 고치지 못한다.
- ⚠ **프로필이 하나라 쿠키·localStorage 는 호스트 단위로 공유된다.** 지금 MVP 의 로컬 토큰
  인증은 이 영향이 작지만, **쿠키 세션(Better Auth)이 들어오는 순간 같은 호스트에 붙은 두 인스턴스는
  세션 쿠키 한 칸을 두고 서로를 덮는다** — 쿠키는 포트를 구분하지 않는다. 그때는 인스턴스마다
  세션 쿠키 이름을 갈라야 하고, 그 규칙은 인증을 넣는 작업이 이 절에 적는다.
- **워크트리에서 앱을 띄울 때는 최상위와 포트를 갈라라.** 같은 포트를 두 프로세스가 잡으면 뒤에
  뜬 쪽이 죽거나, 브라우저가 어느 인스턴스를 보고 있는지 알 수 없다.
  → [워크트리 작업 흐름](worktree-workflow.md) 「생성 직후 세팅」

## neo 가 잘 하는 것

- **치수 실측.** `evaluate` 가 페이지 컨텍스트에서 돌아 `getBoundingClientRect`·`getComputedStyle` 을 그대로 쓴다.
  **선언값과 렌더 결과를 따로 재서 비교할 수 있다** — `gap: 24px` 가 정말 24px 로 그려졌는지.
- **런타임 CSS 주입.** `<style>` 을 꽂아 **고치기 전에 「이 값이면 맞나」를 먼저 본다.**
- **접근성 트리 스냅샷과 `grep`.** 구조 확인이 DOM 을 통째로 뜨는 것보다 싸다.
- **스크린샷·PDF.** `annotate` 로 조작 가능한 요소에 번호를 덧씌울 수 있다.
- **로그인이 살아 있는 진짜 브라우저.** 전용 프로필이라 PWA 설치·서비스워커·푸시 구독까지 실제로 도는 모습을 본다.
- `file://` 도 열린다 — 로컬 HTML 조각을 바로 확인할 수 있다.

## neo 만으로 버틸 때 — 페이지에 기록기를 심는다

Playwright 를 붙이기 어려운 상황이면 `evaluate` 로 후킹해 대신할 수 있다.
**심은 뒤에 일어난 것만 잡힌다**(로드 시점은 여전히 못 본다).

```js
// console 전 레벨
window.__logs = [];
for (const lv of ['log', 'info', 'debug', 'warn', 'error']) {
  const orig = console[lv].bind(console);
  console[lv] = (...a) => { window.__logs.push({ lv, msg: a.map(String).join(' ') }); orig(...a); };
}

// fetch — REST 호출
window.__net = [];
const OF = window.fetch;
window.fetch = async (input, init) => {
  const res = await OF(input, init);
  window.__net.push({ method: init?.method ?? 'GET', url: String(input), status: res.status });
  return res;
};

// WebSocket — Socket.IO 프레임. 이미 열린 소켓은 못 잡으므로 심은 뒤 페이지를 다시 연결시킨다
window.__ws = [];
const OWS = window.WebSocket;
window.WebSocket = function (url, protocols) {
  const ws = protocols === undefined ? new OWS(url) : new OWS(url, protocols);
  const send = ws.send.bind(ws);
  ws.send = (d) => { window.__ws.push({ dir: 'out', data: String(d).slice(0, 200) }); return send(d); };
  ws.addEventListener('message', (e) => window.__ws.push({ dir: 'in', data: String(e.data).slice(0, 200) }));
  return ws;
};
```

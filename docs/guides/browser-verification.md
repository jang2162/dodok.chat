# 브라우저로 화면을 확인할 때

화면을 눈으로 봐야 판단이 서는 검증에서 **어느 브라우저 도구를 쓰는가**를 정하는 문서다.
**누가 그 검증을 하는가**는 [워크트리 작업 흐름](worktree-workflow.md) 「예외 — 워커가 가질 수 없는 자원이 필요한 검증」이 갖는다.

이 저장소의 로컬 앱은 평문 HTTP 다 — 웹은 Vite 개발 서버, API·Socket.IO 는 서버 프로세스이고 주소는 `.env` 가 정한다.
인증서·자동 로그인 같은 전제가 없으므로 **도구를 고르고 탭을 여는 규칙만 지키면 된다.**

## 도구를 고르는 순서

1. **`browseros-neo` 스킬이 있고 BrowserOS neo 가 깔려 있으면 neo 로 한다.**
   설치 확인은 `/Applications/BrowserOS neo.app` 이 있는가로 한다.
2. **아니면 그 환경에 있는 것으로 한다** — `claude-in-chrome`, 플러그인 Playwright(자체 브라우저를 띄운다), 사람이 직접 열어 보기.
   환경마다 붙어 있는 것이 다르므로 **무엇이 있는지 먼저 확인하고 고른다.**
3. **neo 의 한계에 걸리는 확인이면 Playwright 를 neo 에 얹는다.** 무엇이 한계인지는 아래 「neo 가 못 하는 네 가지」.
   이 저장소는 `.mcp.json` 에 `playwright-neo`(neo 의 CDP 에 붙는 Playwright MCP)를 넣어 두었다 — **새 브라우저를 띄우지 않는다.**

⚠ **도구가 없다고 검증을 건너뛰지 마라.** 도구가 없으면 사람에게 무엇을 봐 달라고 할지
**구체적인 화면과 확인 항목으로** 넘긴다 — "확인 부탁드립니다"는 넘긴 것이 아니다.

⚠ **이 앱은 실시간 앱이다.** 스트리밍 델타·Socket.IO 재접속·브리지 상태 표시처럼 화면만으로는 판단이
안 서는 확인이 많고, 그때 필요한 것이 **콘솔 로그와 네트워크(WebSocket 프레임)** 다. 둘 다 neo 가
못 하는 것에 들어가므로, 실시간 동작을 재는 검증은 처음부터 Playwright 를 neo 에 붙여서 한다.

## BrowserOS neo — 켜는 법과, 켰는데도 안 붙을 때

**세션을 열기 전에 켜 둔다.** 세션이 시작될 때 꺼져 있으면 그 세션은 **사람이 손대기 전까지**
neo 를 못 쓴다(아래 「둘은 같은 고장이 아니다」). 로그인 항목에 넣어 두면 이 조건을 매번
기억하지 않아도 된다 — 이것이 아래 두 고장을 **한꺼번에** 없애는 유일한 길이다.
`scripts/orca-worker.sh spawn` 은 워커를 띄우기 전에 neo 가 꺼져 있으면 켠다(`ensure_browser`) —
그러나 **메인 세션 자신**이 시작될 때 꺼져 있었던 것은 스크립트가 고치지 못한다.

**꺼져 있으면 켜면 된다.**

```bash
open -g -a "BrowserOS neo"   # -g 를 빼면 켜는 순간 사람의 화면을 뺏는다
# MCP 가 열릴 때까지 기다린다 (406 이 정상 응답이다)
curl -s -o /dev/null -w '%{http_code}\n' --max-time 40 --retry 40 --retry-delay 1 \
  --retry-connrefused http://127.0.0.1:9010/mcp
```

### 둘은 같은 고장이 아니다 — 언제 꺼져 있었는가로 갈린다

| 언제 꺼져 있었나 | 증상 | 회복 |
|---|---|---|
| **세션이 시작될 때** | `mcp__browseros-neo__*` 가 도구 목록에 **하나도 없다** | **사람이 `/mcp` 재연결**, 또는 세션을 새로 연다 |
| **세션 도중에** | 도구는 그대로 있고 **호출만** `Unable to connect` 로 실패한다 | **앱만 다시 켜면 된다.** 다음 호출이 알아서 붙는다 |

**증상으로 먼저 가른다.** 호출이 실패했다고 `/mcp` 부터 찾지 마라 — 앱만 켜면 되는 경우에
사람을 붙들어 세우게 된다.

**왜 다른가 — 도구 목록은 한 번 찍는 사진이고, 툴 호출은 매번 거는 전화다.**
도구 목록은 세션이 시작될 때 핸드셰이크로 한 번 받아 오고 **그 뒤로 다시 묻지 않는다.**
반면 이 서버는 HTTP 라 **툴 호출마다 새로 연결하므로**, 서버가 돌아오면 다음 호출이 그냥 성공한다.

⚠ **도중에 살아나는 것은 HTTP 라서 되는 것이다.** stdio 로 바꾸면 시작 시점 문제는 사라지지만
**도중에 죽은 서버는 세션이 끝날 때까지 살아나지 않는다** — Claude Code 는 죽은 자식 프로세스를
다시 띄우지 않는다. 한쪽을 고치면 다른 쪽을 잃으므로, 답은 전송 방식을 바꾸는 것이 아니라
**늘 켜 두는 것**이다.

### 시작 때 꺼져 있었으면 — 사람이 붙여야 한다

⚠ **「앱을 켜는 것」과 「이 세션이 쓸 수 있는 것」은 다르다.**
MCP 툴 목록은 **세션이 시작될 때** 한 번 받아 간다. 세션이 열릴 때 neo 가 꺼져 있었으면
그 세션에는 `mcp__browseros-neo__*` 툴이 **하나도 없고, 나중에 앱을 켜도 소급되지 않는다.**
`claude mcp list` 가 `✔ Connected` 를 보여 줘도 그 세션에서는 여전히 못 쓴다 —
**서버가 살아 있는 것과 툴이 붙어 있는 것을 같은 것으로 보지 마라.**

**그럼 무엇으로 확인하나 — 도구 목록에서 `mcp__browseros-neo__*` 를 찾는다.**
에이전트라면 그 이름을 직접 지정해 도구를 찾아 보고(`select:mcp__browseros-neo__…`),
「찾지 못했다」가 나오면 이 세션에는 **없는 것**이다. 그때 그 응답이 함께 알려 주는
「연결 실패한 서버」 목록에 `browseros-neo` 가 **없다는 것도 같이 본다** — 실패한 것이 아니라
**애초에 목록에 들어오지 않은 것**이고, 그래서 앱을 켜도 달라지지 않는다.

이때는 둘 중 하나가 필요하고, **둘 다 사람이 해야 한다.**

- `/mcp` 로 `browseros-neo` 재연결 (세션 유지)
- 세션을 새로 열기 (앱이 떠 있으면 자동으로 붙는다)

**⚠ 먼저 `/mcp` 목록에 `browseros-neo` 가 있는지 본다 — 없으면 재연결도 못 한다.**
`/mcp` 는 **연결에 실패한 서버도 보여 준다.** 그런데도 이름이 아예 없다면 그 세션의 서버
목록에 **항목 자체가 없는 것**이고, 그때는 **서버를 세션이 시작된 뒤에 설정에 추가한 것**이다
(`~/.claude.json` 의 `mcpServers`, 또는 이 저장소의 `.mcp.json`). 이 경우 `/mcp` 에는 누를 대상이
없어 **사람도 못 붙인다 — 세션을 새로 여는 길뿐이다.**

⚠ **`claude mcp` 에는 재연결·리로드 명령이 없다.** `add`·`get`·`list`·`login`·`logout`·
`remove`·`serve` 뿐이고, 그것들은 설정 파일을 만지는 **별개 프로세스**라 이미 떠 있는 세션의
도구 목록에 닿지 않는다.

⚠ **MCP 를 `curl` 로 직접 두드려 우회하지 마라.** 프로토콜이 HTTP 라 실제로 되기는 하지만
(초기화 → `tools/call`), 지원되는 경로가 아니고 세션마다 페이지 소유권이 끊겨 한 호출에
전부 이어 붙여야 하며, 이미지 결과는 돌려받아도 볼 수 없다. **되는 것과 그렇게 하는 것은 다르다.**

### 도중에 살아난 뒤에는 세션 핸들이 새로 발급된다

앱을 껐다 켜면 **neo 쪽 세션 상태가 함께 사라진다** — 탭 소유권과 `name_session` 으로 붙인 이름이
거기 들어 있다. 그런데 옛 핸들로 호출해도 **오류가 나지 않는다.** 서버가 조용히 **새 세션을 하나 판다.**

⚠ **그래서 옛 핸들을 계속 들고 있으면 호출마다 남남인 세션이 된다.** 직전 호출에서 연 탭을
다음 호출에서 만지지 못하고, 붙여 둔 이름도 무작위 기본값으로 돌아가 cockpit 의 감사 기록이 갈린다.
**실패가 아니라 성공처럼 보이면서 갈리므로** 알아채기 어렵다.

**회복한 뒤에는 결과에 실려 온 새 핸들로 갈아타고 `name_session` 을 다시 부른다.**

## 탭은 백그라운드로 연다 — 기본값이 사람의 화면을 뺏는다

**`tabs action="new"` 는 기본적으로 neo 창을 최전면으로 끌어올린다.** 사람이 다른 창에서
일하는 중이면 그때마다 화면이 넘어간다. 검증은 대개 탭을 여러 번 열므로, **확인 한 번이
사람의 작업을 여러 번 끊는다** — 고장으로 보이지 않아 그냥 참고 넘기게 되는 종류의 손해다.

- **`tabs action="new"` 에는 `background: true` 를 함께 준다.**
- **`run` 의 `browser.pages.newPage(url)` 은 기본이 백그라운드다.** 인자를 더할 필요가 없고,
  `{ background: false }` 는 **사람이 "앞으로 띄워 달라"고 했을 때만** 준다.
  탭을 여는 김에 여러 단계를 한 호출로 묶게 되므로, **탭 열기는 `run` 이 기본값**이다.
- **`navigate` 는 이미 열린 탭을 움직이는 것이라 포커스를 건드리지 않는다.** 탭을 새로 열지 말고
  쓰던 탭을 옮기면 이 문제 자체가 생기지 않는다.
- ⚠ **`windows action="create"` 에는 백그라운드 옵션이 없다.** 창이 필요해 보여도 **탭으로 연다.**

## neo 가 잘 하는 것

- **치수 실측.** `evaluate` 가 페이지 컨텍스트에서 돌아 `getBoundingClientRect`·`getComputedStyle` 을 그대로 쓴다.
  **선언값과 렌더 결과를 따로 재서 비교할 수 있다** — `gap: 24px` 가 정말 24px 로 그려졌는지.
- **런타임 CSS 주입.** `<style>` 을 꽂아 **고치기 전에 「이 값이면 맞나」를 먼저 본다.**
- **접근성 트리 스냅샷과 `grep`.** 구조 확인이 DOM 을 통째로 뜨는 것보다 싸다.
- **스크린샷·PDF.** `annotate` 로 조작 가능한 요소에 번호를 덧씌울 수 있다.
- **로그인이 살아 있는 진짜 브라우저.** 전용 프로필이라 PWA 설치·서비스워커·푸시 구독까지 실제로 도는 모습을 본다.
- `file://` 도 열린다 — 로컬 HTML 조각을 바로 확인할 수 있다.

## neo 가 못 하는 네 가지

| 못 하는 것 | 증상 |
|---|---|
| `console.log`·`console.info` 수집 | `read format="console"` 은 **warning·error·exception 만** 모은다. log 는 한 줄도 안 나온다 |
| 첫 로드 시점 콘솔 | 리스너가 로드 뒤에 붙어 **`(no console errors or warnings)`** 가 나온다. 로드 중에 터진 예외도 조용하다 |
| 네트워크 확인 | 전용 수단이 없다. `performance.getEntriesByType('resource')` 로는 **상태 코드가 대개 `0`** 이고 헤더·본문은 못 본다. **WebSocket 프레임은 아예 안 보인다** |
| 뷰포트 변경 | `window.resizeTo` 가 막혀 있고 리사이즈 수단도 없다. **미디어쿼리를 발화시킬 수 없다** — 모바일 레이아웃 확인이 안 된다 |

⚠ **가장 걸리기 쉬운 것은 두 번째다.** 페이지를 열자마자 콘솔을 읽으면 **비어 있는 것이 정상처럼 보인다.**
**열고 → `reload()` → 콘솔 읽기** 순서로 해야 로드 시점 것까지 잡힌다.
버퍼는 reload 를 넘어 **누적**되므로, 「이번 로드에서 난 것」만 보려면 그 점을 감안한다.

### neo 만으로 버틸 때 — 페이지에 기록기를 심는다

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

## Playwright — 새로 띄우지 말고 neo 에 붙인다

**neo 는 CDP 를 열어 두고 있다.** 포트는 neo 설정이 갖는다
(`~/Library/Application Support/BrowserClaw/.browseros/config.json` 의 `ports.cdp`, 기본 `9110`).
여기에 붙으면 **같은 브라우저·같은 프로필·같은 로그인**을 그대로 쓰면서
위의 네 가지가 전부 열린다 — `console.log` 가 로드 시점 것까지 잡히고, 요청마다 메서드와 상태 코드가 보이고,
WebSocket 프레임이 보이고, `setViewportSize` 가 **미디어쿼리를 실제로 발화시킨다.**

**이 저장소는 MCP 로 상시 붙여 두었다** — `.mcp.json` 의 `playwright-neo` 항목이다.
저장소에 커밋되어 있어 워커 세션도 같은 설정을 받는다. 세션이 시작될 때 읽히므로,
항목을 바꿨으면 세션을 새로 연다.

```json
"playwright-neo": {
  "command": "npx",
  "args": ["-y", "@playwright/mcp@latest", "--cdp-endpoint", "http://127.0.0.1:9110"]
}
```

**스크립트로 한 번만 필요할 때.** `playwright-core` 만 있으면 된다(브라우저를 내려받지 않는다).

```js
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://127.0.0.1:9110');
const ctx = b.contexts()[0];          // neo 의 기존 컨텍스트
const page = await ctx.newPage();
// ...
await b.close();                      // CDP 연결만 끊는다. neo 는 살아 있다
```

⚠ **`--isolated` 나 `--browser` 를 주지 마라.** 새 브라우저가 떠서 **neo 의 프로필·로그인을 잃는다.**
붙이는 목적 자체가 사라진다. 이 세션에 붙어 있을 수 있는 **플러그인 Playwright 는 자체 브라우저를
띄우는 도구**라 같은 이유로 neo 가 없을 때의 대안일 뿐이다.

⚠ **한 탭을 양쪽에서 번갈아 만지지 마라.** Playwright 가 연 탭은 neo 의 소유권 밖이라
neo 쪽에서는 남의 탭으로 보여 손댈 수 없다. **조작은 한쪽이 맡고 다른 쪽은 관찰만 한다.**

## PWA·서비스 워커를 볼 때

서비스 워커는 **오리진(`localhost:<포트>`)에 남는다** — 탭을 닫아도, 서버를 바꿔 띄워도 그 오리진의 다음 탐색을 가로챈다. 그래서 이 저장소에서는 셋을 지킨다.
절차 전체(푸시 넣기·권한·정리)는 [live-smoke](live-smoke.md) 14.1.

- **개발 모드 서비스 워커는 `VITE_PWA_DEV=1` 로만 켠다.** 기본 `pnpm -F @dodok/web dev` 에는 서비스 워커가 없다(PWA 스펙 11장 R4) — 설치·푸시·오프라인을 보려면 **빌드본 `vite preview`** 가 먼저다
  (`pnpm -F @dodok/web build` → `DODOK_API_ORIGIN=http://127.0.0.1:3100 pnpm -F @dodok/web exec vite preview --port 5180 --strictPort` — 프록시는 `server.proxy` 를 따른다).
  개발 서버에서 꼭 봐야 하면 셸에서 `VITE_PWA_DEV=1` 을 준다(`vite.config.ts` 는 `.env` 를 읽지 않는다). 개발 SW 는 미리 저장이 비어 **오프라인 탐색 폴백이 없다** — 오프라인 확인은 preview 로만 된다.
  ⚠ 이 머신의 5173 은 **다른 프로젝트**다. 그 오리진에 dodok 서비스 워커를 남기면 다른 앱의 탐색에 닿는다 — PWA 확인은 5180 에서 한다(`APP_ORIGIN`·`DODOK_API_ORIGIN`·`--port` 를 맞춘다).
- **preview 를 띄웠던 오리진에서 dev 로 돌아오면 서비스 워커를 해제한다(또는 Shift+새로고침).** 빌드본 SW 는 미리 저장한 번들을 계속 내주고, dev 서버는 `/sw.js` 에 HTML 을 돌려 갱신 확인이 실패한다 — 옛 빌드가 계속 뜬다(p4-t1b 리뷰 D1 「고쳐도 남는 것」).
  해제는 DevTools Application → Service workers → Unregister, 또는 페이지에서 `(await navigator.serviceWorker.getRegistrations()).forEach((r) => r.unregister())` 뒤 새로고침. 캐시(`caches.keys()`)·IndexedDB(`keyval-store` — 오프라인 사본)도 같이 지운다.
  반대 방향(dev → preview)은, `VITE_PWA_DEV=1` 로 개발 SW 를 켰던 오리진이면 새 SW 가 waiting 에 들어가 「새 버전이 있습니다」 토스트가 뜨고 누르면 넘어간다. 기본 dev(SW 없음) 뒤에는 첫 설치라 곧바로 활성화된다(waiting·토스트 없음).
- **알림 권한이 필요한 검증은 headed 브라우저로 한다(화면 밖 `--window-position`).** 헤드리스 Chromium 은 권한을 줘도 `Notification.permission` 이 `"denied"` 로 고정돼, 앱의 알림 패널이 늘 「거절됨」이다(p4-t7).
  Playwright 로 새 브라우저를 띄워야 하면 `headless: false` + `args: ["--window-position=-2400,-2400"]` 로 사람 화면 밖에 띄운다 — 사람의 작업을 가리지 않는다. p4-t7 은 Playwright 가 받아 둔 Chromium(`~/Library/Caches/ms-playwright`, Google Chrome for Testing — 없으면 `pnpm dlx playwright@1.62.1 install chromium` — 저장소의 playwright-core 1.62.1 과 같은 버전이어야 그 Chromium 빌드를 찾는다)을 `playwright-core`(openclaw 가 끌어오는 전이 의존성 — 브라우저를 내려받지 않는다)로 띄웠고, 이 빌드는 실제 FCM 수신까지 된다.
  neo 에 붙이는 경우는 neo 가 이미 headed 다 — 권한은 CDP `Browser.grantPermissions`, 끝나면 `Browser.resetPermissions`([live-smoke](live-smoke.md) 9.2).
- 끝나면 등록한 서비스 워커·캐시·IndexedDB·푸시 구독·알림 권한을 지운다 — **네가 연 것은 네가 닫는다.** neo 의 공유 프로필에 남기면 다음 세션의 확인이 옛 SW 위에서 돈다.

## 여러 세션이 동시에 볼 때

**탭은 갈리고, 브라우저 프로필은 갈리지 않는다.**

- neo 는 탭마다 소유자를 두고 **남의 탭에 대한 조작을 거부한다.** 그래서 여러 세션이
  동시에 써도 서로의 탭을 밟지 않는다.
- ⚠ **그러나 프로필이 하나라 쿠키·localStorage 는 호스트 단위로 공유된다.** 지금 MVP 의 로컬 토큰
  인증은 이 영향이 작지만, **쿠키 세션(Better Auth)이 들어오는 순간 같은 호스트에 붙은 두 인스턴스는
  세션 쿠키 한 칸을 두고 서로를 덮는다** — 쿠키는 포트를 구분하지 않는다. 그때는 인스턴스마다
  세션 쿠키 이름을 갈라야 하고, 그 규칙은 인증을 넣는 작업이 이 절에 적는다.
- **워크트리에서 앱을 띄울 때는 최상위와 포트를 갈라라.** 같은 포트를 두 프로세스가 잡으면 뒤에
  뜬 쪽이 죽거나, 브라우저가 어느 인스턴스를 보고 있는지 알 수 없다.
  → [워크트리 작업 흐름](worktree-workflow.md) 「생성 직후 세팅」
- ⚠ **세션 정체성이 갈리면 먼저 연 탭의 소유권을 잃는다.** 그 탭은 이후 **자기도 닫지 못한다.**
  길게 도는 확인 중에 소유권을 잃으면 탭을 새로 열고, 남은 탭은 사람에게 닫아 달라고 말한다.
  **브리프에는 "네가 연 탭은 네가 닫아라"를 넣는다.**

# 브라우저로 화면을 확인할 때

화면을 눈으로 봐야 판단이 서는 검증에서 **이 저장소에만 해당하는 것**을 적는 문서다.
**누가 그 검증을 하는가**는 [워크트리 작업 흐름](worktree-workflow.md) 「예외 — 워커가 가질 수 없는 자원이 필요한 검증」이 갖는다.

**도구를 고르는 순서와 공통 원리는 여기 없다.** `CLAUDE.md` 「BrowserOS neo 가 깔려 있으면 neo 로 본다」(상시)와
`docs/guideline/browser/`·`docs/guideline/browseros-neo/`(지침 서버에서 받은 사본 — `CLAUDE.md` 의 두 「참조 지침」 색인)이 갖는다.
켜는 법, 안 붙을 때, 탭을 백그라운드로 여는 법, neo 가 못 하는 것, Playwright 를 neo 에 붙이는 법, 탭 소유권이 그것이다.

이 저장소의 로컬 앱은 평문 HTTP 다 — 웹은 Vite 개발 서버, API·Socket.IO 는 서버 프로세스이고 주소는 `.env` 가 정한다.
인증서·자동 로그인 같은 전제가 없으므로 **도구를 고르고 탭을 여는 규칙만 지키면 된다.**
배포 이미지를 이 Mac 에 띄워 볼 때와 내부 CA 의 HTTPS 앞단을 볼 때는 아래 「배포 이미지(앱 컨테이너)를 볼 때」.

## 이 저장소에서 달라지는 것

- ⚠ **이 앱은 실시간 앱이다.** 스트리밍 델타·Socket.IO 재접속·브리지 상태 표시처럼 화면만으로는 판단이
  안 서는 확인이 많고, 그때 필요한 것이 **콘솔 로그와 네트워크(WebSocket 프레임)** 다. 둘 다 neo 가
  못 하는 것에 들어가므로, 실시간 동작을 재는 검증은 처음부터 Playwright 를 neo 에 붙여서 한다.
- **`.mcp.json` 에 `playwright-neo`(neo 의 CDP 에 붙는 Playwright MCP)를 넣어 두었다.** 저장소에 커밋되어 있어
  워커 세션도 같은 설정을 받는다. 포트는 9110 고정이라 neo 의 `ports.cdp` 가 다른 머신에서는 붙지 않는다 — 그때는
  `playwright-core` 로 설정 파일의 포트에 직접 붙는다.
- `scripts/orca-worker.sh spawn` 은 워커를 띄우기 전에 neo 가 꺼져 있으면 켠다(`ensure_browser`) —
  그러나 **메인 세션 자신**이 시작될 때 꺼져 있었던 것은 스크립트가 고치지 못한다.
- ⚠ **프로필이 하나라 쿠키·localStorage 는 호스트 단위로 공유되고, 로그인은 쿠키 세션(`dodok.session`)이다.**
  쿠키는 포트를 가리지 않으므로 neo 로 `localhost:<다른 포트>` 의 dev 인스턴스에 로그인하면 같은 호스트에 붙은
  다른 인스턴스(사람이 보고 있는 것 등)의 세션을 덮는다. 다른 인스턴스가 neo 에서 로그인돼 있을 수 있으면
  독립 브라우저(playwright-core 임시 컨텍스트)로 본다.
- ⚠ **같은 오리진(포트)에서 빌드본(`vite preview`)을 본 뒤 dev 로 돌아오면 빌드본의 서비스 워커가 남아 옛 빌드를 계속 내준다** — 고친 코드가 안 보이는데 오류도 없다.
  빌드본 검증을 끝낼 때와 dev 로 바꿀 때 `navigator.serviceWorker.getRegistrations()` 를 전부 `unregister()` 하고 `caches` 를 지운다.
  빌드본을 두 번째로 올릴 때는 새 SW 가 `waiting` 에 머무므로(새 버전은 토스트로만 넘어간다 — PWA 스펙 `docs/superpowers/specs/2026-09-23-pwa-push-design.md` 결정 7)
  `registration.waiting.postMessage({ type: "SKIP_WAITING" })` 로 넘긴 뒤 잰다.
- **워크트리에서 앱을 띄울 때는 최상위와 포트를 갈라라.** 같은 포트를 두 프로세스가 잡으면 뒤에
  뜬 쪽이 죽거나, 브라우저가 어느 인스턴스를 보고 있는지 알 수 없다.
  → [워크트리 작업 흐름](worktree-workflow.md) 「생성 직후 세팅」
- ⚠ **초점 이동은 jsdom 테스트가 통과해도 실제 브라우저에서 따로 본다.** jsdom 은 숨겨진 요소의 초점을 body 로 옮기지 않고(브라우저는 커밋 뒤
  정리한다), act 환경이라 캐시 갱신의 다시 그리기가 늦어 언마운트된 컴포넌트의 `mutate` 콜백도 불린다(브라우저에서는 불리지 않는다) — 두 결함이
  테스트를 통과한 채 실제 브라우저에서만 났다. 언마운트 뒤에도 돌아야 하는 일은 `mutateAsync().then` 으로 쓰고, 숨은 자리 안의 초점은 떨어진 것으로
  본다(`features/conversations/ClosedNotice.tsx` 의 `closest("[hidden]")`). 줄을 목록에서 빼는 mutation(보관·옮기기·삭제)이 그 경우다 — 성공 뒤
  목록을 다시 받으면 그 줄과 줄 안의 대화상자가 콜백보다 먼저 언마운트되어, 대화상자의 초점 되돌리기(`onCloseAutoFocus`)도 돌지 않는다. 초점은
  `.then` 에서 직접 옮긴다. 대기 중 `disabled` 가 되는 버튼을 누른 채 실패하면 초점이 body 로 떨어지니 실패 처리에서도 되돌린다 — 잠기지 않는
  요소(오류 줄·대화상자 내용)로. 잠긴 버튼에 `focus()` 는 아무것도 하지 않는다. 이 함정은 jsdom 시험이 잡지 못한다(옛 코드도 jsdom 에서는 초점이
  맞게 간다) — 실제 브라우저에서 본다(`features/runners/ProjectList.tsx`·`MoveProjectDialog.tsx`).

## Playwright 로 여러 번 나눠 돌릴 때

- ⚠ **`connectOverCDP` 로 스크립트마다 붙었다 떼면 `setViewportSize` 가 연결과 함께 풀린다** — 창 실제 크기(headless 면 대개 756×413)로 돌아가, 390px 검증이 조용히 넓은 화면으로 찍힌다. 붙을 때마다 다시 준다.
- 붙을 때마다 다시 주는 대신, `launchPersistentContext` 를 띄운 Node 프로세스 하나가 127.0.0.1 포트로 스크립트 본문을 받아 같은 컨텍스트에서 실행하게 하면 페이지·뷰포트·리스너가 호출 사이에 남는다. 그 포트도 끝에 LISTEN 0 을 확인한다.
- ⚠ **auto 모드에서는 권한 분류기가 포트로 스크립트 본문을 받아 실행하는 드라이버(위)를 막는다**(「Create RCE Surface」). 그때는 항목마다 독립 스크립트(launch → 컨텍스트 → 닫기)로 돌고, 로컬 로그인 분당 5 를 넘지 않게 세션 토큰을 API(`POST /api/v1/auth/local`)로 한 번 받아 `context.addCookies` 로 `dodok.session` 을 싣는다. 상태는 서버 DB 에 남으므로 항목 사이에 이어진다.
- **서버 쪽 wire 끊김은 `page.routeWebSocket` 으로 흉내 낸다** — `page.routeWebSocket(u => u.pathname.includes("socket.io"), ws => { if (block) ws.close(); else ws.connectToServer(); })` 를 페이지를 열기 전에 건다. `context.setOffline` 은 브라우저 온라인 이벤트로 React Query 가 쿼리를 다시 받아 **재접속 뒤 캐시가 낡는 결함을 가린다.** 이 `ws.close()` 는 「업그레이드는 됐는데 핸드셰이크 전에 깨끗이 닫힌」 시도라, 진짜 서버 중단(연결 거부 — 브라우저가 `error` 를 먼저 낸다)과 다른 길을 탄다 — 웹은 그 길을 `realtime/wire.ts` 의 `WireManager` 로 실패로 친다. 서버가 죽은 경우를 재려면 서버 프로세스를 내렸다 올린다.
- **화면 캐시가 낡은 상태(끊긴 러너를 붙은 줄로 아는 폼 등)는 wire 이벤트만 막아 만든다** — `page.routeWebSocket` 에서 `const server = ws.connectToServer(); server.onMessage(m => { if (!freeze) ws.send(m); }); ws.onMessage(m => server.send(m));` 로 서버 프레임만 버린다. 연결은 살아 있어 재접속·재구독이 일어나지 않는다(위 `ws.close()` 는 재접속을 일으켜 캐시를 다시 받는다).
- `dev:fake` 의 개발 전용 훅(`/__devfake/*`)은 서버 오리진으로 직접 부른다 — 페이지 안 `fetch` 는 CORS 와 415(JSON 이 아닌 단순 요청 거절)에 걸린다. 훅 목록·호출 예는 `docs/guides/project-structure.md` 의 `apps/server` 절 dev:fake 문단.

## 배포 이미지(앱 컨테이너)를 볼 때

`docs/guides/docker-deploy.md` 「확인 — `scripts/check-deploy.sh`」 절의 「로컬에서 운영 이미지를 띄워 볼 때」대로 띄운 앱은 평문 `http://localhost:3000` 이다(서버가 웹까지 낸다). `localhost` 는 보안 컨텍스트라 서비스 워커·푸시 구독이 되고 인증서 문제가 없다 — 위 규칙 그대로 보되, 쿠키가 호스트 단위라 neo 로 로그인하면 `localhost:5173` 의 dev 세션을 덮는다(위 「이 저장소에서 달라지는 것」). 푸시까지 보려면 아래 `launchPersistentContext` 를 인증서 인자 없이 쓴다.

HTTPS 앞단을 이 Mac 에 두고 볼 때(`scripts/check-deploy.sh proxy` 의 Caddy 처럼 **내부 CA 의 자체 인증서**) 도구마다 막히는 자리가 다르다 — 그 스크립트의 프록시는 검사가 끝나면 지워지니, 브라우저로 볼 앞단은 따로 띄운다.

- ⚠ **Claude-in-Chrome 은 인증서 오류를 넘기지 못한다** — `net::ERR_CERT_AUTHORITY_INVALID` 에서 멈추고 예외를 거는 옵션이 없다.
- ⚠ **Playwright 의 `ignoreHTTPSErrors` 만으로는 서비스 워커가 등록되지 않는다** — 페이지는 열리지만 SW 스크립트 가져오기가 `An SSL certificate error occurred when fetching the script` 로 거절된다. 브라우저 인자 `--ignore-certificate-errors` 가 있어야 한다.
- ⚠ **Playwright 의 임시 컨텍스트(`browser.newContext()`)에는 Push API 가 없다** — Chromium 이 임시 프로필을 시크릿으로 취급해 `Chrome currently does not support the Push API in incognito mode` 로 구독이 실패한다. 푸시 켜기까지 보려면 **`launchPersistentContext`** 로 띄운다.
- ⚠ **서비스 워커 안의 콘솔(CSP 위반 포함)은 Playwright 컨텍스트 `console` 이벤트로 오지 않는다** — SW 안에서 일부러 위반을 내도 0건이다. 「SW 위반 0」을 그 수로 보고하지 않는다. SW 의 문자열 코드 실행은 빌드된 `dist/sw.js` 를 Node 에서 가짜 `self` 로 평가하며 `Function` 을 Proxy 로 세어 본다(양성 대조: zod 설정의 `jitless:!0` 을 `!1` 로 바꾼 사본은 1건).
- neo 로 이 인증서를 넘길 수 있는지는 재지 않았다(neo 의 CDP 는 Playwright `connectOverCDP` 를 `Browser context management is not supported` 로 거절했다). 로그인이 필요 없는 검증이라 독립 브라우저로 한다.

```js
// playwright-core + 이미 받아 둔 Chromium(Chrome for Testing) — 전역 설치 없이
import { chromium } from "playwright-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "dodok-https-")), {
  headless: false, // 알림 권한이 필요하면 headed(창은 화면 밖에 두어도 된다)
  args: ["--ignore-certificate-errors"],
  ignoreHTTPSErrors: true,
  // 실제 FCM 까지 받으려면: ignoreDefaultArgs: ["--disable-background-networking"] — live-smoke.md 「푸시 확인 절차 (`dev:fake`, 모델 런 0회)」
});
```

쓴 뒤에는 컨텍스트를 닫고 임시 디렉터리를 지운다.

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

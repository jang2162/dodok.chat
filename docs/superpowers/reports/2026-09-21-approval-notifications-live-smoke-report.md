# 승인 알림 재검증 — 재검증(p2-t13)이 확인한 것과 흉내 낸 방법

> 승인 알림 재검증(p2-t13)이 코드가 하는 일까지 잰 것의 기록 — 계획 `docs/superpowers/plans/2026-09-20-activity-approvals.md` 태스크 11, 스펙 `docs/superpowers/specs/2026-09-20-activity-approvals-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


넷을 못 쟀다고 해서 알림 경로 전체가 미확인인 것은 아니다. **코드가 하는 일까지는 실측했다** — 다음 사람은 아래를 빼고 위 표의 여섯만 보면 된다.

| 이미 확인된 것(재검증 실측) | 값 |
| --- | --- |
| 다른 채널을 볼 때 승인 1건 → `Notification` | **정확히 1건**. 제목 「승인 필요 — @dev 가 Write 를 실행하려 합니다」 · 본문 「general 채널」 · `tag` `approval:<id>` · **툴 인자와 승인 제목은 안 실린다**(툴 이름만) |
| 알림 객체의 `show` 이벤트 | 생성 **1ms 안**에 발화(브라우저가 표시 단계로 넘겼다는 뜻) — 승인 2건 모두 |
| 알림 `onclick` | `window.focus()` **1회** 호출 + `/c/<채널>/activity` 로 이동, 활동 탭 선택·카드 2장 |
| 승인이 둘이면 | 알림 **2건**(승인마다 1건, `tag` 서로 다름) |
| 같은 채널을 보고 있을 때 | 보임 **0건** / 숨김 **1건** |
| 권한 `denied` | 토글이 **숨겨지고** 알림 0건, 카드는 정상, 예외 0 |
| 권한 팝업이 버튼 **전에** 뜨는가 | **0회** — 로그인·홈·에이전트·채널·활동·설정 여섯 화면 전부. 버튼을 누른 뒤에만 1회(스택 `NotifyToggle`) |

**흉내 낸 방법**(둘 다 CDP — 저장소 pnpm 스토어의 `playwright-core` 를 BrowserOS neo 의 CDP 포트 9110 에 얹어 썼다. 새 브라우저를 띄우거나 의존성을 더하지 않는다):

- **알림 권한**: 「알림 켜기」를 눌러 요청이 **1회 나가는 것**을 먼저 보이고(팝업은 배경 탭이라 큐에 걸려 `default` 로 남는다), 그 뒤 `Browser.grantPermissions` 로 `localhost:5173` 에 `notifications` 를 부여한다.
  `denied` 판은 `Browser.setPermission` 으로 만들고, 끝나면 **`Browser.resetPermissions` 로 `default` 로 되돌린다** — 프로필을 갈아 끼울 필요가 없다. 위의 ⚠ 순서 경고(`granted` 를 먼저)는 **사람이 손으로 팝업에 답할 때** 그대로 유효하다.
- **탭 숨김**: `document.visibilityState` 를 `hidden` 으로 덮어썼다(neo 는 배경 탭도 `visible` 로 유지한다). **진짜 숨김이 아니다** — 그래서 위 표 2·3(소리·클릭으로 탭이 앞으로)은 사람이 **진짜로** 다른 앱으로 전환해 봐야 한다.
- 뷰포트 변경·wire 소켓만 끊기도 같은 CDP 경로로 했다. 소켓만 끊을 때는 `/socket.io/` 짜리만 막고 **REST 와 Vite HMR 소켓은 건드리지 않는다** — 브라우저를 통째로 offline 으로 만들면 재접속 때 목록을 알아서 다시 받아 재현이 안 되고, HMR 을 막으면 페이지가 새로 고쳐져 「재접속」이 아니라 「새 탭」이 된다.

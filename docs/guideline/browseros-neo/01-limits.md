# neo 가 못 하는 다섯 가지

## neo 의 한계에 걸리는 확인은 neo 만으로 결론 내지 않는다

| 못 하는 것 | 증상 |
| --- | --- |
| `console.log`·`console.info` 수집 | `read format="console"` 은 **warning·error·exception 만** 모은다. `log` 는 한 줄도 안 나온다 |
| 첫 로드 시점 콘솔 | 리스너가 로드 뒤에 붙어 `(no console errors or warnings)` 가 나온다. 로드 중에 터진 예외도 조용하다 |
| 네트워크 확인 | 전용 수단이 없다. `performance.getEntriesByType('resource')` 로는 상태 코드가 대개 `0` 이고 헤더·본문은 못 본다. **WebSocket 프레임은 아예 안 보인다** |
| 뷰포트 변경 | `window.resizeTo` 가 막혀 있고 리사이즈 수단도 없다. **미디어쿼리를 발화시킬 수 없다** — 모바일 레이아웃 확인이 안 된다 |
| 보이지 않는 탭의 렌더 | 백그라운드로 연 탭은 `visibilityState: hidden`·`hasFocus() === false` 이고 **`requestAnimationFrame`·`ResizeObserver` 가 돌지 않는다**. 애니메이션·캔버스·크기 관찰에 기대는 화면은 그리다 멈춘 채로 보인다 |

- **Why:** 다섯 다 실패가 아니라 **「없음」으로 보인다.** 「로그가 안 찍혔다」·「오류 없음」·「모바일에서도 같다」를 코드의 결과로 읽으면 못 본 것을 확인한 것으로 보고하게 된다.
- **How to apply:**
  - 렌더를 재야 하면 neo 도, neo 에 붙인 Playwright 도 답이 아니다 — 둘 다 탭을 백그라운드로 연다. 로그인이 필요 없는 검증이면 독립 브라우저를 띄운다 — `browser` 스택 「페이지 자동화 도구를 얹을 때」 의 예외.
  - 앞의 넷 중 하나가 필요한 확인이면 처음부터 neo 에 Playwright 를 붙인다 — 이 스택 「Playwright 를 neo 에 붙일 때」. 실시간 동작(스트리밍·WebSocket 재접속)을 재는 검증이 대표적이다.
  - Playwright 를 붙이기 어려우면 `evaluate` 로 기록기를 심는다 — `browser` 스택 「콘솔과 네트워크」. 첫 로드 콘솔은 **열고 → `reload()` → 읽기** 순서로 한다(같은 파일).

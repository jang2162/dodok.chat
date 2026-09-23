# neo 의 탭과 세션

## neo 의 탭 소유권은 표시일 뿐이고, 세션은 `session` 인자로 갈린다

원리(소유권이 막아 주지 않으니 스스로 자기 탭만 쓴다, 재시작 뒤 새 핸들로 갈아탄다)는 `browser` 스택 「여러 세션이 한 브라우저를 볼 때」·「브라우저 서버가 안 붙을 때」 가 갖는다. 여기 있는 것은 neo 에서 그것이 어떻게 보이는가다(앱 `0.50.5` 에서 두 세션으로 잼 — 다시 잴 때는 한 세션이 연 탭을 다른 세션이 `navigate`·`evaluate`·닫기 해 본다).

| 상황 | neo 가 하는 것 |
| --- | --- |
| 다른 에이전트의 탭을 조작 | 된다. 결과에 `Note: page N belongs to another agent (…). You are allowed to use it; leave it as you found it …` 가 붙는다 |
| Playwright(CDP)가 연 탭 | 목록에서 **User's tabs** 로 분류되고, 조작하면 `… is one of the user's own tabs …` 가 붙는다 |
| 닫기 결과의 Note | **소유자를 틀리게 적는다** — 자기 탭이든 다른 에이전트의 탭이든 닫으면 「user's own tabs」 라고 나온다 |
| 재시작 뒤 옛 핸들 | 오류 없이 새 세션으로 이어지고 결과마다 `The handle you sent is no longer active …` 와 새 핸들이 온다. 옛 핸들을 계속 보내도 **같은** 새 세션으로 이어진다 |
| 재시작 전에 연 탭 | neo 가 복원하지 않아 **없어진다** |
| 세션을 가르는 것 | MCP 연결이 아니라 **`session` 인자**다 — 같은 연결을 쓰는 서브에이전트도 핸들을 넘기지 않으면 다른 세션이 된다 |

- **Why:** 표가 없으면 옛 지침처럼 「남의 탭은 막힌다」 로 읽어 남의 탭을 거리낌 없이 쓰게 되거나, 닫기 Note 를 믿고 남의 탭을 사람의 탭으로 오인한다.
- **How to apply:**
  - 누구의 탭인지는 `tabs action="list"` 의 분류(Your tabs / Other agents' tabs / User's tabs)로 본다. 조작 결과의 Note 로 판단하지 않는다.
  - 탭을 넘겨줄 때는 탭 id 가 아니라 **주소**를 넘긴다. id 는 세션·재시작을 넘어 같은 탭을 가리킨다는 보장이 없다.

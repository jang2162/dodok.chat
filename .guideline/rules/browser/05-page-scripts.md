---
load: reference
when: "Playwright 같은 페이지 자동화 스크립트로 비동기로 정해지는 값을 기다릴 때"
---

# 페이지 자동화 스크립트로 기다릴 때

## `waitForFunction` 에 async 함수를 주지 않는다

Playwright 의 `page.waitForFunction` 에는 **값을 바로 돌려주는 동기 함수**만 준다. 비동기로만 읽히는 값(캐시 저장소·IndexedDB·`fetch` 결과 등)을 기다릴 때는 `page.evaluate` 로 값을 받아 스크립트 쪽 루프에서 판정한다.

```js
// 하지 않는다 — 끝내 참이 되지 않아도 바로 통과한다
await page.waitForFunction(async () => (await caches.keys()).length > 0);

// 한다
const deadline = Date.now() + 10_000;
while (!(await page.evaluate(async () => (await caches.keys()).length > 0))) {
  if (Date.now() > deadline) throw new Error("캐시가 채워지지 않았다");
  await page.waitForTimeout(200);
}
```

- **Why:** `waitForFunction` 은 async 함수가 돌려준 **Promise 객체 자체를 참으로 보고** 곧바로 끝난다. 값이 끝내 참이 되지 않아도 시간 초과 없이 통과하므로, 그 뒤의 확인은 **아직 준비되지 않은 상태를 「준비됨」으로 읽는다.** 오류가 나지 않아 거짓 양성으로 남는다.
- **How to apply:**
  - 기다리는 함수에 `async`·`await` 가 보이면 `evaluate` 루프로 바꾼다.
  - 동기로 읽히는 값(`window` 의 변수, DOM 상태)은 `waitForFunction` 을 그대로 써도 된다.
  - 의심되면 절대 참이 되지 않는 조건으로 한 번 돌려 본다 — 시간 초과가 나야 정상이다.

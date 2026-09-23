# 콘솔과 네트워크

## 페이지를 열자마자 콘솔을 읽으면 비어 있는 것이 정상처럼 보인다

- **Why:** 콘솔 리스너가 **로드 뒤에 붙는** 도구가 있다. 그러면 첫 로드 시점에 터진 예외도, 그때 찍힌 로그도 **한 줄도 안 남고** 응답은 「오류·경고 없음」이다. **없는 것과 못 본 것이 같은 모양으로 나온다.**
- **How to apply:**
  - **열고 → `reload()` → 콘솔 읽기** 순서로 한다. 그래야 로드 시점 것까지 잡힌다.
  - 버퍼는 reload 를 넘어 **누적**되므로, 「이번 로드에서 난 것」만 보려면 그 점을 감안한다.
  - **도구가 무엇을 모으는지 먼저 확인한다.** 경고·오류만 모으고 `log`·`info` 는 버리는 도구가 있다 — 그런 도구에서 「로그가 안 찍혔다」는 **코드가 안 돌았다는 증거가 아니다.**

## 콘솔·네트워크를 못 모으는 도구에서는 페이지에 기록기를 심는다

CDP 를 붙이기 어려운 상황이면 페이지 컨텍스트에서 후킹해 대신한다. **심은 뒤에 일어난 것만 잡힌다**(로드 시점은 여전히 못 본다).

```js
// console 전 레벨
window.__logs = [];
for (const lv of ['log','info','debug','warn','error']) {
  const orig = console[lv].bind(console);
  console[lv] = (...a) => { window.__logs.push({ lv, msg: a.map(String).join(' ') }); orig(...a); };
}

// XHR
window.__net = [];
const OX = XMLHttpRequest.prototype.open, SX = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__m = m; this.__u = u; return OX.call(this, m, u, ...r); };
XMLHttpRequest.prototype.send = function (body) {
  this.addEventListener('loadend', () => window.__net.push({
    method: this.__m, url: this.__u, status: this.status,
    reqBody: body && String(body).slice(0, 200), resBody: (this.responseText || '').slice(0, 200)
  }));
  return SX.call(this, body);
};
```

- **How to apply:** 페이지가 `fetch` 로 나가면 `fetch` 도 같이 감싼다. **성능 항목으로 네트워크를 대신 재지 않는다** — cross-origin 이면 **상태 코드가 대개 `0`** 이고 헤더·본문은 보이지 않아, 실패를 성공으로 읽는다.

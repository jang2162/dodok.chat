---
categories: [agent]
requires: [rules/codegraph]
---

# codegraph

tree-sitter 로 파싱한 **심볼·호출 관계 그래프**를 조회하는 MCP 서버다(`@colbymchenry/codegraph`). 「누가 이 함수를 부르나」, 「이걸 바꾸면 무엇이 깨지나」 같은 구조 질문을 grep·Read 반복 없이 한 번에 답한다.

## 맞는 스택·프로젝트

코드가 있는 프로젝트 어디에나 맞는다. 스택을 가리지 않는다.

**인덱스가 있는 프로젝트에서만 쓸모가 있다.** 서버는 인덱스 없이도 뜨지만 조회할 것이 없다. 인덱스는 그 프로젝트 루트에서 사람이 만든다.

```bash
npx -y @colbymchenry/codegraph init
```

인덱스는 프로젝트 루트의 `.codegraph/` 에 생긴다. 만들지 말지는 그 프로젝트 사람이 정한다 — 에이전트가 알아서 만들지 않는다.

## 환경 변수

필요 없다.

- **텔레메트리:** 기본값으로 익명 사용 통계(쓴 도구·명령, 인덱싱한 언어)를 보낸다. 코드·경로·심볼 이름은 보내지 않는다고 패키지 문서가 밝힌다. 끄려면 셸 환경에 `CODEGRAPH_TELEMETRY=0` 을 export 하거나 `npx -y @colbymchenry/codegraph telemetry off` 를 한 번 돌린다.

## 전역에 이미 설치한 사람

`codegraph` 를 전역으로 설치해 사용자 범위 MCP 로 등록해 둔 사람도 그대로 둬도 된다. 같은 이름이면 Claude Code 는 프로젝트 범위 설정을 쓴다.

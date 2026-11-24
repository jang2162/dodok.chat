---
categories: [agent]
---

# context7

라이브러리·프레임워크·CLI 의 **현재 버전 문서**를 조회하는 MCP 서버다(`@upstash/context7-mcp`). 학습 데이터보다 새 API·설정·마이그레이션 방법을 확인할 때 쓴다.

## 맞는 스택·프로젝트

외부 라이브러리를 쓰는 프로젝트 어디에나 맞는다. 스택을 가리지 않는다.

## 환경 변수

없어도 동작한다.

| 변수 | 필수 | 용도 |
| --- | --- | --- |
| `CONTEXT7_API_KEY` | 아니오 | 요청 한도를 올리고 비공개 저장소 문서를 조회한다 |

- **발급:** [context7.com/dashboard](https://context7.com/dashboard) 에서 계정을 만들면 받는다.
- **설정:** 키가 있는 사람만 셸 환경에 `CONTEXT7_API_KEY` 를 export 한다. 서버가 그 환경 변수를 직접 읽으므로 `server.json` 에는 넣지 않는다 — 넣으면 키가 없는 사람의 설정에서 참조가 비어 버린다.

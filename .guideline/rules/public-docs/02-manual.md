---
load: reference
when: "사용자 문서(docs/manual/)를 만들거나 README 에서 내용을 나눠 옮길 때"
---

# 사용자 문서 구성

## README 가 길어지면 사용자 문서는 `docs/manual/` 아래 언어 폴더로 나눈다

README 가 화면 세 장을 넘거나 설정·API 설명이 길어지면 `docs/manual/` 로 나눈다. README 는 입구, `docs/manual/` 은 상세 안내다.

```text
repo/
├── README.md              # English (원본)
├── README.ko.md           # 한국어
├── CHANGELOG.md           # 버전별 변경 이력 (영어)
├── CONTRIBUTING.md        # 기여 방법 (영어)
├── LICENSE
├── .github/
│   └── FUNDING.yml        # 후원 설정 (승인된 플랫폼이 있을 때)
└── docs/
    └── manual/
        ├── README.md      # 언어 선택 + 목차
        ├── glossary.md    # 영어 원어 ↔ 번역어 대응표
        ├── en/            # English (원본)
        │   ├── getting-started.md
        │   ├── how-to/
        │   │   └── <topic>.md
        │   ├── configuration.md
        │   ├── reference.md
        │   └── troubleshooting.md
        ├── ko/            # 한국어 — en/ 과 같은 구조·파일 이름
        └── images/        # 언어 공통 이미지
            └── ko/        # 한국어 UI 가 보이는 스크린샷
```

목표별 안내 폴더는 `guides/` 가 아니라 `how-to/` 로 짓는다.

- **Why:** `base` 「문서를 어디에 두는가」 는 `docs/` 바로 아래에 문서를 두지 않고, 사용자 매뉴얼을 `docs/manual/` 갈래에 둔다. `docs/guides/` 는 그 규칙에서 개발 규칙의 정본 자리라, 사용자 안내를 `guides` 라 부르면 두 갈래가 이름으로 섞인다.
- **How to apply:** 개발자용 문서(`docs/guides/`·`docs/api/`·`docs/adr/` 등)는 `base` 의 갈래를 따른다. README 의 Documentation 섹션은 `docs/manual/<lang>/` 의 문서만 링크한다.

## 문서마다 목적이 하나이고, 위에 요약을, 아래에 다음 문서를 둔다

| 문서 | 목적 | 쓰는 방식 |
| --- | --- | --- |
| `getting-started` | 처음 쓰는 사람이 첫 결과를 얻는다 | 번호 매긴 단계, 단계마다 예상 결과 |
| `how-to/<topic>` | 특정 목표를 이룬다(「~하는 방법」) | 문서 하나에 목표 하나 |
| `configuration` | 설정값을 찾아본다 | 항목 · 타입 · 기본값 · 설명 표 |
| `reference` | 명령·API 를 정확히 확인한다 | 빠짐없이, 같은 형식 반복 |
| `troubleshooting` | 오류를 해결한다 | 증상 → 원인 → 해결 순서 |

각 문서 맨 위에는 한 문장 요약과 대상 독자를, 맨 아래에는 다음에 읽을 문서 링크를 둔다.

- **Why:** 독자는 「처음 해 보기」·「무엇을 하는 법」·「값 찾기」·「오류 해결」 중 하나를 하러 온다. 목적이 섞인 문서에서는 지금 필요한 부분을 찾아야 한다.
- **How to apply:** 새 내용을 쓰기 전에 위 다섯 중 어느 문서의 목적인지 고른다. 둘에 걸치면 나눈다.

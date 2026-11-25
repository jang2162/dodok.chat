---
load: reference
when: "README 나 사용자 문서에 스크린샷·GIF·다이어그램을 넣거나 바꿀 때"
---

# 이미지·GIF

## UI 가 있으면 README 소개 앞에 대표 이미지나 데모 GIF 하나를 넣는다

이미지는 설명을 보조한다. 이미지 없이 본문만 읽어도 이해되게 쓴다.

| 종류 | 언제 쓰나 | 규격 | 형식 |
| --- | --- | --- | --- |
| 대표 스크린샷 | 결과 화면을 한눈에 보일 때 | 가로 1200~1600px, 500KB 이하 | PNG |
| 데모 GIF | 동작 흐름(입력 → 결과)을 보일 때 | 10초 이내, 가로 800px, 5MB 이하 | GIF 또는 MP4 |
| 터미널 녹화 | CLI 도구 사용 예시 | 10초 이내, 글자가 읽히는 크기 | GIF, SVG(asciinema 등) |
| 구조 다이어그램 | 동작 원리·아키텍처 설명 | 글자 14px 이상 | SVG 또는 Mermaid |
| 단계별 캡처 | `docs/manual/` 의 따라 하기 문서 | 필요한 영역만 자르고, 강조는 빨간 테두리 1개 | PNG |

- **Why:** 30초 안의 판단은 실제로 어떻게 생겼는지 보는 데서 가장 빨리 난다.
- **How to apply:** 폭을 맞출 때는 HTML 태그를 쓴다 — `<img src="docs/manual/images/demo.gif" width="700" alt="...">`. 다이어그램은 되도록 Mermaid 코드 블록으로 쓴다. GitHub 에서 바로 그려지고 글로 고칠 수 있다.

## 이미지는 저장소의 `docs/manual/images/` 에 두고, 모든 이미지에 alt 를 단다

- 파일은 `docs/manual/images/` 에 모은다. 화면 언어가 달라 따로 캡처할 때만 `docs/manual/images/<lang>/` 에 둔다. 외부 이미지 호스팅 링크는 쓰지 않는다.
- 파일 이름은 내용을 알 수 있는 영문 소문자 kebab-case 로 짓는다(`dashboard-overview.png`, `demo-install.gif`).
- alt 는 무엇이 보이는지 한 문장으로 쓴다 — `![Entering an API key on the settings screen](docs/manual/images/settings-api-key.png)`.
- 개인 정보, 실제 API 키, 내부 URL, 사내 데이터가 보이지 않게 가린다.
- 라이트·다크 모드 모두에서 보이도록 투명 배경 이미지를 피하거나, `<picture>` 태그로 모드별 이미지를 준다.
- UI 가 바뀌면 이미지도 함께 바꾼다.

- **Why:** 외부 호스팅 링크는 저장소 밖에서 깨진다. 이미지를 `docs/` 바로 아래에 두면 `base` 「문서를 어디에 두는가」 의 갈래를 깨고, 두 자리(`docs/images/`·`.github/assets/`)로 나누면 같은 이미지가 어디 있는지 찾아야 한다.
- **How to apply:** 공개 전에는 이 스택 「배포 전 확인」 의 이미지 항목으로 확인한다.

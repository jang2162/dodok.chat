# Git Repo Stack 구성

## Stack 설정은 저장소 문서에 표로 남긴다

Komodo Stack 의 설정은 Komodo 안에만 있고 저장소에서는 보이지 않는다. 저장소의 README 나 `docs/` 에 아래 항목을 표로 적어 둔다.

| 항목 | 적을 것 |
| --- | --- |
| Name | Stack 이름. compose project 이름이 된다(`project_name` 을 따로 주지 않으면) |
| Server | 배치할 Komodo 서버 |
| Source | Git Repo — `git_provider` / `repo`(`<소유자>/<저장소>`) / `branch`. 비공개 저장소는 Komodo 에 등록한 `git_account` |
| File Paths | compose 파일 목록과 **순서**(→ `02-override.md`) |
| Environment | 키 목록과 설명(→ `01-environment.md`) |
| Webhook | 켬/끔과 그 이유 |
| override 파일 | 서버에서 직접 쓰는 파일이면 이름, 호스트 경로↔Periphery 컨테이너 경로 대응(→ `02-override.md`) |

- **Why:** Stack 을 지우거나 다른 서버에 다시 만들 때 설정을 기억에서 복원해야 한다. 순서가 중요한 `File Paths` 를 빠뜨리면 덮어쓰기 파일이 빠진 채 올라간다.
- **How to apply:** Stack 을 바꾸면 같은 커밋에서 이 표도 고친다.

## 저장소는 서버의 Komodo 디렉터리에 clone 된다 — 호스트 경로를 compose 에 박지 않는다

compose 의 상대 경로 바인드 마운트(`./data`)는 clone 된 디렉터리 안을 가리킨다. 그 디렉터리는 Komodo 가 관리하는 자리지 데이터를 두는 자리가 아니다. 영속 데이터·설정의 **호스트 경로는 환경 변수로 받는다.**

```yaml
volumes:
  - ${DATA_HOST_DIR:?DATA_HOST_DIR is required}:/data
```

- **Why:** 호스트 경로를 파일에 박으면 서버마다 다른 값을 쓰지 못한다. 상대 경로로 두면 데이터가 Komodo 의 clone 디렉터리 안에 쌓인다.
- **How to apply:** 호스트 경로는 Stack Environment 로 넣는다. 서버 전용 고정 경로는 덮어쓰기 파일에 둘 수도 있다(→ `02-override.md`).

## 이미지를 저장소 코드로 빌드하면 `pull_policy: build` 를 쓴다

레지스트리에 없는 이미지(`build:` 로 만드는 것)는 `pull_policy: build` 를 둔다.

```yaml
services:
  app:
    build: .
    image: app:local
    pull_policy: build   # 레지스트리 이미지가 아니다: pull 은 건너뛰고 up 할 때마다 저장소 코드로 빌드
```

- **Why:** 레지스트리에 없는 이미지를 pull 하려 하면 배포가 실패하거나, 서버에 남은 옛 이미지가 그대로 쓰인다.
- **How to apply:** 레지스트리 이미지를 쓰는 서비스는 이 줄을 두지 않는다.

## 이 Stack 의 재배포가 서비스를 끊는지 보고 Webhook 을 정한다

Komodo 의 Stack Webhook 은 push 때 `/deploy` 로 재배포한다. 재배포는 컨테이너를 다시 만든다.

- **Why:** 다른 작업(진행 중인 배포, 긴 처리)을 하는 서비스는 push 마다 재배포되면 그 작업이 끊긴다.
- **How to apply:**
  - 끊겨도 되는 서비스는 Webhook 을 켠다. 끊기면 안 되는 서비스는 끄고 사람이 Komodo 에서 Deploy 한다.
  - 정한 값과 이유를 Stack 설정 표(위)에 적는다.

## 컨테이너 이름은 서버 전체에서 하나뿐이다

`container_name` 을 쓰면 같은 Komodo 서버의 다른 Stack·수동 컨테이너와 겹치지 않아야 한다. 겹치면 컨테이너를 만들지 못해 배포가 실패한다.

- **Why:** Docker 의 컨테이너 이름은 compose project 와 상관없이 서버 안에서 유일하다.
- **How to apply:** 이름을 정하지 않아도 되면 `container_name` 을 쓰지 않는다. 쓰면 앞에 서비스·프로젝트 이름을 붙인다.

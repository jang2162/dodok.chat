# Git Repo Stack 구성

## 서버별 값은 저장소 문서에 적지 않는다 — Komodo 서버 이름·호스트 경로·프록시 네트워크 이름·레지스트리 계정

저장소의 compose 파일과 문서는 누가 어느 Komodo 서버에 올려도 그대로 쓰이게 쓴다. Komodo 서버 이름, Periphery clone 디렉터리의 호스트 경로, 프록시 네트워크 이름, 레지스트리 계정은 문서에 쓰지 않고, 모른다고 `<…>` 빈칸으로 남기지도 않는다. 이 값은 각자 Komodo 에서 설정한다.

- **Why:** 이 값은 서버마다 다르고 저장소에서 알 수 없다. 문서에 적으면 다른 서버에서 틀리고, 빈칸으로 두면 채워지지 않은 채 남는다. 사용자는 Komodo 에서 직접 고르거나 입력하므로 문서에 있을 필요가 없다.
- **How to apply:**
  - 서버마다 달라지는 값은 환경 변수(`${VAR:?}`)나 서버에서 쓰는 override 파일이 갖게 하고, 문서에는 변수 이름과 의미만 적는다(→ `01-environment.md`).
  - 에이전트는 이 값들을 사용자에게 묻거나 보고에서 「채울 값」으로 세지 않는다.

## 배포 가이드는 Docker 기준으로 쓴다 — Komodo 에 한정하지 않는다

저장소에 배포 가이드가 필요하면 `docker compose` 로 올리는 방법(필요한 파일, 환경 변수, 실행·확인 명령)을 쓴다. Komodo 는 그 compose 를 올리는 여러 방법 중 하나다. Komodo 를 전제로 한 단계(Stack 만들기, UI 조작)로 가이드를 채우지 않는다.

- **Why:** Komodo 에 한정한 가이드는 Komodo 를 쓰지 않는 환경(로컬, 다른 서버)에서 쓸 수 없다. 이 스택이 갖는 것은 Komodo 에서 배포하기 쉬운 compose·override·환경 변수 구성이지 가이드의 틀이 아니다.
- **How to apply:** 가이드 본문은 Docker 기준으로 쓴다. 아래 Stack 설정 표는 가이드 본문에 섞지 않고 따로(부록이나 별도 파일) 둔다.

## Stack 설정은 저장소 문서에 표로 남긴다

Komodo Stack 의 설정은 Komodo 안에만 있고 저장소에서는 보이지 않는다. 저장소의 README 나 `docs/` 에 아래 항목을 표로 적어 둔다.

| 항목 | 적을 것 |
| --- | --- |
| Name | Stack 이름. compose project 이름이 된다(`project_name` 을 따로 주지 않으면) |
| Source | Git Repo — `git_provider` / `repo`(`<소유자>/<저장소>`) / `branch`. 비공개 저장소는 Komodo 에 등록한 `git_account` |
| File Paths | compose 파일 목록과 **순서**(→ `02-override.md`) |
| Environment | 키 목록과 설명(→ `01-environment.md`) |
| Webhook | 켬/끔과 그 이유 |
| override 파일 | 서버에서 직접 쓰는 파일이면 이름과 내용(→ `02-override.md`) |

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

# 서버용 override 파일

Komodo 에는 override 파일을 UI 에서 쓰는 기능이 없다. 서버에서만 달라지는 것(네트워크, 호스트 경로 볼륨, 포트 개방 여부 등)은 **Periphery 가 clone 한 디렉터리에 호스트에서 직접 `compose.override.yaml` 을 쓰고**, Stack 의 `File Paths` 로 지정한다. `compose.yaml` 은 로컬에서도 돌게 쓰고, 이 파일에는 **달라지는 키만** 쓴다(서비스 전체를 복사하지 않는다).

- **Why:** 서버 설정을 기본 파일에 섞으면 로컬 실행이 깨지거나 서버 값이 로컬에 새고, 둘을 같이 고치다 한쪽을 빠뜨린다.
- **How to apply:** 아래 절을 순서대로 따른다. 서버마다 값이 같고 커밋해도 되면 파일을 저장소에 커밋하는 방법도 있다. 그때는 ignore 절과 재 clone 절은 필요 없다.

## 먼저 Periphery 컨테이너 설정에서 clone 디렉터리의 호스트 경로를 확인한다

Periphery 는 저장소를 `{stack_dir}/{Stack 이름}/{clone_path}` 에 clone 한다. `stack_dir` 의 기본값은 `{root_directory}/stacks` 이고 `root_directory` 의 기본값은 `/etc/komodo` 다. 이 경로가 호스트의 어디인지는 Periphery 컨테이너 정의에서 읽는다.

- Periphery 컨테이너 정의에서 `root_directory`·`stack_dir` 을 바꾸는 값(환경 변수 `PERIPHERY_ROOT_DIRECTORY` 등)이 있는지 본다. 없으면 기본값이다.
- `volumes` — `root_directory`(또는 `stack_dir`)가 호스트의 어느 디렉터리에 바인드돼 있는지 본다. 바인드돼 있지 않으면 호스트에서 파일을 쓸 수 없다.

- **Why:** 컨테이너 안의 경로와 호스트 경로는 다르다. 바인드된 곳을 모르고 호스트에 파일을 쓰면 Periphery 가 보지 못하고, `File Paths` 에 적어도 `docker compose` 가 파일을 찾지 못해 배포가 실패한다.
- **How to apply:**
  - 확인한 호스트 경로는 저장소 문서에 적지 않는다(→ `00-stack.md` 「서버별 값은 저장소 문서에 적지 않는다」). 서버에서 파일을 쓰는 사람이 이 절로 확인한다.
  - 바인드가 없거나 `root_directory` 를 알 수 없으면 쓰기 전에 서버 관리자에게 묻는다.

## override 파일은 `File Paths` 에 기본 파일 뒤로 직접 적는다 — Komodo 는 자동으로 읽지 않는다

```
호스트: <바인드된 호스트 경로>/<Stack 이름>/compose.override.yaml
File Paths:
  compose.yaml
  compose.override.yaml
```

Komodo 는 이를 `docker compose -f compose.yaml -f compose.override.yaml` 로 실행한다. 뒤 파일이 앞 파일을 덮어쓰고 새 항목을 더한다. Docker Compose 는 `-f` 를 주지 않을 때만 `compose.override.yaml` 을 자동으로 읽으므로, Komodo 에서는 `File Paths` 에 없으면 무시된다.

- **Why:** 로컬에서는 `docker compose up` 이 이 파일을 자동으로 읽어 되던 구성이, Komodo 에서는 `File Paths` 에 적지 않으면 조용히 빠진다. 순서가 뒤바뀌면 기본 파일이 override 를 덮어쓴다.
- **How to apply:** 파일을 쓴 뒤 서버에서 `docker compose -f compose.yaml -f compose.override.yaml config` 로 결과를 확인하고 Deploy 한다. 파일 이름과 순서를 Stack 설정 표(`00-stack.md`)에 적는다.

## override 파일은 저장소에서 ignore 한다

저장소의 `.gitignore` 에 그 파일 이름을 올린다. 파일은 서버에만 있고 커밋되지 않는다.

```gitignore
# Komodo 서버에서 직접 쓰는 override. 서버마다 다르며 커밋하지 않는다
/compose.override.yaml
```

- **Why:** Periphery 는 갱신할 때 `git checkout -f` 와 `git pull --rebase --force` 를 실행한다(`git clean` 은 하지 않는다). untracked 파일은 남지만, **같은 이름의 파일이 저장소에 추적되기 시작하면** 갱신이 그 파일에서 충돌한다. ignore 하지 않으면 누군가 서버 파일을 `git add` 해 커밋하거나, 개발자가 같은 이름을 커밋해 충돌을 만든다.
- **How to apply:**
  - `.gitignore` 에 추가한 뒤 그 파일이 이미 추적 중이 아닌지 본다(`git ls-files compose.override.yaml` 이 비어야 한다). 추적 중이면 `git rm --cached` 로 뺀다.
  - **저장소가 이미 커밋된 `compose.override.yaml`(개발용 공용 설정 등)을 갖고 있으면 이 이름을 쓰지 않는다.** 서버용 파일 이름을 다르게 정해(예: `compose.server.yaml`) 이 절과 위 절의 이름을 바꾼다.
  - `.gitignore` 자체는 저장소에 커밋되므로, Periphery 가 clone 한 서버에도 같은 ignore 가 적용된다.

## clone 을 다시 하면 서버에서 쓴 파일이 지워진다 — 내용을 저장소 밖에도 남긴다

Periphery 는 clone(재 clone 포함) 때 대상 디렉터리를 통째로 지우고 다시 clone 한다. untracked·ignored 파일도 함께 사라진다. 갱신(pull)은 지우지 않는다.

- **Why:** Stack 을 지웠다 다시 만들거나, Stack 이름·저장소·브랜치를 바꿔 다시 clone 되면 override 파일이 조용히 사라진다. 그 상태로 Deploy 하면 `File Paths` 의 파일이 없어 실패하거나, 파일이 없어도 되는 구성이면 기본 설정(닫으려던 포트가 열린 상태 등)으로 올라간다.
- **How to apply:**
  - override 파일의 내용(비밀값 제외)을 저장소의 배포 문서에 그대로 적어 둔다. 비밀값은 `${VAR}` 로 두고 값은 Stack Environment 에 둔다(`01-environment.md`).
  - Stack 을 다시 만들거나 clone 이 다시 일어나는 변경 뒤에는 override 파일이 있는지 먼저 본다.

## 리스트 항목(`ports`·`volumes`·`networks`)은 합쳐진다 — 바꾸려면 `!override`, 없애려면 `!reset`

덮어쓰기 파일에 `ports` 를 쓰면 기본 파일의 포트가 **사라지지 않고 더해진다.** `volumes` 는 마운트 대상(target)이 같은 것만 바뀌고 나머지는 남는다. `networks` 도 합쳐진다(`default` 가 남는다).

| 하고 싶은 것 | 덮어쓰기 파일 |
| --- | --- |
| 포트를 다른 값으로 **바꾼다** | `ports: !override` 다음에 새 목록 |
| 포트를 **모두 닫는다** | `ports: !reset []` |
| 볼륨을 서버 경로로 **통째로 바꾼다** | `volumes: !override` 다음에 새 목록 |
| 네트워크를 지정한 것으로 **바꾼다** | `networks: !override` 다음에 새 목록 |
| 마운트 하나만 바꾼다 | 같은 target 으로 다시 쓴다(`!override` 불필요) |

```yaml
# compose.override.yaml
services:
  app:
    ports: !reset []              # 기본 파일의 "8080:80" 을 닫는다. 외부 접근은 프록시를 통해서만
    volumes: !override
      - ${DATA_HOST_DIR:?DATA_HOST_DIR is required}:/data
    networks: !override
      - proxy                       # default 를 빼고 외부 네트워크만 쓴다

networks:
  proxy:
    external: true
```

- **Why:** 로컬에서 `-f` 두 개로 `docker compose config` 를 돌려 확인한 동작이다. `!override`·`!reset` 없이 `ports: ["9090:80"]` 만 쓰면 `8080` 과 `9090` 이 모두 열린다. 서버에서 닫으려던 포트가 열린 채 배포된다.
- **How to apply:**
  - `!reset`·`!override` 는 오래된 Compose 에서는 읽히지 않는다. 서버 Compose 에서 같은 `config` 명령이 되는지 확인한다(`docker compose version`).
  - 덮어쓴 결과를 로컬에서 확인한다: `docker compose -f compose.yaml -f compose.override.yaml config` 에서 `ports`·`volumes`·`networks` 를 본다.
  - `networks` 를 `!override` 하면 `default` 도 빠진다. 같은 Stack 안의 서비스끼리 통신해야 하는 서비스는 `default` 도 목록에 쓴다.

## 외부 네트워크는 `external: true` 로 선언하고, 서버에 먼저 있어야 한다

이미 서버에 있는 네트워크(프록시와 공유하는 것 등)에 붙으려면 최상위 `networks` 에 `external: true` 로 선언한다.

```yaml
networks:
  proxy:
    external: true
```

- **Why:** `external` 이 아니면 compose 가 `<project>_proxy` 라는 새 네트워크를 만들어 프록시와 같은 네트워크에 있지 않다. `external: true` 인데 서버에 그 네트워크가 없으면 `up` 이 실패한다.
- **How to apply:** 서버에 그 네트워크가 미리 있어야 한다는 점만 배포 문서에 적는다. 네트워크 이름은 서버 전용 override 파일이 갖고 문서에 적지 않는다.

## 프록시 뒤에 두는 서비스는 서버용 파일에서 `ports` 를 `!reset` 한다

프록시가 같은 네트워크에서 컨테이너 이름으로 접근하면 호스트 포트가 필요 없다.

- **Why:** 호스트 포트를 열어 두면 프록시를 거치지 않는 접근 경로가 생기고, 같은 서버의 다른 Stack 과 호스트 포트가 겹치면 `up` 이 실패한다.
- **How to apply:** 기본 파일은 로컬 확인용으로 `ports` 를 둘 수 있고, 서버용 덮어쓰기 파일에서 `ports: !reset []` 한다. 서버에서만 열어야 하면 기본 파일에는 두지 않고 덮어쓰기 파일에 쓴다.

## 덮어쓰기에 쓰는 환경 변수도 `${VAR:?}` 로 필수 표시한다

서버용 파일이 `${DATA_HOST_DIR}` 같은 값을 쓰면 `01-environment.md` 의 규칙이 그대로 적용된다. 값을 서버용 파일에 직접 박을 수도 있다(그 서버에서만 쓰는 고정 경로·네트워크 이름).

- **Why:** 서버 전용 고정값은 파일에 있어야 리뷰되고, 서버마다 달라질 값은 Environment 에 있어야 서버를 옮길 때 바꾼다.
- **How to apply:** 서버가 하나뿐이고 바뀔 일이 없는 값(네트워크 이름 등)은 파일에, 서버마다 다르거나 비밀인 값(경로, 비밀번호)은 Environment 에 둔다.

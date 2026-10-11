# 배포 환경 변수

## Stack Environment 는 compose 의 보간용 `.env` 가 된다 — 컨테이너로 넘기려면 `environment:` 에 쓴다

Komodo 는 Stack 의 Environment 를 `.env` 파일(기본 `env_file_path: .env`)로 써서 `--env-file` 로 `docker compose` 에 준다. 이 값은 **compose 파일 안의 `${VAR}` 를 채우는 데** 쓰인다. 컨테이너 환경 변수로는 자동으로 들어가지 않는다.

```yaml
services:
  app:
    environment:
      DB_HOST: ${DB_HOST:?DB_HOST is required}   # 이렇게 써야 컨테이너가 받는다
```

- **Why:** Environment 에 키를 넣고 compose 의 `environment:` 에 안 쓰면 값은 서버에 있는데 앱은 못 받는다. 오류도 없다. (로컬에서 `.env` 에 `FOO=1` 만 두고 `docker compose config` 를 해 봐도 컨테이너 환경에 `FOO` 가 없다.)
- **How to apply:** 새 변수는 compose 의 `environment:`(또는 서비스의 `env_file`)에 쓴 뒤 Stack Environment 에 넣는다.

## 필수값은 `${VAR:?메시지}`, 선택값은 `${VAR:-기본값}` 으로 쓴다

```yaml
API_URL: ${API_URL:?API_URL is required}   # 없으면 up 단계에서 바로 실패
LOG_LEVEL: ${LOG_LEVEL:-info}              # 없으면 info
```

- **Why:** 아무 표기 없는 `${VAR}` 는 값이 없으면 빈 문자열이 되어, 앱이 떠도 잘못 설정된 채 돈다. `:?` 는 배포를 compose 단계에서 멈춘다.
- **How to apply:** 기본값이 있어도 안전한지(운영에서 틀리면 곤란한 값이 아닌지) 보고 `:-` 를 쓴다. 비밀값·접속 주소에는 기본값을 두지 않는다.

## 비밀값은 저장소에 두지 않고 Komodo Variables(Secret)에서 `[[KEY]]` 로 참조한다

Stack Environment 에서 `[[KEY]]` 는 Komodo 의 Variable 값으로 치환된다. Secret 으로 등록하면 값이 API 로 노출되지 않는다.

```
DB_PASSWORD=[[APP_DB_PASSWORD]]
API_TOKEN=[[APP_API_TOKEN]]
```

- **Why:** compose 와 저장소 문서는 커밋되어 이력에 남는다. Environment 에 평문을 쓰면 그 Stack 을 볼 수 있는 사람에게 값이 보인다.
- **How to apply:**
  - Variable 이름에 앱 이름을 앞에 붙인다(`<앱>_DB_PASSWORD`). Variable 은 Komodo 전체가 공유한다.
  - `.env` 파일·`environment:` 에 비밀값을 커밋하지 않는다. compose 에는 `${DB_PASSWORD:?...}` 참조만 둔다.

## 환경 변수 목록을 저장소에 문서로 남긴다

Stack Environment 에 넣을 키 전부를 저장소의 `.env.example` 이나 배포 문서의 표로 적는다.

| 키 | 필수 | 설명 | 예시 |
| --- | --- | --- | --- |
| `DATA_HOST_DIR` | 필수 | 영속 데이터를 둘 호스트 경로 | `/data/app` |
| `LOG_LEVEL` | 선택(`info`) | 로그 수준 | `debug` |
| `DB_PASSWORD` | 필수(비밀) | DB 비밀번호. `[[<앱>_DB_PASSWORD]]` 로 참조 | |

- **Why:** compose 의 `${…}` 를 읽어야만 필요한 키를 알 수 있으면, 새 서버에 Stack 을 만들 때 빠뜨린다. 필수값 누락은 `up` 에서야 드러난다.
- **How to apply:**
  - 필수/선택, 기본값, 의미, 비밀 여부를 적는다. 비밀값은 예시에 실제 값을 쓰지 않는다.
  - compose 에 변수를 추가·삭제하면 같은 커밋에서 이 목록도 고친다.
  - `.env.example` 은 compose 의 로컬 실행용으로도 쓸 수 있게 두되, 실제 `.env` 는 커밋하지 않는다(`.gitignore`).

## Environment 를 바꾼 뒤에는 Deploy 를 다시 한다

- **Why:** `.env` 는 배포 때 쓰이고, 떠 있는 컨테이너의 환경은 `up` 때 정해진다. Environment 만 저장하고 Deploy 하지 않으면 컨테이너는 옛 값으로 돈다.
- **How to apply:** Environment 변경 후 Stack 을 Deploy 한다.

## 여러 곳에서 나눠 받을 값은 `additional_env_files` 를 쓴다

저장소에 커밋해도 되는 기본 값(비밀 아님)은 파일로 두고, Stack 설정의 `additional_env_files`(run directory 기준 상대 경로)에 걸 수 있다. Komodo 가 쓰는 `.env` 는 마지막에 걸려 **가장 우선한다.**

- **Why:** 서버마다 다른 값만 Stack Environment 에 두면 Environment 가 짧아지고, 공통 기본값은 저장소에서 리뷰된다.
- **How to apply:** 파일 이름을 문서화한 표에 적는다. 같은 키가 둘 다 있으면 Stack Environment 가 이긴다는 점을 문서에 남긴다.

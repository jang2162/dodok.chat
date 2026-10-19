# 부록 — Komodo Git Repo Stack 으로 올리기

dodok 을 [Komodo](https://komo.do) 의 **Git Repo Stack** 으로 올릴 때의 Stack 설정이다. 설치 절차·`.env` 의 뜻·운영은 `docs/guides/deploy.md` 가 정본이고 `docker compose` 기준이다 — 이 부록은 그 절차를 Komodo 로 부를 때 Komodo 안에만 남는 설정을 적는다. Stack 을 바꾸면 같은 커밋에서 이 표도 고친다.

Komodo 서버 이름, Periphery 가 clone 하는 호스트 경로, 바깥 프록시 네트워크 이름은 서버마다 달라 여기 적지 않는다 — Komodo 에서 고르거나 Environment 에 넣는다.

## Komodo 가 부르는 명령

Komodo 의 Periphery 는 저장소를 `<stack_dir>/<Stack 이름>/<clone_path>` 에 clone(이미 있으면 pull)하고, 그 아래 Run Directory 에 Environment 를 `.env`(`env_file_path`)로 쓴 뒤, Run Directory 에서 다음 꼴로 부른다(Environment 가 비면 `.env` 를 쓰지 않고 `--env-file` 도 없다).

```
docker compose -p <Stack 이름> -f <File Paths 1> -f <File Paths 2> --env-file .env config
docker compose -p <Stack 이름> -f … --env-file .env build        # Run Build 를 켰을 때만
docker compose -p <Stack 이름> -f … --env-file .env pull         # Auto Pull(기본 켬) — pull_policy: build 라 두 서비스 모두 「No image to be pulled」로 건너뛴다
docker compose -p <Stack 이름> -f … --env-file .env up -d
```

출처: moghtech/komodo `main`(780ac68) 의 `bin/periphery/src/api/compose.rs`(`env_file_args` — 추가 env 파일 다음 Komodo 의 `.env` 를 마지막에 붙인다, `up -d` 명령 줄), `bin/periphery/src/stack/write.rs`(clone 자리·Run Directory·`.env` 를 쓰는 자리), `client/core/rs/src/entities/stack.rs`(필드 기본값 — `project_name` 이 비면 Stack 이름, `env_file_path` 기본 `.env`, `auto_pull`·`webhook_enabled` 기본 켬), 공식 문서 [Docker Compose](https://komo.do/docs/deploy/compose).

이 꼴이 dodok 의 compose 와 맞는 까닭:

- **Run Directory 를 저장소 루트로 두면 `.env` 하나를 둘이 같이 쓴다** — 변수 치환(`${DODOK_DOMAIN}` 등)은 `--env-file .env` 로, 앱 설정은 `infra/compose.yml` 의 `env_file: ../.env` 로 같은 파일을 읽는다. 그래서 본문의 `ln -s ../.env infra/.env` 링크가 필요 없다.
- **`up -d` 에 `--build` 가 없어도 빌드한다** — 두 서비스에 `pull_policy: build` 가 있어 `up` 이 매번 저장소 코드로 빌드한다. 웹 빌드 ID 는 이미지 빌드가 웹 입력의 내용 해시로 정하므로 셸 계산이 없어도 서버만 바뀐 배포에서 그대로다(본문 「기동」).
- `-p <Stack 이름>` 이 `infra/compose.yml` 의 `name: dodok` 을 이긴다 — Stack 이름을 `dodok` 으로 두어야 볼륨 이름(`dodok_dodok-data` 등)이 본문과 같다. 다른 이름이면 볼륨 이름의 앞이 그 이름이 된다.

이 꼴은 로컬에서 흉내 내 확인했다 — 링크 없이 dummy `.env` 를 둔 디렉터리에서 `docker compose -p dodok --env-file .env -f infra/compose.yml [-f infra/compose.server.yml] config` 가 치환되고, `app` 의 환경이 그 `.env` 의 값이며, `pull` 은 두 서비스를 건너뛰었다. 실제 Komodo 로 배포해 보지는 않았다.

## Stack 설정

| 항목 | 값 |
| --- | --- |
| Name | `dodok` — compose 프로젝트 이름이 된다(Project Name 은 비운다) |
| Source | Git Repo — Git Provider·Repo(`<소유자>/<저장소>`)·Branch(`main`). 비공개 저장소면 Komodo 에 등록한 Git Account |
| Run Directory | 비운다(저장소 루트). Komodo 가 여기 `.env` 를 쓴다 |
| File Paths | 프록시 없는 서버: `infra/compose.yml` 하나. 기존 리버스 프록시 뒤: `infra/compose.yml` **다음에** `infra/compose.server.yml` — 순서가 바뀌면 기본 파일이 덮어쓰기를 덮어 Caddy 가 80·443 을 다시 잡는다 |
| Env File Path | 기본 `.env` 그대로 |
| Run Build | 끈다 — `pull_policy: build` 라 `up` 이 빌드한다(켜면 빌드를 한 번 더 부를 뿐이다) |
| Auto Pull | 기본(켬) 그대로 — 두 서비스를 건너뛴다 |
| Destroy Before Deploy | 끈다 — 켜면 배포마다 `down` 뒤 `up` 이라 끊김이 길어진다 |
| Webhook | **끈다**(Komodo 기본은 켬) — 까닭은 아래 |
| Environment | 아래 표 |

**Webhook 을 끄는 까닭** — push 마다 재배포하면 `app` 컨테이너가 다시 만들어지며 그때 돌던 에이전트 런이 `ADAPTER_UNAVAILABLE`(「다시 실행」 카드)로 닫히고, 웹·Gateway 플러그인·Claude 러너의 연결이 모두 끊겼다 다시 붙는다(`app` 의 `stop_grace_period` 15초 안에 깨끗이 내린다). 마이그레이션도 배포 때 돈다 — 본문 「업데이트」는 그 전에 백업을 남기라고 한다. 사람이 백업을 남기고 Komodo 에서 Deploy 한다.

## Environment

Komodo 가 위 `.env` 로 쓴다. 값의 뜻·필수 여부는 본문 「설정 — `.env`」 표가 정본이고, 여기는 Stack 에 넣을 꼴이다. 비밀은 평문으로 쓰지 않고 Komodo Variable(Secret)로 두어 `[[…]]` 로 참조한다 — Variable 은 Komodo 전체가 나눠 쓰니 이름 앞에 `DODOK_` 을 붙인다.

| 키 | 필수 | 꼴 |
| --- | --- | --- |
| `DODOK_DOMAIN` | 필수 | 공개 도메인 |
| `APP_ORIGIN` | 필수 | `https://<도메인>` |
| `LOCAL_AUTH_TOKEN` | 필수(비밀) | `[[DODOK_LOCAL_AUTH_TOKEN]]` |
| `BETTER_AUTH_SECRET` | 필수(비밀) | `[[DODOK_BETTER_AUTH_SECRET]]` |
| `VAPID_SUBJECT` | 필수 | `mailto:<실제 주소>` |
| `TZ` | 선택 | 예 `Asia/Seoul` |
| `BRIDGE_PUBLIC_URL` · `LOG_LEVEL` · `OWNER_HANDLE` · `DODOK_WORKSPACE_NAME` | 선택 | 본문 표 |
| `VAPID_PUBLIC_KEY` · `VAPID_PRIVATE_KEY` | 선택(비밀) | 비우면 서버가 볼륨에 만든다. 주면 `[[DODOK_VAPID_PRIVATE_KEY]]` |
| `APNS_KEY_PATH` · `APNS_KEY_ID` · `APNS_TEAM_ID` · `FCM_SERVICE_ACCOUNT_PATH` | 선택 | 본문 「네이티브 푸시 자격 증명」 |
| `DODOK_PROXY_NETWORK` | 프록시 뒤면 필수 | 바깥 프록시와 함께 쓰는 Docker 네트워크 이름(본문 「기존 리버스 프록시 뒤에 두기」 1) |
| `DODOK_TRUSTED_PROXIES` | 프록시 뒤면 필수 | 바깥 프록시 컨테이너의 주소 `/32`(같은 절 2 — 서브넷 전체를 주지 않는다) |

- `DODOK_WEB_BUILD_ID` 는 넣지 않는다 — 넣으면 웹이 바뀌어도 ID 가 그대로다(본문 「설정 — `.env`」).
- `HOST`·`PORT`·`DATA_DIR`·`TRUST_PROXY` 등 compose 가 고정하는 값은 넣어도 무시된다(본문 표의 「무시된다」 줄).
- Environment 를 바꾼 뒤에는 Deploy 를 다시 한다 — 떠 있는 컨테이너는 옛 값으로 돈다.
- Komodo 는 배포 기록에 `config` 결과(합친 설정 — `env_file` 로 읽은 값 포함)를 남기고, 가리는 것은 Secret Variable 로 치환한 값뿐이다(`compose.rs` 의 `merged_config`). 그래서 비밀은 꼭 `[[…]]` 로 둔다.

## 서버 덮어쓰기 파일(프록시 뒤일 때)

`infra/compose.server.yml` 은 저장소에 없고(`.gitignore`) 서버에서 직접 쓴다. Periphery 가 clone 한 디렉터리(그 호스트 경로는 Periphery 컨테이너 정의의 `root_directory`·`stack_dir` 바인드로 본다)의 `infra/` 에 둔다. 내용은 커밋된 예시를 그대로 복사한 것이다 — 서버마다 다른 값은 Environment 의 `DODOK_PROXY_NETWORK`·`DODOK_TRUSTED_PROXIES` 가 갖는다.

```bash
cp infra/compose.server.example.yml infra/compose.server.yml      # clone 디렉터리에서
```

- 예시가 바뀌면(저장소를 pull 한 뒤 `git diff` 에 `infra/compose.server.example.yml` 이 보이면) 서버의 사본도 다시 복사한다. 갱신(pull)은 사본을 건드리지 않는다.
- ⚠ **clone 을 다시 하면 사본이 사라진다** — Stack 을 지우고 다시 만들거나, 이름·저장소·브랜치를 바꾸거나, Reclone 을 켜 두면 Periphery 가 디렉터리를 통째로 다시 만든다. 그 뒤 Deploy 는 File Paths 의 파일이 없어 실패한다. 위 `cp` 를 다시 하고 Deploy 한다.
- 바깥 프록시가 갖출 것과 확인 절차는 본문 「기존 리버스 프록시 뒤에 두기」 5·6.

## 호스트에서 운영 명령 부르기

백업·로그·`exec` 는 파일 없이 프로젝트 이름만으로 돈다(Compose 가 컨테이너 라벨로 찾는다 — 어느 디렉터리에서든). 본문의 `docker compose -f infra/compose.yml <명령>` 을 아래 꼴로 읽는다.

```bash
docker compose -p dodok ps
docker compose -p dodok logs app
docker compose -p dodok exec app node dist/backup.js
```

cron(매일 04:00, 14개 보관 — `cd` 가 필요 없다):

```cron
0 4 * * * docker compose -p dodok exec -T app node dist/backup.js --keep 14 >> "$HOME/dodok-backup.log" 2>&1
```

- `up`·`run`·`build`·`config` 는 파일이 필요하다. 본문의 「복원」·「되돌리기」·「볼륨째 옮기기」처럼 `run --rm` 을 쓰는 절차는 clone 디렉터리에서 Komodo 와 같은 꼴로 부른다:
  ```bash
  kc() { docker compose -p dodok -f infra/compose.yml -f infra/compose.server.yml --env-file .env "$@"; }   # 프록시 없는 서버는 둘째 -f 를 뺀다
  ```
  `.env` 는 Komodo 가 마지막 배포 때 쓴 파일이다. ⚠ `kc config` 는 그 값을 찍는다(본문 「시크릿 규칙」).
- 「되돌리기」의 `git checkout <커밋>` 은 Komodo 의 clone 을 옮긴다 — 다음 Deploy 의 갱신이 Branch 로 되돌린다(Periphery 의 갱신은 `git checkout -f`·`git pull`). 되돌린 채 두려면 Komodo 의 Stack 설정에서 Commit 을 그 커밋으로 고정하고 Deploy 한다.

확인 못 한 것: Komodo 화면의 버튼 이름·위치는 판마다 다를 수 있어 필드 이름(`file_paths`·`run_directory`·`env_file_path`·`webhook_enabled`·`run_build`·`auto_pull`·`destroy_before_deploy`·`reclone`·`commit`)으로 적었다. 실제 Komodo 서버에 이 Stack 을 만들어 배포해 본 사람이 결과를 본문 「사람이 한 번 따라 한 결과」 표에 적는다.

# 러너 백그라운드 실행 — `dodok-runner service` 설계

날짜: 2026-11-27 · 상태: 사용자 결정(방식 A) · 손으로 하는 절차: `docs/guides/docker-deploy.md` 「러너 설치」 「백그라운드로 띄우기」

## 왜

사용자 요청: 러너를 백그라운드로 띄우는 옵션. 지금은 사람이 plist·systemd unit 을 손으로 써야 하고, 그때 걸리는 함정(서비스는 셸 `PATH` 를 안 읽음, 원격 업데이트가 서비스 밖에 러너를 다시 띄움, 종료 코드 2 를 다시 띄우면 주소가 막힘, `nohup` 은 SIGHUP 처리 때문에 안 됨)을 사람이 알아야 한다.

## 접근

1. **(고른 것, 사용자 결정) A. `dodok-runner service …` 가 OS 서비스 관리자(macOS launchd 사용자 LaunchAgent · Linux systemd 사용자 서비스)에 러너를 등록·조작한다.** 자동 시작·비정상 종료 재시작·로그를 OS 가 맡는다.
2. B. 러너가 스스로 데몬이 되는 `--detach`·pid 파일 — 재부팅 뒤 자동 시작·재시작·로그 관리를 다시 만들어야 하고 덜 튼튼해서 버렸다.

## 정한 것

- **명령** — `dodok-runner service <install|uninstall|start|stop|restart|status|logs> [--config <경로>]`. `logs` 는 `-f`(따라가기)를 받는다. 지원하지 않는 OS(Windows 등)면 한 줄로 알리고 1 로 끝난다.
- **install**
  - 설정이 유효해야 한다 — `--check-config` 와 같은 검사를 먼저 하고, 실패하면 사유와 함께 끝난다(서비스로 뜬 러너는 터미널이 없어 설정을 묻지 못한다). 설정 파일이 없으면 「먼저 `dodok-runner` 를 터미널에서 띄워 설정을 만드세요」.
  - 실행 줄은 **지금 프로세스의 절대 경로**로 짓는다: `process.execPath`(node) + 진입 파일의 실제 경로(`realpath(process.argv[1])`) + (기본 자리가 아니면) `--config <절대 경로>`. 그래서 서비스는 `node` 를 `PATH` 에서 찾지 않는다.
  - env 는 **지금 셸의 `PATH`** 와 `DODOK_RUNNER_SERVICE=<launchd|systemd>` 를 싣는다(`PATH` 는 설치본 `claude`·npm 을 찾는 데 쓴다). 그 밖의 env 는 싣지 않는다(토큰은 `tokenFile` — `DODOK_RUNNER_TOKEN` 으로만 토큰을 주는 설정이면 install 이 거절하고 `tokenFile` 을 쓰라고 알린다).
  - 이미 등록돼 있으면 파일을 새로 쓰고 다시 띄운다(판·경로가 바뀐 뒤 다시 부르는 길). 지금 터미널에서 같은 설정의 러너가 돌고 있을 수 있다 — 같은 토큰이면 서비스 쪽이 이기고 터미널 쪽은 코드 2 로 끝난다고 한 줄 알린다.
  - macOS: `~/Library/LaunchAgents/chat.dodok.runner.plist`, 라벨 `chat.dodok.runner`, `RunAtLoad`, `KeepAlive {Crashed: true}`, `ExitTimeOut 30`, 로그는 설정 디렉터리 옆 `logs/runner.log`(디렉터리를 만든다). `launchctl bootstrap gui/<uid>`(이미 있으면 `bootout` 뒤).
  - Linux: `~/.config/systemd/user/dodok-runner.service` — `Restart=on-failure`·`RestartPreventExitStatus=2`·`RestartSec=10`·`TimeoutStopSec=30`·`StartLimitIntervalSec=300`·`StartLimitBurst=5`·`After=network-online.target`·`WantedBy=default.target`. `daemon-reload` → `enable --now`. `loginctl enable-linger` 는 시도하고 실패하면 무엇을 할지 한 줄 알린다(없으면 로그인한 동안만 돈다).
  - 값의 원본은 `docs/guides/docker-deploy.md` 「백그라운드로 띄우기」의 plist·unit 이다 — 그 절과 같게 짓는다.
- **원격 업데이트가 서비스에서도 된다** — `DODOK_RUNNER_SERVICE` 가 있으면 `selfUpdate` 의 마지막 단계(분리된 자식 띄우기 → exit 0)를 **서비스 관리자에게 다시 시작을 맡기는 것**으로 바꾼다: macOS `launchctl kickstart -k gui/<uid>/chat.dodok.runner`, Linux `systemctl --user --no-block restart dodok-runner`(둘 다 분리해 띄워, 자기를 죽이는 명령을 기다리지 않는다). 설치·`--check-config`·되돌리기는 지금 그대로. 그러면 서비스로 띄울 때 `remoteUpdate: false` 가 필요 없다.
- **uninstall** — 멈추고(launchd `bootout` / systemd `disable --now`) 파일을 지운다. 설정·토큰·로그는 남긴다.
- **start·stop·restart** — 등록돼 있지 않으면 「먼저 `dodok-runner service install`」. stop 은 SIGTERM(정상 종료 — 도는 런을 멈추고 최대 약 11초).
- **status** — 등록 여부·실행 중 여부·pid·마지막 종료 코드(알 수 있으면)·로그 자리. 코드 2 로 끝나 있으면 「토큰이나 판본 문제 — 로그 마지막 줄을 보세요」.
- **logs** — macOS 는 로그 파일 끝 200줄(`-f` 면 따라감), Linux 는 `journalctl --user -u dodok-runner`(`-f`).
- **문서** — `docs/guides/docker-deploy.md` 「백그라운드로 띄우기」를 `dodok-runner service install` 먼저로 고치고 손으로 쓰는 plist·unit 은 「직접 쓰려면」으로 남긴다. 그 절과 「업데이트」의 「서비스로 띄웠으면 `remoteUpdate: false`」 문장을 새 동작으로. 러너 `README.md` 의 같은 절. 서버 `/llms.txt` 「러너 머신」 절(`apps/server/src/modules/setup/llms.ts`)에 한 줄 — AI 가 설치한 뒤 사람이 원하면 `dodok-runner service install`.
- **판본** — 이 작업은 판본을 올리지 않는다. 릴리스(`docs/guides/runner-release.md`)는 사람이 정한다.

## 비목표

- Windows 서비스(작업 스케줄러 등). 시스템 전체 서비스(root·`/Library/LaunchDaemons`·`/etc/systemd/system`). 로그 회전.
- 서버·웹 변경 없음(웹의 「업데이트」 버튼·문구 그대로).

## 빌더에게 남긴 것

- 모듈 자리(`packages/claude-runner/src/service.ts` 등)와 `main.ts` 의 `planCli` 확장.
- OS 명령은 주입할 수 있게 감싸 시험에서 실제 `launchctl`·`systemctl` 을 부르지 않는다. 생성 파일 내용·명령 순서·종료 코드 판정은 단위 시험으로.
- 실제 등록 확인(이 Mac 의 launchd)은 실제 서버에 붙지 않게 워크트리의 `dev:fake` 서버와 그 러너 토큰으로 하고, 끝나면 반드시 `uninstall` 로 지운다. 이미 사람이 등록한 `chat.dodok.runner` 가 있으면 건드리지 않고 멈춰 묻는다.

# 러너 npm 배포 — `@dodok/runner`

러너 CLI `dodok-runner`(`packages/claude-runner`)를 npm 패키지 `@dodok/runner` 로 올리는 절차다. 올리는 일은 GitHub Actions(`.github/workflows/runner-publish.yml`)가 하고, 사람은 판본을 올려 태그를 민다.

연결 페이지(「러너」 블록 「설치」 1단계)와 `/llms.txt` 「러너 머신」 절은 이 npm 판을 기본으로 안내한다(`npm i -g @dodok/runner`). 서버 이미지가 품고 연결 페이지의 접힌 「서버와 같은 빌드로 설치」가 내려 주는 tgz(`docs/guides/docker-deploy.md` 「러너 설치」 2 「서버와 같은 빌드가 필요할 때」)는 이 배포와 따로 돈다 — 그 tgz 는 서버와 **같은 커밋**의 빌드이고, npm 판은 태그를 민 커밋의 빌드다. 연결 페이지의 「서버와 같은 빌드입니다」는 번들 sha256 으로 견주므로, npm 판으로 붙은 러너는 서버와 커밋이 다르면 「서버와 다른 빌드입니다 — npm 판이면 정상입니다. …」(경고가 아닌 안내)로 보인다.

## npm 쪽 사전 준비 (사람 몫, 한 번)

1. **npm 조직 `dodok`** — npmjs.com 에서 조직 `dodok` 을 만든다(무료 조직, 공개 패키지). 스코프 `@dodok` 은 이 조직이 쥔다 — 없으면 첫 publish 가 `404 Not Found - PUT https://registry.npmjs.org/@dodok%2frunner` 나 `E403` 로 실패한다.
2. **인증 — 둘 중 하나.**
   - **trusted publisher(권함)** — 패키지가 한 번 올라간 뒤 npmjs.com 의 `@dodok/runner` → Settings → Trusted Publisher 에 GitHub Actions 로 저장소 `jang2162/dodok.chat`, 워크플로 파일 `runner-publish.yml` 을 등록한다(environment 는 비운다 — 워크플로가 쓰지 않는다). 그러면 워크플로의 OIDC 토큰(`id-token: write`)으로 올라가고 시크릿이 필요 없다. 등록한 뒤에는 `NPM_TOKEN` 시크릿을 지워도 된다. 패키지가 아직 없으면 등록할 자리가 없으니 첫 판은 아래 토큰으로 올린다.
   - **`NPM_TOKEN` 시크릿** — npmjs.com 에서 `@dodok` 스코프에 쓰기 권한이 있는 granular access token 을 만들고(2FA 를 우회하는 「Bypass 2FA」를 켜야 CI 에서 OTP 없이 올라간다), GitHub 저장소 Settings → Secrets and variables → Actions 에 `NPM_TOKEN` 으로 넣는다. 워크플로가 `NODE_AUTH_TOKEN` 으로 넘긴다.
3. 저장소가 **공개**여야 provenance 가 붙는다. provenance 는 워크플로의 `pnpm publish --provenance` 플래그가 건다 — pnpm 11 은 `package.json` 의 `publishConfig.provenance` 를 읽지 않는다(그 칸은 `npm publish` 로 올릴 때를 위한 것). 비공개 저장소면 publish 가 provenance 에서 실패한다 — 그때는 워크플로의 `--provenance` 와 `publishConfig.provenance` 를 함께 빼는 결정을 먼저 한다.

## 배포 절차

1. **판본 올리기** — `packages/claude-runner/package.json` 의 `version` 을 올린다(semver — 설정 파일의 키가 바뀌거나 서버와의 프로토콜이 바뀌면 minor 이상). 번들의 `dodok-runner --version` 과 hello 의 `runnerVersion` 이 이 값이다. 커밋해 `main` 에 병합한다.
   ```bash
   git commit -m "build(runner): release 0.2.0" packages/claude-runner/package.json
   ```
2. **로컬에서 꾸러미 보기(선택)** — `pnpm -F @dodok/runner pack:runner` 로 `packages/claude-runner/dist/dodok-runner-<판본>.tgz` 를 만들고 `tar -tzf` 로 `package/dist/main.js`·`package/README.md`·`package/LICENSE`·`package/package.json` 넷인지 본다. `pnpm -F @dodok/runner publish --dry-run --no-git-checks` 는 올리지 않고 같은 확인(`prepublishOnly`)을 돈다.
3. **태그 밀기** — 판본과 같은 `runner-v<판본>` 태그를 그 커밋에 달아 `origin`(GitHub) 에 민다.
   ```bash
   git tag runner-v0.2.0
   git push origin runner-v0.2.0
   ```
4. **CI** — `runner-publish` 워크플로가 돈다: 태그 커밋이 `origin/main` 에 있는지(아니면 실패) → Node·pnpm 판이 `mise.toml` 과 같은지 → 태그가 `runner-v<package.json version>` 과 같은지(다르면 실패) → `pnpm install --frozen-lockfile`(러너와 그 의존 패키지만) → 러너 typecheck·test·build → `pnpm -F @dodok/runner publish`(`prepublishOnly` 가 다시 빌드하고 `scripts/check-pack.mjs` 로 꾸러미를 확인한다).
5. **확인** — `npm view @dodok/runner version` 이 새 판본이고, npmjs.com 패키지 화면에 provenance 표시가 붙는다. 다른 머신에서 `npm i -g @dodok/runner && dodok-runner --version`.

올라간 판본은 지울 수 없다(72시간 안 unpublish 는 되지만 같은 판본 번호는 다시 못 쓴다). 잘못 올렸으면 판본을 올려 다시 배포하고, 필요하면 `npm deprecate @dodok/runner@<판본> "<사유>"`.

## 꾸러미에 들어가는 것

- `package.json` 의 `files` — `dist/main.js`(esbuild 단일 번들, `@dodok/shared` 를 품는다)·`README.md`·`LICENSE`(MIT). 테스트·소스·스크립트는 들어가지 않는다.
- `dependencies` 는 정확 핀 셋(`@anthropic-ai/claude-agent-sdk`·`socket.io-client`·`zod`) — 설치할 때 npm 이 받는다. SDK 는 번들에 넣지 않는다(ADR 0007 2절 라이선스).
- `devDependencies` 의 `workspace:*`(`@dodok/shared`·`@dodok/runner-adapter`)는 pnpm 이 publish·pack 때 실제 판본(`0.0.0`)으로 바꿔 쓴다. 두 패키지는 npm 에 없지만 devDependencies 라 `npm i -g` 가 받지 않는다.
- pnpm 은 올리는 `package.json` 에서 `scripts` 의 수명주기 스크립트를 빼고 쓴다(manifest obfuscation) — 설치하는 쪽에서 `prepublishOnly` 등이 돌지 않는다.

## 실패할 때 볼 것

| 증상 | 원인·할 일 |
| --- | --- |
| `tag commit is not on main` | 태그를 `main` 에 병합되지 않은 커밋에 달았다. 병합한 커밋에 다시 단다 |
| `tag runner-vX != runner-vY` | 태그와 `package.json` 의 `version` 이 다르다. 태그를 지우고(`git push origin :refs/tags/runner-vX`, `git tag -d runner-vX`) 판본을 맞춘 커밋에 다시 단다 |
| `node … != mise.toml …`·`pnpm … != mise.toml …` | `mise.toml` 핀을 바꾸고 워크플로의 `node-version`(또는 `package.json` 의 `packageManager`)을 함께 안 바꿨다. 둘을 맞춘다 |
| `ERR_PNPM_OUTDATED_LOCKFILE` | 태그 커밋의 `pnpm-lock.yaml` 이 `package.json` 과 다르다. 로컬에서 `pnpm install` 한 lockfile 을 커밋한다 |
| `publish 전 확인 실패 — …` | `scripts/check-pack.mjs` 가 걸렀다 — 빠진 파일, shebang 없는 번들, 판본이 다른 번들, `dependencies` 의 `workspace:` |
| `E404`·`E403`(PUT `@dodok%2frunner`) | 조직 `dodok` 이 없거나, 토큰이 그 스코프에 쓰기 권한이 없거나, trusted publisher 의 저장소·워크플로 파일 이름이 다르다 |
| `ENEEDAUTH`·`E401` | `NPM_TOKEN` 시크릿이 없고 trusted publisher 도 등록되지 않았다(첫 판) — 위 「npm 쪽 사전 준비」 2 |
| `EOTP` | 토큰이 2FA 를 우회하지 않는다 — 「Bypass 2FA」를 켠 granular token 으로 바꾸거나 trusted publisher 로 옮긴다 |
| provenance 오류(`Unsupported GitHub Actions source repository visibility` 등) | 저장소가 비공개거나 `id-token: write` 가 빠졌다 |
| `E409`·`cannot publish over the previously published versions` | 그 판본이 이미 올라가 있다. 판본을 올려 새 태그로 다시 |

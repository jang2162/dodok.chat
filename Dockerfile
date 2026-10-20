# dodok 앱 이미지 — 서버 번들과 빌드된 웹을 컨테이너 하나에(앱 컨테이너 하나 스펙 3.1). 빌드 컨텍스트는 저장소 루트(compose.yaml)
#   source  pnpm 스토어(lockfile 만으로)와 소스 — 아래 단계들이 이 층을 나눠 쓴다
#   build   서버 설치·번들(dist/main.js·dist/backup.js + 소스맵)
#   deploy  lockfile 의 운영 의존성 배치에서 번들이 런타임에 찾는 것의 닫힘만 남긴 node_modules(/runtime/node_modules)
#   plugin  설정 마법사가 내려 주는 플러그인 tgz(pack:plugin)
#   runner  연결 페이지가 내려 주는 Claude 러너 tgz(pack:runner)
#   web     웹 빌드(apps/web/dist) + 미리 압축한 .br·.gz — 서버가 DODOK_WEB_DIR 로 낸다(apps/server/src/http/web-static.ts)
#   runtime 운영 이미지 — 번들 + 그 배치 + 마이그레이션 + 플러그인·러너 tgz + 웹, 비루트
FROM node:24.21.0-bookworm AS source
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@11.16.0 --activate
# lockfile 만으로 스토어를 채워 두는 층 — 소스만 바뀐 재빌드는 여기까지 캐시로 넘어간다. BuildKit 캐시 마운트(--mount=type=cache)를
# 쓰지 않는 까닭: buildx 가 없는 Docker 에서 compose 가 클래식 빌더로 빌드해 그 문법이 오류다
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch
COPY . .

FROM source AS build
# --frozen-lockfile 이 먼저여야 한다 — 매니페스트가 lockfile 과 어긋나면 아래 deploy --legacy 는 멈추지 않고 조용히 다시 해석한다.
# 여기서 어긋남이 빌드 실패로 드러난다
RUN pnpm install --offline --frozen-lockfile --filter "@dodok/server..."
RUN pnpm -F @dodok/server build

# deploy 를 build 와 다른 단계에서 하는 까닭: deploy 는 그 워크스페이스의 node_modules/.pnpm-workspace-state-v1.json 을
# 운영(dev:false)으로 덮어쓴다 — build 를 잇는 다른 단계가 의존성 확인에서 재설치를 시도하지 않게
FROM build AS deploy
# pnpm 11 은 inject-workspace-packages 가 없는 워크스페이스에서 --legacy 없이는 deploy 를 거부한다(ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE).
# apps/server/scripts/bundle-smoke.mjs 의 deployArgs 와 같은 명령이다 — 바꾸면 함께. 거기는 --offline 을 더하지만 여기서는 못 쓴다:
# legacy deploy 는 패키지 메타데이터 캐시를 찾는데 pnpm fetch 는 그 캐시를 채우지 않는다(ERR_PNPM_NO_OFFLINE_META). 버전은 lockfile 을 따른다
RUN pnpm --filter @dodok/server deploy --prod --legacy /deploy
# 목록은 build.mjs 의 runtimeDeps(dist/runtime-deps.json) — 까닭·크기는 스크립트 머리. bundle-smoke 가 같은 명령으로 배치를 만든다
RUN node apps/server/scripts/prune-runtime-deps.mjs /deploy /runtime/node_modules apps/server/dist/runtime-deps.json

# 설정 마법사 스펙 2.5 — 서버가 GET /api/v1/setup/plugin.tgz 로 내려 줄 파일. 플러그인의 devDependency(openclaw 등)는 pnpm fetch 가
# 이미 스토어에 받아 두었고 이 단계에서만 링크된다(openclaw 약 220 MB) — runtime 에는 tgz 하나만 간다.
# pack:plugin 의 build.mjs 가 번들 해시 가드(import.meta.url·hello 필드)를 돌려 어긋나면 여기서 빌드가 멈춘다
FROM build AS plugin
RUN pnpm install --offline --frozen-lockfile --filter "@dodok/openclaw-plugin..."
RUN pnpm -F @dodok/openclaw-plugin run pack:plugin

# 러너 스펙 5장 「같은 빌드」 — 서버가 GET /api/v1/setup/runner.tgz 로 내려 줄 파일. 러너 번들은 Claude Agent SDK 를 품지 않는다
# (esbuild external — 사람 머신에서 설치할 때 npm 이 받는다). SDK 는 pnpm fetch 가 스토어에 받아 두었고 이 단계에서만 링크된다
FROM build AS runner
RUN pnpm install --offline --frozen-lockfile --filter "@dodok/claude-runner..."
RUN pnpm -F @dodok/claude-runner run pack:runner

# build 가 아니라 source 에서 가르는 까닭: 서버 설치가 packages/shared 아래에 node_modules 를 만들어 아래 해시 입력에 섞인다
FROM source AS web
# 웹 빌드 ID(__BUILD_ID__ — 오프라인 사본 buster)의 기본값 — 웹 빌드 입력의 내용 해시. COPY . . 때문에 서버만 바뀐 배포도 아래 빌드
# 층을 다시 돌리는데, ID 가 빌드 시각이면 그때마다 index 를 import 하는 청크들·sw.js 이름이 바뀌어 모든 클라이언트가 청크를 다시 받고
# 새 버전 토스트·오프라인 사본 폐기를 겪는다. 내용 해시면 웹 입력이 같은 배포의 ID 가 같고, 같은 ID·같은 웹 입력이면 산출물이 바이트
# 단위로 같다. 셸에서 git 으로 계산해 넘길 단계가 없는 배포(Komodo 등)와 얕은 클론에서도 맞는다.
#   입력 — 웹 빌드가 읽는 경로 전부와 이 Dockerfile(웹 빌드 명령이 여기 있다 — 서버 단계만 고쳐도 ID 가 바뀌는 값은 치른다). 경로를
#   더하거나 빼면 여기만 고친다. 빠진 경로가 있으면 빌드를 멈춘다(조용히 좁아지지 않게).
#   웹 빌드가 루트까지 거슬러 찾는 설정(Vite 의 PostCSS 설정 postcss.config.*·.postcssrc* 등)을 저장소 루트에 새로 두면 그 파일도 여기
#   더한다 — 빠지면 그 파일만 바뀐 배포에서 ID 가 그대로다.
#   해시 — 경로로 정렬한(LC_ALL=C) 파일마다 「sha256  경로」 줄을 다시 sha256 한 앞 12자. 이름·내용만 들어가고 mtime·권한·시각은
#   안 들어간다. 빌드 컨텍스트의 파일이라 .dockerignore 가 뺀 것(node_modules·dist·.env 등)은 안 들어가지만, git 이 무시하는 다른
#   파일(손으로 둔 메모 등)이 저 경로 안에 있으면 들어간다 — 깨끗한 클론에서는 git 이 추적하는 파일과 같다.
# install 앞에 두는 까닭: install 이 만드는 파일이 해시에 섞이지 않게
RUN set -- apps/web packages/shared pnpm-lock.yaml tsconfig.base.json package.json pnpm-workspace.yaml Dockerfile \
 && for p; do [ -e "$p" ] || { echo "웹 빌드 ID 입력이 없다: $p" >&2; exit 1; }; done \
 && find "$@" -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-12 > /web-build-id \
 && echo "웹 빌드 ID(내용 해시): $(cat /web-build-id)"
RUN pnpm install --offline --frozen-lockfile --filter "@dodok/web..."
# 넘긴 값이 내용 해시를 이긴다(compose.yaml 의 DODOK_WEB_BUILD_ID — 선택). 빈 값은 내용 해시로 바꾼다. Docker 밖 빌드는 이 Dockerfile 을
# 지나지 않아 vite.config.ts 가 빌드 시각을 쓴다. ARG 를 install 뒤에 두는 까닭: 값이 바뀌어도 install 층 캐시는 산다
ARG VITE_BUILD_ID=
# 웹은 같은 오리진의 /api·/socket.io 를 쓴다 — 빌드가 API 오리진을 알 필요가 없다
RUN if [ -z "$VITE_BUILD_ID" ]; then VITE_BUILD_ID="$(cat /web-build-id)"; fi && export VITE_BUILD_ID && pnpm -F @dodok/web build \
 && echo "웹 빌드 ID(쓴 값): $VITE_BUILD_ID"
# 서버는 요청마다 압축하지 않는다 — 텍스트 파일 옆에 .br·.gz 를 미리 둔다(서비스 워커 precache 목록은 위 빌드가 이미 썼다)
RUN node apps/server/scripts/precompress-web.mjs apps/web/dist

FROM node:24.21.0-bookworm-slim AS runtime
# 소스맵을 싣고 켠다 — 운영 로그의 스택이 원본 TS 줄을 가리키게
ENV NODE_ENV=production DATA_DIR=/data HOST=0.0.0.0 PORT=3000 DODOK_MIGRATIONS_DIR=/app/drizzle \
    DODOK_PLUGIN_DIR=/app/plugin DODOK_RUNNER_DIR=/app/runner DODOK_WEB_DIR=/app/web NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=deploy --chown=node:node /runtime/node_modules ./node_modules
# "type": "module" — dist/main.js 가 ESM 으로 읽히게
COPY --from=deploy --chown=node:node /deploy/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/server/dist ./dist
COPY --from=build --chown=node:node /repo/apps/server/drizzle ./drizzle
# tgz 가 없으면 COPY 가 실패한다(no source files were specified) — 파일 없는 이미지가 조용히 나가지 않는다
COPY --from=plugin --chown=node:node /repo/packages/openclaw-plugin/dist/*.tgz ./plugin/
COPY --from=runner --chown=node:node /repo/packages/claude-runner/dist/*.tgz ./runner/
COPY --from=web --chown=node:node /repo/apps/web/dist ./web
# 빈 볼륨은 마운트 때 이 디렉터리의 소유자(node, 1000:1000)를 물려받는다. 파일이 이미 든 root 소유 볼륨은 그대로라 부팅 때
# 설정 오류 한 줄(src/runtime.ts 의 unwritableDataPath)로 끝난다
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

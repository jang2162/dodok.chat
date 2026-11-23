# 첨부 저장소 S3 연동 Implementation Plan

> **For agentic workers:** 이 저장소에서는 Orca 워커가 태스크를 맡는다(`AGENTS.md` 「작업 방식」). 브리프가 이 계획의 태스크를 가리키고, 워커는 이 계획과 스펙을 함께 읽는다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ATTACHMENTS_STORAGE=s3` 이면 첨부 블롭을 S3 호환 저장소에 저장·내려받기·정리한다(기본 `local` 은 지금 그대로).

**Architecture:** `BlobStore` 인터페이스 하나에 로컬 디스크·S3 두 구현을 두고, 첨부 서비스·라우트·정리가 경로·fs 대신 이 인터페이스만 쓴다. 설정은 `config.ts` 가 Zod 로 읽고 부팅 때 S3 접근을 확인한다.

**Tech Stack:** Fastify, drizzle·SQLite, `@aws-sdk/client-s3`(정확 핀), Node streams.

**Spec:** `docs/superpowers/specs/2026-11-23-s3-attachments-design.md` — 결정 S1~S8.

## Global Constraints

- env 이름(S1·S2): `ATTACHMENTS_STORAGE`(`local`|`s3`, 기본 `local`), `S3_ENDPOINT`(선택), `S3_REGION`, `S3_BUCKET`, `S3_PREFIX`(선택, 기본 `""`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`(`true`|`false`, 기본 `false`).
- 키 `<S3_PREFIX><sha 앞 2자>/<sha>`(S4).
- 정리(S6): S3 고아 훅기는 24시간에 한 번, 행 없고 `LastModified` 가 1시간(`ORPHAN_MIN_AGE_MS = 3_600_000`) 넘은 객체만.
- 키·시크릿·버킷 내부 경로를 로그·오류 응답에 싣지 않는다(sha·attachment id 만).
- `@aws-sdk/client-s3` 정확 핀(서버 dependencies). 서버 번들 `pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke` 통과.
- 기존 볼륨 이관 없음.
- Docker 는 다른 프로젝트와 데몬을 같이 쓴다 — `docker … prune` 금지, 만든 컨테이너만 이름으로 지운다.
- 공통: Conventional Commits·패키지 스코프, 경로 명시 stage.

## Review Focus

1. **S3 설정이 틀리면(버킷 없음·키 틀림·엔드포인트 닿지 않음) 서버가 뜨지 않고, 사유에 시크릿이 없다.** (Task 1 시험)
2. **내려받는 중 S3 스트림이 끊기거나 요청이 끊기면 소켓·스트림이 새지 않는다.** (Task 2 시험)
3. **올리는 중인 객체(행 넣기 전)를 하루 훑기가 지우지 않는다**(1시간 이내). (Task 2 시험)
4. **같은 바이트를 동시에 두 번 올려도 객체 하나·행 둘, 정리와 겹쳐도 행이 있는 객체를 지우지 않는다**(sha 잠금 그대로). (Task 2 시험)
5. **`local` 모드는 지금과 한 글자도 다르게 동작하지 않는다** — 기존 첨부 시험 전부 그대로 통과. (Task 2)

---

### Task 1: 설정과 `BlobStore`

**Files:**
- Create: `apps/server/src/modules/attachments/blob-store.ts`(인터페이스·로컬 구현), `apps/server/src/modules/attachments/s3-store.ts`
- Modify: `apps/server/src/config.ts`, `apps/server/src/runtime.ts`(S3 모드면 첨부 디렉터리를 만들지 않음), `apps/server/package.json`, `pnpm-lock.yaml`, `.env.example`
- Test: Create `apps/server/test/blob-store.test.ts`; Modify `apps/server/test/config.test.ts`, `apps/server/test/runtime.test.ts`

**Interfaces — Produces:**
```ts
export interface BlobStore {
  readonly kind: "local" | "s3";
  /** 없을 때만 쓴다. 있으면 아무것도 안 한다 */
  put(sha: string, bytes: Uint8Array): Promise<void>;
  /** 없으면 undefined */
  open(sha: string): Promise<{ size: number; stream: NodeJS.ReadableStream; close(): void } | undefined>;
  remove(sha: string): Promise<void>;
  /** 정리용 — 로컬은 지금 디렉터리 훑기(임시 파일 포함), S3 는 목록(prefix). 각 항목의 sha·수정 시각 */
  list(): AsyncIterable<{ sha: string; modifiedAt: Date; temp?: boolean }>;
  /** 부팅 확인 — 로컬은 디렉터리 만들기, S3 는 HeadBucket */
  check(): Promise<void>;
}
export function createLocalBlobStore(dir: string): BlobStore;
export function createS3BlobStore(cfg: S3Config, client?: S3Client): BlobStore;
export function createBlobStore(config: Config): BlobStore;
```
- `Config` 에 `attachmentsStorage: "local" | "s3"`, `s3?: S3Config`(`{ endpoint?, region, bucket, prefix, accessKeyId, secretAccessKey, forcePathStyle }`). `s3` 모드에서 필수 값이 없으면 `loadConfig` 가 던진다(어느 env 가 빠졌는지만, 값은 싣지 않음).

- [ ] **Step 1: 실패하는 시험** — `config.test.ts`: 기본 local, s3 필수 누락 → 그 env 이름이 든 오류, `S3_FORCE_PATH_STYLE=true` 파싱, 오류 문구에 시크릿 값이 없음. `blob-store.test.ts`: 같은 시험 묶음을 로컬(임시 디렉터리)과 S3(`aws-sdk-client-mock` 대신 **메모리 흉내 `S3Client`** — `send` 를 명령 이름으로 갈라 Map 에 저장하는 작은 가짜; 새 dev 의존성을 들이지 않는다)에 돌린다: put 두 번 → 한 번만 씀(S3 는 `PutObject` 1회), open 없음 → undefined, open 크기·바이트, remove 뒤 open undefined, list 가 키 접두사·sha 를 돌려줌(S3 는 `S3_PREFIX` 반영, 다른 접두사 객체는 무시), `check` 실패 → 던짐(문구에 시크릿 없음). `runtime.test.ts`: s3 모드에서 첨부 디렉터리를 만들지 않음.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/server test -- config runtime blob-store`.
- [ ] **Step 3: 구현** — `pnpm -F @dodok/server add @aws-sdk/client-s3@<지금 최신 판> --save-exact`. S3 `open` 은 `GetObject` 의 `Body`(Node `Readable`)·`ContentLength`, `NoSuchKey`/404 → undefined. `put` 은 `HeadObject` 로 있으면 건너뜀, 없으면 `PutObject`(`ContentLength`, `ContentType: application/octet-stream`). `list` 는 `ListObjectsV2` 페이지 넘기기.
- [ ] **Step 4: 통과 확인** — 서버 시험 혼자, typecheck. 실행 수.
- [ ] **Step 5: 커밋** — `feat(server): blob store with local and S3 backends`

### Task 2: 첨부가 `BlobStore` 를 쓰게

**Files:**
- Modify: `apps/server/src/modules/attachments/service.ts`(`AttachmentDeps.dir` → `store: BlobStore`, `writeBlob`·`removeBlob`·`blobPath` 대신 store, `findReadable` 이 `path` 대신 sha 를 돌려줌, `sweepAttachments`), `apps/server/src/modules/attachments/routes.ts`(`sendBlob`), `apps/server/src/modules/attachments/store.ts`(로컬 구현으로 옮겨 가는 것 — 남는 것은 `sha256Of`·잠금), `apps/server/src/app.ts`(store 만들기·부팅 `check`·정리 주기), `apps/server/src/main.ts`
- Test: `apps/server/test/attachments.service.test.ts`, `apps/server/test/attachments.routes.test.ts`, `apps/server/test/integration/attachments.test.ts`, `apps/server/test/helpers/app.ts`, `apps/server/test/main.test.ts`, `apps/server/test/runners.attachments.test.ts`, `apps/server/test/attachments.bridge-scope.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `sweepAttachments(deps, opts: { unboundTtlMs?: number; fullScan?: boolean })` — 지운 미묶음 행의 sha 는 잠금 안에서 행 0 이면 `store.remove`. `fullScan` 이면 `store.list()` 를 훑어 행 없는 것을 지우되 S3 는 `modifiedAt` 이 `ORPHAN_MIN_AGE_MS` 보다 오래된 것만(로컬은 지금 규칙 — 블롭은 바로, 임시 파일은 `STALE_TMP_MS`). 로컬 모드는 지금처럼 매 정리마다 `fullScan: true`, S3 모드는 24시간에 한 번만 `fullScan: true`(마지막 훑은 시각은 메모리).
- `sendBlob`: `store.open(sha)` → 없으면 404, 크기 다르면 500(지금 문구·cause 그대로), 스트림을 보낸다. 요청이 끊기면 `close()`.

- [ ] **Step 1: 실패하는 시험** — 서비스·라우트 시험을 로컬·메모리 S3 두 store 로 돌리는 매개변수화(기존 시험 본문은 그대로, store 만 바꿈). 새 시험: `s3 sweep keeps objects younger than 1h without rows`, `s3 sweep removes old orphan objects only on full scan`, `concurrent same-bytes upload → one PutObject, two rows`, `download stream error mid-way closes response`, `client abort closes S3 body`. `main.test.ts`: s3 모드 `check` 실패면 부팅 실패.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — 서버 시험 혼자 전체(기존 첨부 시험 전부 local 로 그대로 통과 — Review Focus 5), typecheck·lint·fmt, `pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke`. 실행 수.
- [ ] **Step 5: 커밋** — `feat(server): store attachments through the blob store`

### Task 3: 실제 S3 호환 저장소 확인·문서

**Files:**
- Modify: `docs/guides/docker-deploy.md`(환경 변수 표에 S3 줄들, 「S3 저장소」 절 — 버킷 만들기·최소 권한(`s3:GetObject` `PutObject` `DeleteObject` `ListBucket` 과 HeadBucket)·버전 관리를 켜면 첨부가 보존됨·백업 절에 「S3 모드면 첨부는 버킷 쪽」), `docs/guides/plan.md` 8장 완료 줄, `.env.example`(Task 1 에서 했으면 그대로)

- [ ] **Step 1: MinIO 로 한 바퀴** — `docker run -d --name dodok-s3-check-<무작위> -p <빈 포트>:9000 minio/minio:<판 고정> server /data` → 버킷 만들기(`mc` 컨테이너 또는 SDK 스크립트) → 서버를 `ATTACHMENTS_STORAGE=s3 S3_ENDPOINT=http://127.0.0.1:<포트> S3_FORCE_PATH_STYLE=true …` 로 dev:fake 띄워 웹에서 사진 하나 올리고 보이기·내려받기, 같은 사진 다시 올려 객체 하나, 잘못된 키로 띄우면 부팅 실패 문구(시크릿 없음). 끝나면 그 컨테이너만 `docker rm -f dodok-s3-check-…`. Docker 를 쓸 수 없으면 그렇다고 보고.
- [ ] **Step 2: 문서.** `---` 앞 빈 줄·표 줄을 눈으로.
- [ ] **Step 3: 커밋** — `docs: S3 attachment storage`

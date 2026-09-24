import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type AppDeps, createApp } from "../../src/app";
import { loadConfig } from "../../src/config";
import { memberships, users } from "../../src/db/schema.sqlite";
import type { PushSend } from "../../src/modules/push/service";
import { v7 as uuid } from "uuid";
import { testEnv } from "./env";

/**
 * 테스트 앱의 기본 발송기 — 밖(FCM 등)으로 아무것도 보내지 않고 201 을 낸다. 구독을 만든 테스트에서 멘션이 나도
 * 실제 web-push 가 돌지 않게 bootTestApp·bootLiveApp 이 deps.pushSend 가 없을 때 넣는다
 */
export const noExternalPush: PushSend = async () => ({ statusCode: 201 });

/**
 * 테스트 앱의 기본 디스크 측정 — 여유 넉넉(ok). testEnv 의 DATA_DIR 은 없는 경로라 실제 statfs 면 앱마다 「disk check failed」
 * warn 이 찍힌다. 디스크를 재는 테스트만 deps.statfs 를 준다
 */
export const plentyOfDisk: NonNullable<AppDeps["statfs"]> = async () => ({
  bavail: 1n << 20n,
  bsize: 4096n,
  blocks: 1n << 21n,
});

/** owner 비밀번호(= LOCAL_AUTH_TOKEN) 테스트 값 */
export const TEST_LOCAL_TOKEN = testEnv.LOCAL_AUTH_TOKEN as string;

const attachmentsDirs = new WeakMap<App, string>();

/** bootTestApp 으로 띄운 앱의 첨부 디렉터리 — 블롭 파일을 디스크에서 직접 볼 때(blobPath(dir, sha)) 쓴다 */
export function attachmentsDirOf(app: App): string | undefined {
  return attachmentsDirs.get(app);
}

/**
 * testEnv + overrides 로 설정을 읽어 앱을 띄운다. 닫는 건 호출자 몫.
 * 어댑터를 주지 않으면 FakeAdapter — 실제 어댑터(Gateway 접속·디바이스 아이덴티티 파일)는 createApp 을 직접 부를 때만 생긴다.
 *
 * 첨부 디렉터리: overrides.ATTACHMENTS_DIR 을 안 주면 앱마다 새 임시 디렉터리를 만들어 쓰고 app.close() 뒤(부팅이 실패하면
 * 바로) 지운다 — 같은 파일 안 여러 앱이 서로의 블롭을 정리로 지우지 않는다(testEnv 주석). 그 경로는 attachmentsDirOf(app).
 * 부팅 사이에 블롭을 남겨야 하는 테스트(재부팅)만 ATTACHMENTS_DIR 을 직접 주고 스스로 지운다 — 그때 두 앱을 동시에 띄우지 않는다
 */
export async function bootTestApp(
  overrides: Partial<Record<string, string>> = {},
  deps: AppDeps = {},
): Promise<App> {
  const own = overrides.ATTACHMENTS_DIR === undefined;
  const dir = overrides.ATTACHMENTS_DIR ?? mkdtempSync(join(tmpdir(), "dodok-test-attachments-"));
  const remove = () => (own ? rmSync(dir, { recursive: true, force: true }) : undefined);
  let app: App;
  try {
    app = await createApp(loadConfig({ ...testEnv, ...overrides, ATTACHMENTS_DIR: dir }), {
      ...deps,
      adapter: deps.adapter ?? new FakeAdapter(),
      pushSend: deps.pushSend ?? noExternalPush,
      statfs: deps.statfs ?? plentyOfDisk,
    });
  } catch (err) {
    remove();
    throw err;
  }
  attachmentsDirs.set(app, dir);
  const close = app.close.bind(app);
  let closing: Promise<void> | undefined;
  app.close = () => (closing ??= close().finally(remove));
  return app;
}

/** 로컬 토큰으로 로그인한다. `/auth/local` 은 5회/분 레이트리밋이라 한 앱에서 여러 번 부르지 않는다. */
export async function login(app: App): Promise<{ token: string; headers: { authorization: string } }> {
  const res = await app.fastify.inject({
    method: "POST",
    url: "/api/v1/auth/local",
    payload: { token: TEST_LOCAL_TOKEN },
  });
  if (res.statusCode !== 200) throw new Error(`login 실패: ${res.statusCode} ${res.body}`);
  const { sessionToken } = res.json() as { sessionToken: string };
  return { token: sessionToken, headers: { authorization: `Bearer ${sessionToken}` } };
}

/** membership role 을 준 두 번째 사용자를 만들고 세션 토큰을 바로 낸다(owner 전용 표면의 member 거절을 볼 때) */
export async function userWithRole(
  app: App,
  handle: string,
  role: string,
): Promise<{ id: string; token: string }> {
  const ctx = await app.auth.$context;
  const id = uuid();
  await ctx.internalAdapter.createUser(
    { id, email: `${handle}@dodok.local`, name: handle, emailVerified: true },
    { method: "email-password" },
  );
  app.db
    .insert(users)
    .values({
      id,
      workspaceId: app.workspaceId,
      handle,
      displayName: handle,
      authProvider: "local",
      createdAt: new Date(),
    })
    .run();
  app.db.insert(memberships).values({ id: uuid(), workspaceId: app.workspaceId, userId: id, role }).run();
  return { id, token: (await ctx.internalAdapter.createSession(id)).token };
}

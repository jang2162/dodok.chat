import { type App, type AppDeps, createApp } from "../../src/app";
import { loadConfig } from "../../src/config";
import { testEnv } from "./env";

/** owner 비밀번호(= LOCAL_AUTH_TOKEN) 테스트 값 */
export const TEST_LOCAL_TOKEN = testEnv.LOCAL_AUTH_TOKEN as string;

/** testEnv + overrides 로 설정을 읽어 앱을 띄운다. 닫는 건 호출자 몫. */
export async function bootTestApp(
  overrides: Partial<Record<string, string>> = {},
  deps: AppDeps = {},
): Promise<App> {
  return createApp(loadConfig({ ...testEnv, ...overrides }), deps);
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

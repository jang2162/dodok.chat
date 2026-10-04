import { FAKE_GATEWAY_ID } from "@dodok/openclaw-adapter/fake";
import type { DbOrTx } from "../../src/db/client";
import { gateways } from "../../src/db/schema.sqlite";

export { FAKE_GATEWAY_ID };

export type TestGateway = { id: string; name: string; url: string; token: string; enabled: boolean };

/**
 * Gateway 행 하나를 DB 에 직접 넣는다(어댑터에는 알리지 않는다). 기본은 FakeAdapter 의 기본 연결(FAKE_GATEWAY_ID) — FakeAdapter 가
 * 연결 id 없이 낸 이벤트·send 결과가 이 Gateway 의 에이전트로 짝지어진다. 같은 id 가 이미 있으면 그대로 둔다(시드를 여러 번 불러도)
 */
export function insertGateway(
  db: DbOrTx,
  workspaceId: string,
  gateway: Partial<TestGateway> = {},
  now = new Date(),
): TestGateway {
  const row: TestGateway = {
    id: gateway.id ?? FAKE_GATEWAY_ID,
    name: gateway.name ?? "가짜 Gateway",
    url: gateway.url ?? "ws://127.0.0.1:19001",
    token: gateway.token ?? "fake-gateway-token",
    enabled: gateway.enabled ?? true,
  };
  db.insert(gateways)
    .values({ ...row, workspaceId, ownerUserId: null, lastVersion: null, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
  return row;
}

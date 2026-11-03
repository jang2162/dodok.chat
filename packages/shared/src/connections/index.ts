import { z } from "zod";
import { Id } from "../common";

// 누구나 읽는 연결 목록(연결 탭 통합 스펙 5.3) — 「연결」 탭 트리를 그리는 재료. 주소·토큰·호스트·루트는 싣지 않는다: 그것은 그 연결의
// 주인과 admin 이상만 보는 GET /setup/status·/gateways/:id/bridge-tokens·/setup/runner-tokens 몫이다

/** 연결의 주인 — 0034 전의 연결은 워크스페이스 owner. 주인 사용자를 찾을 수 없으면 null */
export const ConnectionOwner = z.object({ id: Id, name: z.string() });
export type ConnectionOwner = z.infer<typeof ConnectionOwner>;

/** GET /api/v1/connections 응답 */
export const ConnectionsResponse = z.object({
  // 더한 차례. approved 가 거짓이면 「승인 대기」 — 서버가 접속하지 않는다(스펙 5.4)
  gateways: z.array(
    z.object({
      id: Id,
      name: z.string(),
      enabled: z.boolean(),
      approved: z.boolean(),
      owner: ConnectionOwner.nullable(),
    }),
  ),
  // 새것부터(러너 토큰 목록과 같은 차례). connected 는 지금 붙어 있다
  runners: z.array(
    z.object({
      id: Id,
      label: z.string(),
      connected: z.boolean(),
      revoked: z.boolean(),
      owner: ConnectionOwner.nullable(),
    }),
  ),
  // 보관한 것도 싣는다(archived) — 화면이 가른다
  projects: z.array(z.object({ id: Id, runnerId: Id, label: z.string(), archived: z.boolean() })),
});
export type ConnectionsResponse = z.infer<typeof ConnectionsResponse>;

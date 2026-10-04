import { z } from "zod";
import { Id, IsoDateTime } from "../common";

// Gateway API 계약(멀티 Gateway 스펙 3.1·6.2) — owner 전용. Gateway 공유 토큰 원문은 요청 본문에만 있고 응답에는 tokenSet 만 싣는다

/** 화면 이름(예: 사무실·집) — 앞뒤 공백을 걷고 1~32자, 워크스페이스 안에서 유일(서버가 CONFLICT) */
export const GatewayName = z.string().trim().min(1).max(32);
export type GatewayName = z.infer<typeof GatewayName>;

/** Gateway WS 주소 — ws:// 또는 wss:// 만 */
export const GatewayUrl = z.url({ protocol: /^wss?$/, error: "ws:// 또는 wss:// 주소여야 한다" });
export type GatewayUrl = z.infer<typeof GatewayUrl>;

/** POST /api/v1/gateways 본문 */
export const CreateGatewayBody = z.object({
  name: GatewayName,
  url: GatewayUrl,
  token: z.string().min(1),
});
export type CreateGatewayBody = z.infer<typeof CreateGatewayBody>;

/** PATCH /api/v1/gateways/:id 본문 — token 이 빈 문자열이면 바꾸지 않는다(수정 대화상자의 「바꾸려면 입력」 칸) */
export const UpdateGatewayBody = z.object({
  name: GatewayName.optional(),
  url: GatewayUrl.optional(),
  token: z.string().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateGatewayBody = z.infer<typeof UpdateGatewayBody>;

/** 목록·추가·수정 응답의 Gateway 한 줄 — 공유 토큰은 싣지 않는다(늘 설정돼 있다) */
export const GatewaySummary = z.object({
  id: Id,
  name: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  tokenSet: z.literal(true),
  // 사람마다 자기 Gateway 를 붙이는 자리(스펙 결정 2) — v1 은 늘 null
  ownerUserId: Id.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type GatewaySummary = z.infer<typeof GatewaySummary>;

/** DELETE /api/v1/gateways/:id 응답 — 연결이 비워진 에이전트 수, 함께 지운 브리지 토큰 수(폐기된 것 포함) */
export const DeleteGatewayResult = z.object({
  unboundAgents: z.int().min(0),
  deletedTokens: z.int().min(0),
});
export type DeleteGatewayResult = z.infer<typeof DeleteGatewayResult>;

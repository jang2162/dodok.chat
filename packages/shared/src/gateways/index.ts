import { z } from "zod";
import { Id, IsoDateTime } from "../common";

// Gateway API 계약(멀티 Gateway 스펙 「gateways (새 표)」·「Gateway API」 절) — 그 Gateway 의 주인과 admin 이상(연결 탭 통합 스펙 5.2). Gateway 공유 토큰 원문은 요청 본문에만 있고 응답에는 tokenSet 만 싣는다

/** 화면 이름(예: 사무실·집) — 앞뒤 공백을 걷고 1~32자, 워크스페이스 안에서 유일(서버가 CONFLICT) */
export const GatewayName = z.string().trim().min(1).max(32);
export type GatewayName = z.infer<typeof GatewayName>;

// lib ES2022 에는 URL 선언이 없다 — 런타임은 브라우저·Node 공통 WHATWG 전역이고 z.url 도 이것으로 검증한다
const WhatwgUrl = (
  globalThis as unknown as { URL: new (input: string) => { username: string; password: string } }
).URL;

/**
 * Gateway WS 주소 — ws:// 또는 wss:// 만. 사용자 정보(user:pass@)는 받지 않는다 — 주소는 응답·설정 상태에 그대로 나가므로 비밀을
 * 담으면 공유 토큰을 응답에서 빼는 규칙을 우회한다. 값은 입력 그대로 둔다(정규화하면 흔한 주소에도 끝 / 가 붙어 owner 가 넣은
 * 글자와 달라진다)
 */
export const GatewayUrl = z
  .url({ protocol: /^wss?$/, error: "ws:// 또는 wss:// 주소여야 한다" })
  // 사용자 정보는 문자열 모양이 아니라 접속하는 쪽과 같은 WHATWG 파서로 가른다 — wss:/u:p@h·wss:u:p@h·wss:\u:p@h 도 파서는
  // wss://u:p@h/ 로 읽는다. 파싱이 안 되는 값은 z.url 이 이미 거절했으므로 여기서는 통과시킨다(zod 4 는 실패해도 refine 을 부른다)
  .refine(
    (url) => {
      try {
        const parsed = new WhatwgUrl(url);
        return parsed.username === "" && parsed.password === "";
      } catch {
        return true;
      }
    },
    { error: "주소에 사용자 정보를 넣을 수 없다" },
  );
export type GatewayUrl = z.infer<typeof GatewayUrl>;

/** POST /api/v1/gateways 본문 */
export const CreateGatewayBody = z.object({
  name: GatewayName,
  url: GatewayUrl,
  // 앞뒤 공백을 걷고 1자 이상
  token: z.string().trim().min(1),
});
export type CreateGatewayBody = z.infer<typeof CreateGatewayBody>;

/** PATCH /api/v1/gateways/:id 본문 — token 이 앞뒤 공백을 걷고 빈 문자열이면 바꾸지 않는다(수정 대화상자의 「바꾸려면 입력」 칸) */
export const UpdateGatewayBody = z.object({
  name: GatewayName.optional(),
  url: GatewayUrl.optional(),
  token: z.string().trim().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateGatewayBody = z.infer<typeof UpdateGatewayBody>;

/**
 * POST /api/v1/gateways/:id/approve 본문 — 승인하는 사람이 화면에서 본 주소. 서버는 지금 행의 주소와 글자 그대로 같을 때만 승인하고
 * 다르면 CONFLICT(그 사이 주인이 주소를 바꿨다 — 본 적 없는 주소를 승인하지 않게, 연결 탭 통합 스펙 5.4)
 */
export const ApproveGatewayBody = z.object({ url: z.string().min(1) });
export type ApproveGatewayBody = z.infer<typeof ApproveGatewayBody>;

/** 목록·추가·수정 응답의 Gateway 한 줄 — 공유 토큰은 싣지 않는다(늘 설정돼 있다) */
export const GatewaySummary = z.object({
  id: Id,
  name: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  tokenSet: z.literal(true),
  // 그 연결의 주인(만든 사람, 연결 탭 통합 스펙 5.1) — 0034 전의 행은 워크스페이스 owner 로 채워졌다
  ownerUserId: Id.nullable(),
  // admin 이상이 승인했는가 — 아니면 서버가 접속하지 않는다(스펙 5.4)
  approved: z.boolean(),
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

import { z } from "zod";
import { Id, IsoDateTime } from "../common";
import { Agent, Channel, DmReadOnlyReason } from "../domain";

// 에이전트 DM REST(에이전트 DM 계획 판정 PD1·PD3) — DM 채널은 열 때(POST /dms) 만들고, 첫 보내기는 채널 세션의 message.send 그대로다

/** POST /api/v1/dms — (나, 그 에이전트)의 DM 채널을 찾거나 만든다. 응답은 { channel } */
export const CreateDmBody = z.object({ agentId: Id });
export type CreateDmBody = z.infer<typeof CreateDmBody>;

/**
 * GET /api/v1/dms 한 줄 — 내 DM 하나. lastMessageAt 은 그 DM 의 세션 가운데 가장 최근 글 시각(아직 아무도 안 썼으면 null).
 * readOnlyReason 이 있으면 쓰기가 409 DM_READ_ONLY(details.reason 이 같은 값) — 되돌리면 이어 쓴다
 */
export const DmSummary = z.object({
  channel: Channel,
  agent: Agent,
  lastMessageAt: IsoDateTime.nullable(),
  readOnlyReason: DmReadOnlyReason.nullable(),
});
export type DmSummary = z.infer<typeof DmSummary>;

/** GET /api/v1/dms — 최근 활동순(lastMessageAt 이 없으면 DM 을 연 시각으로 센다) */
export const DmList = z.object({ dms: z.array(DmSummary) });
export type DmList = z.infer<typeof DmList>;

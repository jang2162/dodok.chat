import type { Agent } from "@dodok/shared";

/**
 * 보관(삭제)한 에이전트인가(스펙 「에이전트 보관」 절). `GET /agents` 는 보관한 것도 함께 준다 — 기록의 작성자·멘션 칩이 그 에이전트를
 * 계속 가리키므로, 고르는 자리(멘션 후보·채널에 넣기·멤버 줄·가져오기)만 이것으로 거른다.
 * `null` 과 비교하지 않는다 — 보관 열이 생기기 전의 오프라인 사본은 `archivedAt` 이 없어서, 그러면 모든 에이전트가 삭제된 것으로 보인다
 */
export const isArchived = (agent: Pick<Agent, "archivedAt">): boolean => Boolean(agent.archivedAt);

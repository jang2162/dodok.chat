import type { Person } from "@dodok/shared";

/**
 * 비활성 멤버인가(채널 보관·멤버 비활성화 스펙 「멤버 비활성화」 절). `GET /people`·`GET /members` 는 비활성 멤버도 함께 준다 —
 * 기록의 작성자·멘션 칩이 그 사람을 계속 가리키므로, 고르는 자리(멘션 후보·멤버 표)만 이것으로 거른다.
 * `null` 과 비교하지 않는다 — 비활성 열이 생기기 전의 오프라인 사본은 `deactivatedAt` 이 없어서, 그러면 모두가 비활성으로 보인다
 */
export const isDeactivated = (person: Pick<Person, "deactivatedAt">): boolean =>
  Boolean(person.deactivatedAt);

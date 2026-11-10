import { IssuedLink } from "@/features/members/IssuedLink";

/**
 * 만들기·재발급 직후 웹훅 URL 을 한 번 보이는 대화상자 본문(자동화 스펙 「웹훅」 장 — 원문은 그 응답 한 번뿐). 원문은 부르는 쪽
 * 대화상자의 컴포넌트 상태에만 있고 「복사했습니다」(`onDone`)로 버린다 — 쿼리 캐시·저장소·주소·콘솔에 남기지 않는다
 */
export function WebhookUrlOnce({ title, url, onDone }: { title: string; url: string; onDone: () => void }) {
  return <IssuedLink noun="주소" title={title} url={url} onDone={onDone} />;
}

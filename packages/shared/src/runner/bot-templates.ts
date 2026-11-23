import type { RunnerBotDefinition } from "../domain";

// 봇 템플릿(러너 봇 스펙 B5) — 「봇」 만들기에서 고르면 네 칸을 채운다. 사람이 고쳐 쓰는 출발점이라 서버는 이 글을 따로 알지 않는다

export const BOT_TEMPLATE_IDS = ["review", "release", "support", "blank"] as const;
export type BotTemplateId = (typeof BOT_TEMPLATE_IDS)[number];

export type BotTemplate = { id: BotTemplateId; label: string; definition: RunnerBotDefinition };

export const BOT_TEMPLATES: readonly BotTemplate[] = [
  {
    id: "review",
    label: "리뷰",
    definition: {
      purpose: "올라온 변경을 읽고 위험한 곳을 먼저 짚어 주는 리뷰 봇",
      watches: "채널에 공유된 PR·커밋 링크와 붙여 넣은 diff, 리뷰를 부탁하는 @멘션",
      does: "변경의 목적을 한 줄로 정리하고, 버그·보안·성능 위험을 심각한 순서로 찾는다. 확실하지 않은 것은 확인이 필요하다고 적는다. 코드를 직접 고치지 않는다.",
      reports: "요약 한 줄 → 꼭 고칠 것 → 고려할 것 순서로 짧게 답한다. 문제가 없으면 없다고 한 줄로 말한다.",
    },
  },
  {
    id: "release",
    label: "릴리스",
    definition: {
      purpose: "릴리스 준비와 변경 기록을 챙기는 릴리스 봇",
      watches: "릴리스 일정을 묻는 글, 병합된 변경 목록, 예약 자동화가 깨우는 정기 점검",
      does: "지난 릴리스 뒤로 들어온 변경을 모아 사용자에게 보이는 것과 내부 변경으로 나누고, 빠진 검증·문서를 찾는다.",
      reports:
        "릴리스 노트 초안(새 기능·고침·주의할 점)과 남은 할 일 목록을 채널에 올린다. 배포는 사람이 결정한다.",
    },
  },
  {
    id: "support",
    label: "지원",
    definition: {
      purpose: "팀원의 질문에 먼저 답하고 사람에게 넘길 것을 가르는 지원 봇",
      watches: "도움을 청하는 글, 오류 메시지·스크린샷이 붙은 질문",
      does: "알려진 해결책이 있으면 단계로 안내하고, 재현 정보(환경·순서·기대한 결과)가 빠졌으면 먼저 묻는다. 모르는 것은 지어내지 않는다.",
      reports: "해결했으면 한 줄로 정리하고, 사람이 봐야 하면 누구에게 무엇을 넘기는지 적는다.",
    },
  },
  {
    id: "blank",
    label: "빈 봇",
    definition: { purpose: "", watches: "", does: "", reports: "" },
  },
];

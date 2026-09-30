/**
 * 카드 안 버튼(액션 버튼·링크 버튼·모달 트리거)의 줄바꿈. 계약은 라벨을 80자까지 받는데 공용 `ui/button` 은
 * `whitespace-nowrap shrink-0`·고정 높이라 긴 라벨 버튼 하나가 좁은 화면에서 카드 밖으로 넘친다(버튼 줄의 `flex-wrap` 은
 * 버튼 **사이**만 바꾼다). 공용 버튼을 바꾸면 앱의 다른 버튼에 퍼지므로 카드 안 버튼에만 붙인다 — 줄 폭을 넘지 않고, 넘치는
 * 라벨은 줄을 바꾸며(띄어쓰기 없는 긴 낱말도), 높이는 `size="sm"` 의 32px 를 최소로 둔다
 */
export const CARD_BUTTON_WRAP =
  "h-auto min-h-8 max-w-full shrink py-1 text-left whitespace-normal wrap-break-word";

import { cn } from "@/lib/utils";
import { DISABLED_REASON_TEXT, type ItemState } from "./state";

/**
 * 비활성 사유를 회색으로만 두지 않고 **보이는 글**로 말한다(스펙 5.7) — 버튼·셀렉트·모달이 함께 쓴다.
 * 컨트롤에 `reasonProps` 를 펼치고 그 옆에 같은 id 로 `<DisabledHint>`(버튼 줄은 `<ReasonHint>`)를 둔다. 눌리는 상태면 둘 다 비어 자리도 없다.
 *
 * `title` 은 쓰지 않는다 — 비활성 버튼은 `pointer-events: none` 이라 마우스에 툴팁이 안 뜨고, 터치·키보드(비활성은 탭 차례 밖)에는 원래 없다
 */
export function reasonProps(state: ItemState, id: string): { "aria-describedby"?: string } {
  if (!state.reason) return {};
  return { "aria-describedby": id };
}

/**
 * 사유 한 줄. 글은 보이되 `aria-hidden` 이다 — 스크린 리더는 이것을 컨트롤의 설명(`aria-describedby` 가 id 를 직접 가리키면
 * 숨긴 요소도 설명이 된다)으로 **한 번만** 읽고, 문서를 훑을 때 따로 한 번 더 읽지 않는다.
 * `subject`(어느 버튼인가)는 눈에만 보인다 — 설명으로 읽을 때는 컨트롤 자신의 이름과 겹친다.
 * `subject` 가 붙는 것은 사유가 섞인 버튼 줄뿐이라, 그때는 줄을 하나씩 쓴다(`basis-full`) — 옆 힌트와 간격으로만 갈리면
 * 어디까지가 어느 버튼 얘기인지 흐리다.
 * 라이브 영역이 아니다: 잠김은 자주 바뀌어 바뀔 때마다 읽으면 시끄럽다(승인 카드 카운트다운과 같은 판단)
 */
export function ReasonHint({ id, text, subject }: { id: string; text: string; subject?: string }) {
  return (
    <span
      aria-hidden="true"
      data-slot="disabled-hint"
      className={cn("min-w-0 text-xs break-words text-muted-foreground", subject && "basis-full")}
    >
      {subject && `${subject}: `}
      <span id={id}>{text}</span>
    </span>
  );
}

export function DisabledHint({ state, id }: { state: ItemState; id: string }) {
  if (!state.reason) return null;
  return <ReasonHint id={id} text={DISABLED_REASON_TEXT[state.reason]} />;
}

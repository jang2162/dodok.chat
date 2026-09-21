import { DISABLED_REASON_TEXT, type ItemState } from "./state";

/**
 * 비활성 사유를 회색으로만 두지 않고 말한다(스펙 5.7) — 버튼·셀렉트·모달 트리거가 함께 쓴다.
 * `reasonProps` 를 컨트롤에 펼치고 `<DisabledHint>` 를 같은 id 로 그 옆에 둔다. 눌리는 상태면 둘 다 비어 있다
 */
export function reasonProps(state: ItemState, id: string): { title?: string; "aria-describedby"?: string } {
  if (!state.reason) return {};
  return { title: DISABLED_REASON_TEXT[state.reason], "aria-describedby": id };
}

export function DisabledHint({ state, id }: { state: ItemState; id: string }) {
  if (!state.reason) return null;
  return (
    <span id={id} className="sr-only">
      {DISABLED_REASON_TEXT[state.reason]}
    </span>
  );
}

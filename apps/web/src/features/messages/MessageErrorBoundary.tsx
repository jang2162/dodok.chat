import { Component, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** 바뀌면 다시 그려 본다(메시지가 수정·교체된 경우) */
  resetKey?: unknown;
};
type State = { failed: boolean; resetKey: unknown };

/**
 * 메시지 단위 에러 경계(스펙 8장) — 한 행의 렌더 예외는 그 행만 「표시할 수 없는 메시지」로 바꾸고 목록·앱은 계속 돈다.
 * 오류 기록은 React 가 한다(잡힌 오류도 콘솔에 남긴다)
 */
export class MessageErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { failed: false, resetKey: props.resetKey };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return <p className="px-4 py-1 pl-16 text-sm text-muted-foreground/70 italic">표시할 수 없는 메시지</p>;
  }
}

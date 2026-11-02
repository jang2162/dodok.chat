import { type RefObject, createContext, useContext } from "react";

/** 넓은 화면 상세 칸의 id — 상세를 옮기면 라우터가 이 칸을 맨 위로 돌린다(`scrollToTopSelectors`). 트리 칸은 그대로 둔다 */
export const CONNECTION_DETAIL_SCROLL_ID = "connection-detail-scroll";

/**
 * 「연결」 레이아웃이 상세 화면에 주는 것 — 트리 머리의 라이브 영역에 알리기, 다음 상세의 제목으로 초점 옮기기(트리 줄을 눌렀을 때),
 * 트리의 자리로 초점 돌려주기(보관해 상세가 비었을 때). 레이아웃 밖(시험의 단독 렌더)에서는 아무것도 하지 않는다
 */
export type ConnectionsCtx = {
  announce: (message: string) => void;
  /** 참이면 다음에 그려지는 상세 제목이 초점을 받는다 */
  focusDetail: RefObject<boolean>;
  /** 트리가 그 자리를 그리면 초점을 옮긴다 — 「삭제된 에이전트 N」 단추, 「＋ 연결 추가」 */
  focusTree: (target: "archived" | "add") => void;
};

export const ConnectionsContext = createContext<ConnectionsCtx>({
  announce: () => {},
  focusDetail: { current: false },
  focusTree: () => {},
});
export const useConnections = () => useContext(ConnectionsContext);

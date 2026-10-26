import type { Channel, DmReadOnlyReason } from "@dodok/shared";
import { createContext, useContext } from "react";

/** 채널 화면이 DM 을 그릴 때의 사정 — 그 DM 채널과 읽기 전용 사유(없으면 null, DM 목록을 아직 못 받았어도 null) */
export type DmView = { channel: Channel; readOnly: DmReadOnlyReason | null };

/**
 * 지금 그리는 채널이 DM 이면 그 사정, 아니면 null — 채널 화면(ChannelPage)이 그 아래(메시지·카드·작성기·활동 패널)에 내려 준다.
 * 메시지 줄마다 채널·DM 쿼리를 구독하지 않게 한다(`ChannelArchivedContext` 와 같은 까닭). 채널 화면 밖의 기본값은 「채널」이다
 */
export const DmViewContext = createContext<DmView | null>(null);
export const useDmView = (): DmView | null => useContext(DmViewContext);

import type { Channel, DmReadOnlyReason } from "@dodok/shared";
import { createContext, useContext } from "react";

/**
 * 채널 화면이 DM 을 그릴 때의 사정 — 그 채널과 읽기 전용 사유(없으면 null, 목록을 아직 못 받았어도 null). `kind` 는 채널의 것:
 * `dm`(에이전트 DM — 스레드·@ 후보 없음, 주인이 승인을 결정)과 `direct`(사람 DM·그룹 DM — 스레드·참여자 @ 후보 있음, 시킨 사람이 결정).
 * 칸을 비울 수 없다 — 비면 에이전트 DM 으로 읽히는 꼴이 되어 `direct` 에 주인 결정·스레드 없음이 붙는다(사람 간 DM 계획 「기본이 닫힘」).
 * 읽기 전용 잠금(반응·카드·첨부)은 둘 다 같은 `readOnly` 로 본다
 */
export type DmView = { kind: "dm" | "direct"; channel: Channel; readOnly: DmReadOnlyReason | null };
/** 사람 DM·그룹 DM 의 보기인가 */
export const isDirectView = (view: DmView | null): boolean => view?.kind === "direct";

/**
 * 지금 그리는 채널이 DM 이면 그 사정, 아니면 null — 채널 화면(ChannelPage)이 그 아래(메시지·카드·작성기·활동 패널)에 내려 준다.
 * 메시지 줄마다 채널·DM 쿼리를 구독하지 않게 한다(`ChannelArchivedContext` 와 같은 까닭). 채널 화면 밖의 기본값은 「채널」이다
 */
export const DmViewContext = createContext<DmView | null>(null);
export const useDmView = (): DmView | null => useContext(DmViewContext);

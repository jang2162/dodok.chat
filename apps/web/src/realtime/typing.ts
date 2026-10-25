import { create } from "zustand";

/** 받은 typing 은 5초 동안 보인다(스펙 4.7) */
export const TYPING_TTL_MS = 5_000;

type Actor = { actorType: "user" | "agent"; actorId: string };
/**
 * byConversation[conversationId]["<actorType>:<actorId>"] = 만료 시각(ms). 입력 중 표시는 그 세션에서만 보인다(채널 세션 계획 판정 PS7)
 * — 같은 채널의 다른 세션에서 쓰는 사람을 「작성 중」으로 보이면 어디에 쓰는지 틀리게 읽힌다
 */
type TypingState = {
  byConversation: Record<string, Record<string, number>>;
  note(p: Actor & { conversationId: string }, now?: number): void;
};

export const useTypingStore = create<TypingState>()((set) => ({
  byConversation: {},
  note: (p, now = Date.now()) =>
    set((s) => {
      // 그 세션의 만료된 항목은 이때 치운다
      const alive = Object.entries(s.byConversation[p.conversationId] ?? {}).filter(
        ([, until]) => until > now,
      );
      const key = `${p.actorType}:${p.actorId}`;
      return {
        byConversation: {
          ...s.byConversation,
          [p.conversationId]: { ...Object.fromEntries(alive), [key]: now + TYPING_TTL_MS },
        },
      };
    }),
}));

/** 그 세션에서 지금 작성 중인 행위자(기록 순). 자기 자신을 숨기는 것은 부르는 쪽 몫이다 */
export function typingActors(
  state: Pick<TypingState, "byConversation">,
  conversationId: string,
  now: number,
): Actor[] {
  return Object.entries(state.byConversation[conversationId] ?? {})
    .filter(([, until]) => until > now)
    .map(([key]) => {
      const [actorType, actorId] = key.split(":") as [Actor["actorType"], string];
      return { actorType, actorId };
    });
}

import { create } from "zustand";

/** 받은 typing 은 5초 동안 보인다(스펙 4.7) */
export const TYPING_TTL_MS = 5_000;

type Actor = { actorType: "user" | "agent"; actorId: string };
/** byChannel[channelId]["<actorType>:<actorId>"] = 만료 시각(ms) */
type TypingState = {
  byChannel: Record<string, Record<string, number>>;
  note(p: Actor & { channelId: string }, now?: number): void;
};

export const useTypingStore = create<TypingState>()((set) => ({
  byChannel: {},
  note: (p, now = Date.now()) =>
    set((s) => {
      // 그 채널의 만료된 항목은 이때 치운다
      const alive = Object.entries(s.byChannel[p.channelId] ?? {}).filter(([, until]) => until > now);
      const key = `${p.actorType}:${p.actorId}`;
      return {
        byChannel: {
          ...s.byChannel,
          [p.channelId]: { ...Object.fromEntries(alive), [key]: now + TYPING_TTL_MS },
        },
      };
    }),
}));

/** 지금 작성 중인 행위자(기록 순). 자기 자신을 숨기는 것은 부르는 쪽 몫이다 */
export function typingActors(state: Pick<TypingState, "byChannel">, channelId: string, now: number): Actor[] {
  return Object.entries(state.byChannel[channelId] ?? {})
    .filter(([, until]) => until > now)
    .map(([key]) => {
      const [actorType, actorId] = key.split(":") as [Actor["actorType"], string];
      return { actorType, actorId };
    });
}

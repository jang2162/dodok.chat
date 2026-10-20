import type { ChannelRead } from "@dodok/shared";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { useWireStatus } from "@/realtime/wire";
import { setViewingAtEnd } from "./useUnread";

/** 같은 채널의 읽음은 이만큼 모아 가장 큰 seq 하나로 보낸다(읽지 않음 스펙 「무엇이 「안 읽음」인가」 장) */
export const READ_DELAY_MS = 1_000;

export type ReadSender = {
  request(channelId: string, seq: number): void;
  dispose(): void;
};

/**
 * 채널마다 첫 요청부터 `delayMs` 동안 모아 가장 큰 seq 로 `channel.read` 를 보낸다 — 요청이 이어져도 보내기가 밀리지 않는다.
 * 서버가 저장했다고 답한 위치 이하는 다시 보내지 않는다. 실패(레이트 초과 포함)는 버리고 스스로 다시 보내지 않는다 — 다음
 * 요청(조건이 다시 설 때)이 보낸다. 서버 값은 커지기만 하므로 늦게 닿아도 안전하다. 이 규칙을 `docs/guides/docker-deploy.md`
 * 「운영 화면」 레이트리밋 표의 `channel.read` 줄도 가르친다 — 다시 보내는 방식을 바꾸면 그 줄도 고친다
 */
export function createReadSender(
  emit: (p: ChannelRead) => Promise<{ lastReadSeq: number }>,
  opts: { delayMs?: number } = {},
): ReadSender {
  const delayMs = opts.delayMs ?? READ_DELAY_MS;
  const stored = new Map<string, number>();
  const waiting = new Map<string, { seq: number; timer: ReturnType<typeof setTimeout> }>();
  let disposed = false;

  const done = (channelId: string) => stored.get(channelId) ?? 0;

  function flush(channelId: string): void {
    const w = waiting.get(channelId);
    waiting.delete(channelId);
    // 이미 저장된 위치 이하는 보내지 않는다 — 보내는 때에 보아야 모으는 사이에 닿은 앞 응답까지 거른다
    if (!w || disposed || w.seq <= done(channelId)) return;
    emit({ channelId, seq: w.seq }).then(
      ({ lastReadSeq }) => stored.set(channelId, Math.max(done(channelId), w.seq, lastReadSeq)),
      () => undefined,
    );
  }

  return {
    request(channelId, seq) {
      if (disposed) return;
      const w = waiting.get(channelId);
      if (w) {
        w.seq = Math.max(w.seq, seq);
        return;
      }
      waiting.set(channelId, { seq, timer: setTimeout(() => flush(channelId), delayMs) });
    },
    dispose() {
      disposed = true;
      for (const w of waiting.values()) clearTimeout(w.timer);
      waiting.clear();
    },
  };
}

/** 소켓마다 하나 — `WireProvider` 가 내린다. 없으면(로그인 전·테스트) 보내지 않는다 */
export const ReadSenderContext = createContext<ReadSender | undefined>(undefined);

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const pageVisible = () => document.visibilityState === "visible";

/**
 * 채널 타임라인의 끝이 보이고(`atEnd` — 떨어진 창이 아님) 탭이 보이면 그 채널의 읽음을 보낸다. 보내는 seq 는 타임라인의
 * `lastSeq`(스레드 답글 seq 포함 — 채널을 보면 그 seq 까지 읽음이다). 조건이 다시 설 때마다(끝으로 돌아옴·탭이 보이게 됨·
 * 새 메시지로 lastSeq 가 커짐·다시 붙음) 요청한다 — 실패한 전송을 다시 보내는 자리가 여기다. 끊겨 있는 동안은 보내지 않는다.
 * 끝이 보이는지는 activity 처리에도 알린다 — 그 채널의 새 글을 굵게 세지 않게(`setViewingAtEnd`).
 * 스레드 패널은 `enabled` 를 끈다 — 스레드만 보는 것은 채널 읽음을 올리지 않는다. `lastSeq` 0 은 구독 응답 전(오프라인 사본)이다
 */
export function useReadAtEnd(channelId: string, enabled: boolean, atEnd: boolean, lastSeq: number): void {
  const sender = useContext(ReadSenderContext);
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible);
  const connected = useWireStatus((s) => s.status === "connected");
  const seeing = enabled && atEnd && visible;

  useEffect(() => {
    if (!enabled) return;
    setViewingAtEnd(channelId, seeing);
    return () => setViewingAtEnd(channelId, false);
  }, [enabled, channelId, seeing]);

  useEffect(() => {
    if (seeing && connected && lastSeq > 0) sender?.request(channelId, lastSeq);
  }, [seeing, connected, lastSeq, sender, channelId]);
}

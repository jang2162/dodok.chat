import type { ConversationRead } from "@dodok/shared";
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { useWireStatus } from "@/realtime/wire";
import { setViewingAtEnd } from "./useUnread";

/** 같은 세션의 읽음은 이만큼 모아 가장 큰 seq 하나로 보낸다(읽지 않음 스펙 「무엇이 「안 읽음」인가」 장) */
export const READ_DELAY_MS = 1_000;

export type ReadSender = {
  request(conversationId: string, seq: number): void;
  dispose(): void;
};

/**
 * 세션마다 첫 요청부터 `delayMs` 동안 모아 가장 큰 seq 로 `conversation.read` 를 보낸다 — 요청이 이어져도 보내기가 밀리지 않는다.
 * 세션마다 따로 모으는 까닭: seq 는 채널 하나의 번호라 세션 A 의 seq 로 B 를 읽음 처리하면 B 의 안 읽은 글이 사라진다.
 * 서버가 저장했다고 답한 위치 이하는 다시 보내지 않는다. 실패(레이트 초과 포함)는 버리고 스스로 다시 보내지 않는다 — 다음
 * 요청(조건이 다시 설 때)이 보낸다. 서버 값은 커지기만 하므로 늦게 닿아도 안전하다. 이 규칙을 `docs/guides/docker-deploy.md`
 * 「운영 화면」 레이트리밋 표의 `conversation.read` 줄도 가르친다 — 다시 보내는 방식을 바꾸면 그 줄도 고친다
 */
export function createReadSender(
  emit: (p: ConversationRead) => Promise<{ lastReadSeq: number }>,
  opts: { delayMs?: number } = {},
): ReadSender {
  const delayMs = opts.delayMs ?? READ_DELAY_MS;
  const stored = new Map<string, number>();
  const waiting = new Map<string, { seq: number; timer: ReturnType<typeof setTimeout> }>();
  let disposed = false;

  const done = (conversationId: string) => stored.get(conversationId) ?? 0;

  function flush(conversationId: string): void {
    const w = waiting.get(conversationId);
    waiting.delete(conversationId);
    // 이미 저장된 위치 이하는 보내지 않는다 — 보내는 때에 보아야 모으는 사이에 닿은 앞 응답까지 거른다
    if (!w || disposed || w.seq <= done(conversationId)) return;
    emit({ conversationId, seq: w.seq }).then(
      ({ lastReadSeq }) => stored.set(conversationId, Math.max(done(conversationId), w.seq, lastReadSeq)),
      () => undefined,
    );
  }

  return {
    request(conversationId, seq) {
      if (disposed) return;
      const w = waiting.get(conversationId);
      if (w) {
        w.seq = Math.max(w.seq, seq);
        return;
      }
      waiting.set(conversationId, { seq, timer: setTimeout(() => flush(conversationId), delayMs) });
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
 * 세션 타임라인의 끝이 보이고(`atEnd` — 떨어진 창이 아님) 탭이 보이면 그 세션의 읽음을 보낸다. 보내는 seq 는 그 세션 타임라인의
 * `lastSeq`(그 세션의 스레드 답글 seq 포함 — 세션을 보면 그 seq 까지 읽음이다). 조건이 다시 설 때마다(끝으로 돌아옴·탭이 보이게 됨·
 * 새 메시지로 lastSeq 가 커짐·다시 붙음) 요청한다 — 실패한 전송을 다시 보내는 자리가 여기다. 끊겨 있는 동안은 보내지 않는다.
 * 끝이 보이는지는 activity 처리에도 알린다 — 그 세션의 새 글을 굵게 세지 않게(`setViewingAtEnd`).
 * 스레드 패널·새 세션 창은 `enabled` 를 끈다 — 스레드만 보는 것은 세션 읽음을 올리지 않고, 새 세션 창은 아직 세션이 없다.
 * `lastSeq` 0 은 구독 응답 전(오프라인 사본)이다
 */
export function useReadAtEnd(
  conversationId: string,
  enabled: boolean,
  atEnd: boolean,
  lastSeq: number,
): void {
  const sender = useContext(ReadSenderContext);
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible);
  const connected = useWireStatus((s) => s.status === "connected");
  const seeing = enabled && atEnd && visible;

  useEffect(() => {
    if (!enabled) return;
    setViewingAtEnd(conversationId, seeing);
    return () => setViewingAtEnd(conversationId, false);
  }, [enabled, conversationId, seeing]);

  useEffect(() => {
    if (seeing && connected && lastSeq > 0) sender?.request(conversationId, lastSeq);
  }, [seeing, connected, lastSeq, sender, conversationId]);
}

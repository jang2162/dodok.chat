/**
 * Gateway 원본 프레임 덤프 — 실연에서 usage 등 매퍼가 읽는 값의 출처를 가리기 위한 진단 스위치(live-smoke 5.4-2).
 *
 * 받은 `chat`·`agent`·`session.message` EventFrame 을 `{ receivedAt, frame }` JSONL 로 append 한다. 쓰기는 스트림이라
 * 이벤트 처리를 막지 않고, 쓰기 오류(디렉터리 없음·디스크 가득)는 warn 한 번 뒤 덤프만 끈다 — 런에는 영향이 없다.
 * 프레임에는 메시지 본문이 들어 있다: 경로는 data/ 아래(커밋 제외)에 둔다.
 */
import { createWriteStream, type WriteStream } from "node:fs";
import type { EventFrame } from "@openclaw/gateway-protocol";
import type { AdapterLogger } from "../adapter-types";

export type FrameDump = {
  write(frame: EventFrame): void;
  /** 버퍼를 비우고 파일을 닫는다. 두 번 불러도 된다 */
  close(): Promise<void>;
};

const DUMPED_EVENTS: ReadonlySet<string> = new Set(["chat", "agent", "session.message"]);

export function openFrameDump(path: string, logger: AdapterLogger): FrameDump {
  let stream: WriteStream | undefined = createWriteStream(path, { flags: "a" });
  stream.on("error", (err) => {
    logger.warn({ err, path }, "gateway frame dump failed; disabled");
    stream?.destroy();
    stream = undefined;
  });

  return {
    write(frame) {
      if (!stream || !DUMPED_EVENTS.has(frame.event)) return;
      stream.write(`${JSON.stringify({ receivedAt: new Date().toISOString(), frame })}\n`);
    },
    close() {
      const closing = stream;
      stream = undefined;
      if (!closing) return Promise.resolve();
      // 오류로 끝나도 resolve 한다 — 오류는 위 핸들러가 남긴다
      return new Promise((resolve) => {
        closing.end(() => resolve());
      });
    },
  };
}

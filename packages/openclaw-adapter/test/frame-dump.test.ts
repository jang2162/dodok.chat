import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openFrameDump } from "../src/gateway/frame-dump";
import * as f from "./fixtures/gateway-events";

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

function readLines(path: string): Array<{ receivedAt: string; frame: { event: string; seq?: number } }> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { receivedAt: string; frame: { event: string; seq?: number } });
}

describe("openFrameDump — Gateway 원본 프레임 JSONL(usage 조사용, live-smoke 5.4)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dodok-frame-dump-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("chat·agent·session.message 만 받은 순서대로 append 하고, close() 가 끝나면 파일에 다 있다", async () => {
    const path = join(dir, "frames.jsonl");
    writeFileSync(path, `${JSON.stringify({ receivedAt: "earlier", frame: { event: "chat" } })}\n`); // 덮어쓰지 않는다
    const dump = openFrameDump(path, logger());

    dump.write(f.lifecycleStart());
    dump.write(f.sessionsChanged()); // 런과 무관한 이벤트는 남기지 않는다
    dump.write(f.chatDelta("안"));
    dump.write(f.sessionMessage());
    dump.write(f.chatFinal("안녕"));
    await dump.close();

    const lines = readLines(path);
    expect(lines.map((l) => l.frame.event)).toEqual(["chat", "agent", "chat", "session.message", "chat"]);
    expect(lines[1]?.frame).toEqual(f.lifecycleStart());
    expect(lines[4]?.frame).toEqual(f.chatFinal("안녕"));
    for (const line of lines.slice(1)) expect(Date.parse(line.receivedAt)).not.toBeNaN();

    // 닫은 뒤의 쓰기는 버린다(던지지 않는다)
    dump.write(f.chatFinal("늦음"));
    await dump.close();
    expect(readLines(path)).toHaveLength(5);
  });

  it("쓰기 오류(없는 디렉터리 등)는 warn 한 번 뒤 덤프를 끄고, write·close 는 던지지 않는다", async () => {
    const log = logger();
    const dump = openFrameDump(join(dir, "missing", "frames.jsonl"), log);

    dump.write(f.chatDelta("안"));
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(1));
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), path: join(dir, "missing", "frames.jsonl") }),
      "gateway frame dump failed; disabled",
    );
    expect(() => dump.write(f.chatFinal("안녕"))).not.toThrow();
    await expect(dump.close()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("열기가 실패하는 중에 곧바로 close() 해도 resolve 한다(서버 종료가 멈추지 않는다)", async () => {
    const log = logger();
    const dump = openFrameDump(join(dir, "missing", "frames.jsonl"), log);
    dump.write(f.chatDelta("안"));
    await expect(dump.close()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(1));
  });
});

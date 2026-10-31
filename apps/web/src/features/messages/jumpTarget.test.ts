import { afterEach, describe, expect, it } from "vitest";
import { CH, msg } from "../../../test/fixtures";
import { listKey, requestJump, useJumpStore } from "./jumpTarget";

afterEach(() => useJumpStore.setState({ targets: {} }));

describe("requestJump", () => {
  const ROOT = msg(1);
  const reply = msg(133, { threadRootId: ROOT.id });

  it("답글 결과는 세션 목록에 루트를, 스레드 패널에 그 답글을 — 초점은 스레드 패널 목표에만 싣는다", () => {
    requestJump(
      { conversationId: CH, messageId: reply.id, seq: reply.seq, threadRootId: ROOT.id },
      { focus: true },
    );
    const { targets } = useJumpStore.getState();
    expect(targets[listKey(CH)]).toEqual({ messageId: ROOT.id, seq: 133 });
    expect(targets[listKey(CH, ROOT.id)]).toEqual({ messageId: reply.id, seq: 133, focus: true });
  });

  it("세션 글 결과는 세션 목록 목표가 초점을 싣는다", () => {
    const hit = msg(10);
    requestJump({ conversationId: CH, messageId: hit.id, seq: 10 }, { focus: true });
    expect(useJumpStore.getState().targets).toEqual({
      [listKey(CH)]: { messageId: hit.id, seq: 10, focus: true },
    });
  });

  it("초점을 바라지 않으면 어느 목표에도 싣지 않는다", () => {
    requestJump({ conversationId: CH, messageId: reply.id, seq: reply.seq, threadRootId: ROOT.id });
    const { targets } = useJumpStore.getState();
    expect(targets[listKey(CH)]).not.toHaveProperty("focus");
    expect(targets[listKey(CH, ROOT.id)]).not.toHaveProperty("focus");
  });
});

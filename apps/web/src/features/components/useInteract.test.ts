import { ComponentsV1, type Message } from "@dodok/shared";
import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWireStatus } from "@/realtime/wire";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { msg, uid } from "../../../test/fixtures";
import { DISABLED_REASON_TEXT } from "./state";
import { type Interact, interactErrorText, type SendResult, useInteract } from "./useInteract";

// 소켓은 테스트가 쥔 가짜 — WireProvider 의 나머지는 원본
let fake: FakeSocket | undefined;
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: fake?.wire, subscriptions: undefined }),
}));

const CARD = ComponentsV1.parse({
  id: "cmp_1",
  blocks: [{ type: "actions", items: [{ type: "button", id: "ok", label: "확인" }] }],
});
const MESSAGE = msg(1, {
  components: CARD,
  componentState: { expiresAt: "2999-01-01T00:00:00.000Z", consumed: [] },
});
const ISSUES = { issues: [{ path: ["fields", "title"], message: "Too small" }] };

/** 훅을 띄운다 — send 뒤의 busy 까지 볼 때 */
function mount(message: Message): { current: Interact } {
  return renderHook(() => useInteract(message)).result;
}

/** 띄운 훅으로 send 한 번 — 거부하면 테스트가 여기서 터진다 */
async function sendWith(
  hook: { current: Interact },
  ...args: Parameters<Interact["send"]>
): Promise<SendResult> {
  let out: SendResult | undefined;
  await act(async () => {
    out = await hook.current.send(...args);
  });
  if (!out) throw new Error("send 가 결과를 돌려주지 않았다");
  return out;
}

/** 훅을 띄워 send 한 번 */
function sendOnce(message: Message, ...args: Parameters<Interact["send"]>): Promise<SendResult> {
  return sendWith(mount(message), ...args);
}

beforeEach(() => {
  fake = createFakeSocket();
  useWireStatus.getState().setStatus("connected");
});
afterEach(() => {
  fake = undefined;
  useWireStatus.getState().setStatus("idle");
  vi.restoreAllMocks();
});

describe("useInteract — send 결과", () => {
  it("ack 이 ok 면 { ok: true, interactionId } 이고 토스트는 없다", async () => {
    const error = vi.spyOn(toast, "error");
    fake?.onAck("component.interact", () => ({ ok: true, data: { interactionId: uid(500) } }));
    expect(await sendOnce(MESSAGE, "ok", {})).toStrictEqual({ ok: true, interactionId: uid(500) });
    expect(error).not.toHaveBeenCalled();
  });

  it("ack 모양이 깨져 interactionId 가 없어도 보낸 것은 성공이다 — 초점만 안 건다", async () => {
    fake?.onAck("component.interact", () => ({ ok: true, data: {} }) as never);
    const hook = mount(MESSAGE);
    expect(await sendWith(hook, "ok", {})).toStrictEqual({ ok: true });
    expect(hook.current.focusId).toBeUndefined();
  });

  it("ack 오류면 거부하지 않고 코드·문구·details 를 돌려주며, 기본은 토스트도 한다", async () => {
    const error = vi.spyOn(toast, "error");
    fake?.onAck("component.interact", () => ({
      ok: false,
      error: { code: "VALIDATION", message: "invalid values", details: ISSUES },
    }));
    expect(await sendOnce(MESSAGE, "ok", { fields: {} })).toStrictEqual({
      ok: false,
      code: "VALIDATION",
      text: "처리할 수 없는 요청입니다",
      details: ISSUES,
    });
    expect(error).toHaveBeenCalledWith("처리할 수 없는 요청입니다");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("toast: false 면 토스트 없이 결과만 — 모달이 대화상자 안에 문구를 둔다", async () => {
    const error = vi.spyOn(toast, "error");
    fake?.onAck("component.interact", () => ({
      ok: false,
      error: { code: "VALIDATION", message: "invalid values", details: ISSUES },
    }));
    const r = await sendOnce(MESSAGE, "ok", { fields: {} }, { toast: false });
    expect(r).toStrictEqual({
      ok: false,
      code: "VALIDATION",
      text: "처리할 수 없는 요청입니다",
      details: ISSUES,
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("응답이 없으면 TIMEOUT, details 가 없는 오류에는 details 키도 없다 — 토스트는 opts 를 따른다", async () => {
    const error = vi.spyOn(toast, "error");
    const timeout = { ok: false, code: "TIMEOUT", text: "서버 응답이 없습니다" };
    // 대본이 없으면 가짜 소켓의 emitWithAck 가 던진다 = 시간 초과
    expect(await sendOnce(MESSAGE, "ok", {}, { toast: false })).toStrictEqual(timeout);
    expect(error).not.toHaveBeenCalled();
    expect(await sendOnce(MESSAGE, "ok", {})).toStrictEqual(timeout);
    expect(error).toHaveBeenCalledWith("서버 응답이 없습니다");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("ack 모양이 깨져 WireAckError 가 아닌 것이 던져져도 거부하지 않고 INTERNAL — 토스트는 opts 를 따른다", async () => {
    const error = vi.spyOn(toast, "error");
    fake?.onAck("component.interact", () => undefined as never);
    const internal = { ok: false, code: "INTERNAL", text: "요청을 처리하지 못했습니다" };
    expect(await sendOnce(MESSAGE, "ok", {}, { toast: false })).toStrictEqual(internal);
    expect(error).not.toHaveBeenCalled();
    expect(await sendOnce(MESSAGE, "ok", {})).toStrictEqual(internal);
    expect(error).toHaveBeenCalledWith("요청을 처리하지 못했습니다");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("소켓이 없으면 보내지 않고 DISCONNECTED — 토스트는 opts 를 따르고 busy 는 켜지 않는다", async () => {
    const error = vi.spyOn(toast, "error");
    fake = undefined;
    const hook = mount(MESSAGE);
    const disconnected = { ok: false, code: "DISCONNECTED", text: DISABLED_REASON_TEXT.disconnected };
    expect(await sendWith(hook, "ok", {}, { toast: false })).toStrictEqual(disconnected);
    expect(error).not.toHaveBeenCalled();
    expect(await sendWith(hook, "ok", {})).toStrictEqual(disconnected);
    expect(error).toHaveBeenCalledWith(DISABLED_REASON_TEXT.disconnected);
    // 켜고 지우지 않으면 재연결 뒤에도 그 아이템이 「보내는 중」으로 남는다
    expect(hook.current.busy.size).toBe(0);
  });

  it("components.id 가 없으면(서버가 아직 id 를 안 준 카드) 보내지 않고 DISCONNECTED", async () => {
    const noId = msg(1, { components: { ...CARD, id: undefined } });
    expect(await sendOnce(noId, "ok", {}, { toast: false })).toMatchObject({
      ok: false,
      code: "DISCONNECTED",
    });
    expect(fake?.sentOf("component.interact")).toEqual([]);
  });
});

describe("useInteract — 결정 뒤 초점 표식", () => {
  it("성공하면 그 상호작용 id 로 걸리고, focusDone 이 내린다", async () => {
    fake?.onAck("component.interact", () => ({ ok: true, data: { interactionId: uid(500) } }));
    const hook = mount(MESSAGE);
    expect(hook.current.focusId).toBeUndefined();
    await sendWith(hook, "ok", {});
    expect(hook.current.focusId).toBe(uid(500));
    act(() => hook.current.focusDone());
    expect(hook.current.focusId).toBeUndefined();
  });

  it("실패하면 걸지 않는다 — 결과 줄이 생기지 않는다", async () => {
    fake?.onAck("component.interact", () => ({ ok: false, error: { code: "EXPIRED", message: "x" } }));
    vi.spyOn(toast, "error");
    const hook = mount(MESSAGE);
    await sendWith(hook, "ok", {});
    expect(hook.current.focusId).toBeUndefined();
  });

  it("focus: false 면 성공해도 걸지 않고 id 만 돌려준다 — 모달이 닫힌 뒤 focusResult 로 건다", async () => {
    fake?.onAck("component.interact", () => ({ ok: true, data: { interactionId: uid(500) } }));
    const hook = mount(MESSAGE);
    expect(await sendWith(hook, "ok", {}, { focus: false })).toStrictEqual({
      ok: true,
      interactionId: uid(500),
    });
    expect(hook.current.focusId).toBeUndefined();
    act(() => hook.current.focusResult(uid(500)));
    expect(hook.current.focusId).toBe(uid(500));
  });
});

describe("interactErrorText", () => {
  it("표에 있는 코드는 웹 문구, 없는 코드는 서버 문구", () => {
    expect(interactErrorText("EXPIRED", "server says")).toBe("만료된 버튼입니다");
    expect(interactErrorText("TIMEOUT", "server says")).toBe("서버 응답이 없습니다");
    expect(interactErrorText("INTERNAL", "터졌다")).toBe("터졌다");
  });
});

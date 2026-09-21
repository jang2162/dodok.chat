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

/** 훅을 띄워 send 한 번 — 거부하면 테스트가 여기서 터진다 */
async function sendOnce(message: Message, ...args: Parameters<Interact["send"]>): Promise<SendResult> {
  const { result } = renderHook(() => useInteract(message));
  let out: SendResult | undefined;
  await act(async () => {
    out = await result.current.send(...args);
  });
  if (!out) throw new Error("send 가 결과를 돌려주지 않았다");
  return out;
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
  it("ack 이 ok 면 { ok: true } 이고 토스트는 없다", async () => {
    const error = vi.spyOn(toast, "error");
    fake?.onAck("component.interact", () => ({ ok: true, data: { interactionId: uid(500) } }));
    expect(await sendOnce(MESSAGE, "ok", {})).toStrictEqual({ ok: true });
    expect(error).not.toHaveBeenCalled();
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

  it("응답이 없으면 TIMEOUT, details 가 없는 오류에는 details 키도 없다", async () => {
    // 대본이 없으면 가짜 소켓의 emitWithAck 가 던진다 = 시간 초과
    expect(await sendOnce(MESSAGE, "ok", {}, { toast: false })).toStrictEqual({
      ok: false,
      code: "TIMEOUT",
      text: "서버 응답이 없습니다",
    });
  });

  it("ack 모양이 깨져 WireAckError 가 아닌 것이 던져져도 거부하지 않고 INTERNAL", async () => {
    fake?.onAck("component.interact", () => undefined as never);
    expect(await sendOnce(MESSAGE, "ok", {}, { toast: false })).toStrictEqual({
      ok: false,
      code: "INTERNAL",
      text: "요청을 처리하지 못했습니다",
    });
  });

  it("소켓이 없으면 보내지 않고 DISCONNECTED — 토스트는 opts 를 따른다", async () => {
    const error = vi.spyOn(toast, "error");
    fake = undefined;
    const disconnected = { ok: false, code: "DISCONNECTED", text: DISABLED_REASON_TEXT.disconnected };
    expect(await sendOnce(MESSAGE, "ok", {}, { toast: false })).toStrictEqual(disconnected);
    expect(error).not.toHaveBeenCalled();
    expect(await sendOnce(MESSAGE, "ok", {})).toStrictEqual(disconnected);
    expect(error).toHaveBeenCalledWith(DISABLED_REASON_TEXT.disconnected);
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

describe("interactErrorText", () => {
  it("표에 있는 코드는 웹 문구, 없는 코드는 서버 문구", () => {
    expect(interactErrorText("EXPIRED", "server says")).toBe("만료된 버튼입니다");
    expect(interactErrorText("TIMEOUT", "server says")).toBe("서버 응답이 없습니다");
    expect(interactErrorText("INTERNAL", "터졌다")).toBe("터졌다");
  });
});

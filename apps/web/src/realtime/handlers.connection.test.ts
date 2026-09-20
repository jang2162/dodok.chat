import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/app/queryClient";
import { createFakeSocket } from "../../test/fakeSocket";
import { uid, USER } from "../../test/fixtures";
import { attachHandlers, nextRetryDelay, WIRE_RETRY_BASE_MS, WIRE_RETRY_MAX_MS } from "./handlers";
import { createSubscriptions } from "./subscriptions";
import { useWireStatus } from "./wire";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ME = { user: { id: USER, handle: "owner" }, workspaceId: uid(3) };
const connectError = (code: string) =>
  Object.assign(new Error(code), { data: { code, message: "rejected by middleware" } });
const status = () => useWireStatus.getState().status;

const detachers: Array<() => void> = [];

/** 이 파일은 연결만 본다 — 승인 알림 자리는 아무것도 하지 않는 것으로 채운다 */
const noNotify = { currentChannelId: () => undefined, openActivity: () => {} };

/** 붙어 있는 가짜 소켓에, 실제 QueryClient(createQueryClient)·구독 관리자로 핸들러를 붙인다. onUnauthorized 는 앱과 같은 하나 */
function setup() {
  const fake = createFakeSocket();
  fake.socket.connected = true;
  fake.socket.active = true;
  const onUnauthorized = vi.fn();
  const queryClient = createQueryClient(onUnauthorized);
  const subscriptions = createSubscriptions({ socket: fake.wire, queryClient });
  detachers.push(attachHandlers(fake.wire, { queryClient, subscriptions, onUnauthorized, notify: noNotify }));
  return { fake, subscriptions, onUnauthorized };
}

beforeEach(() => {
  useWireStatus.setState({ status: "idle" });
  // 지터를 가운데로 고정한다 — 간격이 정확히 base·base*2… 가 된다(afterEach 의 restoreAllMocks 가 거둔다)
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  for (const detach of detachers.splice(0)) detach();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("연결 상태", () => {
  it("connect 는 connected 로 두고 붙을 때마다 보고 있는 채널을 다시 맞춘다(resubscribeAll)", () => {
    const { fake, subscriptions } = setup();
    const resubscribeAll = vi.spyOn(subscriptions, "resubscribeAll").mockResolvedValue();

    fake.serverEmit("connect");
    expect(status()).toBe("connected");
    fake.serverEmit("disconnect", "transport close");
    fake.serverEmit("connect");

    expect(resubscribeAll).toHaveBeenCalledTimes(2);
  });

  it("disconnect 는 reconnecting, 이쪽에서 끊은 것(io client disconnect)은 offline", () => {
    const { fake } = setup();
    fake.serverEmit("connect");
    fake.serverEmit("disconnect", "transport close");
    expect(status()).toBe("reconnecting");
    fake.serverEmit("connect");
    fake.serverEmit("disconnect", "io client disconnect");
    expect(status()).toBe("offline");
  });

  it("서버가 끊은 것(io server disconnect)은 WIRE_RETRY_BASE_MS 뒤 직접 다시 붙는다 — 전송 끊김·이쪽에서 끊은 것은 아니다", async () => {
    vi.useFakeTimers();
    const { fake } = setup();
    const connects = fake.calls.connect;
    fake.serverEmit("connect");

    fake.socket.active = false; // 서버가 끊으면 socket.io 가 소켓을 닫는다(destroy) — 스스로 다시 붙지 않는다
    fake.serverEmit("disconnect", "io server disconnect");
    expect(status()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(WIRE_RETRY_BASE_MS - 1);
    expect(fake.calls.connect).toBe(connects);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.calls.connect).toBe(connects + 1);

    // 전송 끊김은 socket.io 가 다시 붙는다(active)
    fake.serverEmit("connect");
    fake.serverEmit("disconnect", "transport close");
    await vi.advanceTimersByTimeAsync(WIRE_RETRY_BASE_MS * 2);
    expect(fake.calls.connect).toBe(connects + 1);

    fake.serverEmit("connect");
    fake.serverEmit("disconnect", "io client disconnect");
    await vi.advanceTimersByTimeAsync(WIRE_RETRY_BASE_MS * 2);
    expect(fake.calls.connect).toBe(connects + 1);
    expect(status()).toBe("offline");
  });

  it("그 밖의 connect_error(전송 실패)는 reconnecting — socket.io 가 스스로 다시 붙는다(직접 connect 를 겹쳐 부르지 않는다)", async () => {
    vi.useFakeTimers();
    const { fake, onUnauthorized } = setup();
    const connects = fake.calls.connect;
    fake.serverEmit("connect_error", new Error("websocket error"));
    expect(status()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(WIRE_RETRY_BASE_MS * 2);
    expect(fake.calls.connect).toBe(connects);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("알 수 없는 코드의 미들웨어 거절(active 거짓)은 WIRE_RETRY_BASE_MS 뒤 직접 다시 붙는다 — 그 전에 붙으면 걸어 둔 재연결을 거둔다", async () => {
    vi.useFakeTimers();
    const { fake, onUnauthorized } = setup();
    const connects = fake.calls.connect;

    fake.socket.active = false; // 미들웨어 거절은 socket.io 가 소켓을 닫는다(destroy)
    fake.serverEmit("connect_error", connectError("INTERNAL"));
    expect(status()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(WIRE_RETRY_BASE_MS);
    expect(fake.calls.connect).toBe(connects + 1);

    fake.socket.active = false;
    fake.serverEmit("connect_error", connectError("INTERNAL"));
    fake.serverEmit("connect");
    await vi.advanceTimersByTimeAsync(WIRE_RETRY_BASE_MS * 2);
    expect(fake.calls.connect).toBe(connects + 1);
    expect(status()).toBe("connected");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("connect_error PROTOCOL_MISMATCH: protocol_mismatch 로 두고 소켓을 끊는다", () => {
    const { fake } = setup();
    fake.serverEmit("connect_error", connectError("PROTOCOL_MISMATCH"));
    expect(status()).toBe("protocol_mismatch");
    expect(fake.calls.disconnect).toBe(1);
    fake.serverEmit("disconnect", "io client disconnect");
    expect(status()).toBe("protocol_mismatch");
  });

  it("connect_error UNAUTHORIZED 인데 REST 세션은 살아 있으면(me 200) rejected — 로그인으로 보내지 않고 다시 붙지 않는다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, ME));
    vi.stubGlobal("fetch", fetchMock);
    const { fake, onUnauthorized } = setup();
    fake.socket.active = false; // 미들웨어 거절은 socket.io 가 자동 재연결하지 않는다
    const connects = fake.calls.connect;

    fake.serverEmit("connect_error", connectError("UNAUTHORIZED"));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["/api/v1/auth/me"]);
    expect(status()).toBe("rejected");
    await vi.advanceTimersByTimeAsync(WIRE_RETRY_BASE_MS * 10);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(fake.calls.connect).toBe(connects);
    expect(fake.socket.active).toBe(false);
    expect(status()).toBe("rejected");
  });

  it("connect_error UNAUTHORIZED 이고 me 도 401 이면 onUnauthorized 를 한 번 부른다", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json(401, { code: "UNAUTHORIZED", message: "로그인이 필요하다" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { fake, onUnauthorized } = setup();

    fake.serverEmit("connect_error", connectError("UNAUTHORIZED"));

    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    // me 가 한 번 더 도는 일(전역 401 처리)도 없다
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("connect_error UNAUTHORIZED 인데 me 확인이 네트워크 실패면 끊김처럼 reconnecting 으로 두고 잠시 뒤 다시 붙는다", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const { fake, onUnauthorized } = setup();
    fake.socket.active = false;
    const connects = fake.calls.connect;

    fake.serverEmit("connect_error", connectError("UNAUTHORIZED"));
    // me 쿼리는 네트워크 실패를 두 번 더 시도한다(1s·2s)
    await vi.advanceTimersByTimeAsync(3_000);
    expect(status()).toBe("reconnecting");
    expect(fake.calls.connect).toBe(connects);

    await vi.advanceTimersByTimeAsync(WIRE_RETRY_BASE_MS);
    expect(fake.calls.connect).toBe(connects + 1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("해제 함수는 붙인 리스너를 모두 떼고, 기다리던 재연결도 거둔다", async () => {
    vi.useFakeTimers();
    const fake = createFakeSocket();
    const before = fake.listenerCount();
    const onUnauthorized = vi.fn();
    const queryClient = createQueryClient(onUnauthorized);
    const subscriptions = createSubscriptions({ socket: fake.wire, queryClient });
    const detach = attachHandlers(fake.wire, {
      queryClient,
      subscriptions,
      onUnauthorized,
      notify: noNotify,
    });
    expect(fake.listenerCount()).toBeGreaterThan(before);

    // 알 수 없는 코드의 미들웨어 거절 → 스스로 다시 붙기를 걸어 둔 채로 뗀다
    fake.serverEmit("connect_error", connectError("INTERNAL"));
    detach();
    expect(fake.listenerCount()).toBe(before);
    await vi.advanceTimersByTimeAsync(WIRE_RETRY_BASE_MS * 2);
    expect(fake.calls.connect).toBe(0);
  });
});

describe("재연결 백오프", () => {
  it("간격은 2초에서 두 배씩 — 지터 ±20%, 30초에서 멈춘다", () => {
    const mid = () => 0.5;
    expect(nextRetryDelay(0, mid)).toBe(WIRE_RETRY_BASE_MS);
    expect(nextRetryDelay(1, mid)).toBe(WIRE_RETRY_BASE_MS * 2);
    expect(nextRetryDelay(5, mid)).toBe(WIRE_RETRY_MAX_MS); // 2s*32 = 64s → 상한
    expect(nextRetryDelay(40, mid)).toBe(WIRE_RETRY_MAX_MS); // 2 ** 40 도 넘치지 않는다

    // 지터는 -20%~+20%
    expect(nextRetryDelay(0, () => 0)).toBe(1_600);
    expect(nextRetryDelay(0, () => 0.999_999)).toBe(2_400);
    expect(nextRetryDelay(9, () => 0)).toBe(24_000);
    expect(nextRetryDelay(9, () => 0.999_999)).toBe(36_000);
  });

  it("이어진 거절은 두 배씩 뜸해지고, 다시 붙으면(connect) 첫 간격으로 돌아간다", async () => {
    vi.useFakeTimers();
    const { fake } = setup();
    let connects = fake.calls.connect;
    const reject = () => {
      fake.socket.active = false; // 미들웨어 거절은 소켓을 닫는다 — 직접 다시 붙는 길
      fake.serverEmit("connect_error", connectError("INTERNAL"));
    };
    /** 그 간격 직전까지는 가만히 있다가 그 순간에 한 번 붙는다 */
    const expectRetryAfter = async (delay: number) => {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fake.calls.connect).toBe(connects);
      await vi.advanceTimersByTimeAsync(1);
      connects += 1;
      expect(fake.calls.connect).toBe(connects);
    };

    for (const factor of [1, 2, 4]) {
      reject();
      await expectRetryAfter(WIRE_RETRY_BASE_MS * factor);
    }

    fake.serverEmit("connect");
    reject();
    await expectRetryAfter(WIRE_RETRY_BASE_MS);
  });
});

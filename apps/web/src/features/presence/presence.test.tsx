import type { PresenceEntry } from "@dodok/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MeResponse, qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { attachHandlers } from "@/realtime/handlers";
import { createSubscriptions } from "@/realtime/subscriptions";
import { createFakeSocket } from "../../../test/fakeSocket";
import { uid } from "../../../test/fixtures";
import { AuthorAvatar } from "@/features/messages/MessageItem";
import { PresenceDot } from "./PresenceDot";
import { usePresenceStore } from "./store";

// 접속 점(프로필 스펙 3.3) — 스냅숏은 통째로 바꾸고, 변화는 그 줄만 합친다

const A = uid(1);
const B = uid(2);
const BOT = uid(3);
const entryOf = (id: string) => usePresenceStore.getState().entries[`user:${id}`];

const detachers: Array<() => void> = [];
function setup() {
  const fake = createFakeSocket();
  fake.socket.connected = true;
  fake.socket.active = true;
  const queryClient = createQueryClient(() => undefined);
  const subscriptions = createSubscriptions({ socket: fake.wire, queryClient });
  detachers.push(
    attachHandlers(fake.wire, {
      queryClient,
      subscriptions,
      onUnauthorized: () => undefined,
      notify: {
        currentChannelId: () => undefined,
        currentConversationId: () => undefined,
        openActivity: () => {},
      },
    }),
  );
  return { fake, queryClient };
}

beforeEach(() => {
  usePresenceStore.getState().applySnapshot([]);
});
afterEach(() => {
  for (const d of detachers.splice(0)) d();
});

describe("presence store over wire", () => {
  it("스냅숏 뒤 changed 하나는 그 줄만 바꾸고 나머지를 남긴다", () => {
    const { fake } = setup();
    fake.serverEmit("presence.snapshot", {
      entries: [
        { kind: "user", id: A, state: "online" },
        { kind: "user", id: B, state: "offline" },
        { kind: "agent", id: BOT, state: "available" },
      ] satisfies PresenceEntry[],
    });
    fake.serverEmit("presence.changed", { entries: [{ kind: "user", id: A, state: "away" }] });
    expect(entryOf(A)?.state).toBe("away");
    expect(entryOf(B)?.state).toBe("offline");
    expect(usePresenceStore.getState().entries[`agent:${BOT}`]?.state).toBe("available");
  });

  it("다시 붙은 뒤의 스냅숏은 사라진 줄을 지운다", () => {
    const { fake } = setup();
    fake.serverEmit("presence.snapshot", {
      entries: [
        { kind: "user", id: A, state: "online" },
        { kind: "user", id: B, state: "online" },
      ],
    });
    fake.serverEmit("presence.snapshot", { entries: [{ kind: "user", id: A, state: "busy" }] });
    expect(entryOf(A)?.state).toBe("busy");
    expect(entryOf(B)).toBeUndefined();
  });

  it("me.status 는 me 캐시의 status 를 바꾼다(본인의 다른 탭·기기)", () => {
    const { fake, queryClient } = setup();
    queryClient.setQueryData<MeResponse>(qk.me, {
      user: {
        id: A,
        workspaceId: uid(9),
        handle: "a",
        displayName: "A",
        authProvider: "local",
        createdAt: "2026-11-02T00:00:00.000Z",
      },
      workspaceId: uid(9),
    });
    const status = { mode: "dnd" as const, modeUntil: null, message: null, dndAllowApprovals: false };
    fake.serverEmit("me.status", { status });
    expect(queryClient.getQueryData<MeResponse>(qk.me)?.status).toEqual(status);
  });
});

describe("PresenceDot", () => {
  it("aria-label 은 한국어 상태 이름", () => {
    render(<PresenceDot entry={{ kind: "user", id: A, state: "busy" }} />);
    expect(screen.getByRole("img", { name: "다른 용무 중" })).toBeTruthy();
  });

  it("에이전트 상태 이름", () => {
    render(<PresenceDot entry={{ kind: "agent", id: BOT, state: "working" }} size="lg" />);
    expect(screen.getByRole("img", { name: "작업 중" })).toBeTruthy();
  });

  it("state null(비활성·보관)·모르는 줄이면 그리지 않는다", () => {
    const { container } = render(
      <>
        <PresenceDot entry={{ kind: "user", id: A, state: null }} />
        <PresenceDot entry={undefined} />
      </>,
    );
    expect(container.innerHTML).toBe("");
  });

  it("본인이 오프라인으로 보이기면 「오프라인으로 보이기」", () => {
    render(<PresenceDot entry={{ kind: "user", id: A, state: "offline" }} selfInvisible />);
    expect(screen.getByRole("img", { name: "오프라인으로 보이기" })).toBeTruthy();
  });
});

describe("아바타 점", () => {
  const wrap = (ui: React.ReactNode) =>
    render(<QueryClientProvider client={createQueryClient(() => undefined)}>{ui}</QueryClientProvider>);

  it("작성자 아바타에 그 사람의 점", () => {
    usePresenceStore.getState().applySnapshot([{ kind: "user", id: A, state: "online" }]);
    wrap(<AuthorAvatar author={{ name: "에이", isAgent: false, ref: { kind: "user", id: A } }} />);
    expect(screen.getByRole("img", { name: "접속 중" })).toBeTruthy();
  });

  it("누구인지 모르는 작성자(시스템)는 점이 없다", () => {
    usePresenceStore.getState().applySnapshot([{ kind: "user", id: A, state: "online" }]);
    wrap(<AuthorAvatar author={{ name: "시스템", isAgent: false }} />);
    expect(screen.queryByRole("img")).toBeNull();
  });
});

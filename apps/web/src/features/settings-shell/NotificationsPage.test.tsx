import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { captureInstallPrompt } from "@/pwa/install";
import { stubNotification } from "../../../test/domStubs";
import { VAPID_KEY, fakeSubscription, pushStub, stubPush } from "../../../test/pushStubs";
import { ME, json, renderRoute, shellGet } from "../../../test/shellApi";
import { NotificationsPage } from "./NotificationsPage";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

let push: ReturnType<typeof stubPush> | undefined;
let notification: ReturnType<typeof stubNotification> | undefined;
let requests: string[];
let postAnswer: () => Response;

beforeEach(() => {
  requests = [];
  postAnswer = () => new Response(null, { status: 204 });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url}`);
      if (url === "/api/v1/push/vapid-public-key") return json(200, { publicKey: VAPID_KEY });
      if (url === "/api/v1/push/subscriptions")
        return method === "POST" ? postAnswer() : new Response(null, { status: 204 });
      return json(404, { code: "NOT_FOUND", message: "x" });
    }),
  );
});
afterEach(() => {
  push?.restore();
  push = undefined;
  notification?.restore();
  notification = undefined;
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 알림 탭을 그리고 그 페이지를 돌려준다 — 이 기기 구독은 탭에 들어올 때 확인한다 */
function renderPanel() {
  const qc = createQueryClient(() => {});
  qc.setQueryData(qk.me, ME);
  render(
    <QueryClientProvider client={qc}>
      <NotificationsPage />
    </QueryClientProvider>,
  );
  return screen.getByTestId("page-notifications");
}

describe("상태 다섯(스펙 6장)", () => {
  it("꺼짐 → 「푸시 알림 켜기」 → 진행 중 비활성 → 켜짐 「이 기기에서 알림을 받습니다」", async () => {
    push = stubPush({ permission: "default" });
    push.notification.answer("granted");
    const panel = renderPanel();

    const on = await within(panel).findByRole("button", { name: "푸시 알림 켜기" });
    await userEvent.click(on);

    expect(await within(panel).findByText("이 기기에서 알림을 받습니다")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "끄기" })).toBeEnabled();
    expect(requests).toContain("POST /api/v1/push/subscriptions");
    expect(localStorage.getItem("dodok.push")).toBe(ME.user.id);
  });

  it("켜는 동안 버튼은 비활성이고 진행 글이 보인다", async () => {
    push = stubPush({ permission: "granted" });
    let release: () => void = () => {};
    postAnswer = () => new Response(null, { status: 204 });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/push/vapid-public-key") return json(200, { publicKey: VAPID_KEY });
      if (init?.method === "POST")
        await new Promise<void>((r) => {
          release = r;
        });
      return new Response(null, { status: 204 });
    });
    const panel = renderPanel();
    await userEvent.click(await within(panel).findByRole("button", { name: "푸시 알림 켜기" }));
    expect(await within(panel).findByText("켜는 중…")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "푸시 알림 켜기" })).toBeDisabled();
    act(() => release());
    expect(await within(panel).findByText("이 기기에서 알림을 받습니다")).toBeInTheDocument();
  });

  it("켜기가 실패하면 이유를 패널 안에 쓴다(role=alert) — 꺼짐 그대로, 기기 구독도 없다", async () => {
    push = stubPush({ permission: "granted" });
    postAnswer = () => json(500, { code: "INTERNAL", message: "서버 내부 오류" });
    const panel = renderPanel();
    await userEvent.click(await within(panel).findByRole("button", { name: "푸시 알림 켜기" }));

    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "구독을 등록하지 못했습니다 — 서버 내부 오류",
    );
    expect(within(panel).getByRole("button", { name: "푸시 알림 켜기" })).toBeEnabled();
    expect(pushStub.current).toBeNull();
  });

  it("켜짐 → 「끄기」 → 꺼짐, 서버·기기 모두 해지", async () => {
    const sub = fakeSubscription();
    push = stubPush({ permission: "granted", subscription: sub });
    localStorage.setItem("dodok.push", ME.user.id);
    const panel = renderPanel();
    await userEvent.click(await within(panel).findByRole("button", { name: "끄기" }));

    expect(await within(panel).findByRole("button", { name: "푸시 알림 켜기" })).toBeInTheDocument();
    expect(requests).toContain("DELETE /api/v1/push/subscriptions");
    expect(sub.unsubscribed).toBe(true);
    expect(localStorage.getItem("dodok.push")).toBeNull();
  });

  it("거절됨 — 브라우저 설정 안내, 켜기 버튼 없음", async () => {
    push = stubPush({ permission: "denied" });
    const panel = renderPanel();
    expect(await within(panel).findByText("브라우저 설정에서 알림을 허용해 주세요")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "푸시 알림 켜기" })).not.toBeInTheDocument();
  });

  it("켜기에서 권한을 거절하면 거절됨으로 바뀌고 안내 문장은 한 번만 보인다", async () => {
    push = stubPush({ permission: "default" });
    push.notification.answer("denied");
    const panel = renderPanel();
    await userEvent.click(await within(panel).findByRole("button", { name: "푸시 알림 켜기" }));

    await waitFor(() =>
      expect(within(panel).queryByRole("button", { name: "푸시 알림 켜기" })).not.toBeInTheDocument(),
    );
    expect(within(panel).getAllByText("브라우저 설정에서 알림을 허용해 주세요")).toHaveLength(1);
    expect(within(panel).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("끄는 동안 「끄기」는 비활성이고 진행 글이 보인다", async () => {
    const sub = fakeSubscription();
    push = stubPush({ permission: "granted", subscription: sub });
    localStorage.setItem("dodok.push", ME.user.id);
    let release: () => void = () => {};
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      if (init?.method === "DELETE")
        await new Promise<void>((r) => {
          release = r;
        });
      return new Response(null, { status: 204 });
    });
    const panel = renderPanel();
    await userEvent.click(await within(panel).findByRole("button", { name: "끄기" }));
    expect(await within(panel).findByText("끄는 중…")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "끄기" })).toBeDisabled();

    act(() => release());
    expect(await within(panel).findByRole("button", { name: "푸시 알림 켜기" })).toBeInTheDocument();
  });

  it("설치 필요(iOS, 홈 화면 앱 아님) — 홈 화면에 추가 안내", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE);
    notification = stubNotification("default");
    const panel = renderPanel();
    expect(
      await within(panel).findByText("홈 화면에 추가하면 알림을 받을 수 있습니다 — 공유 → 홈 화면에 추가"),
    ).toBeInTheDocument();
    // iOS 에서는 탭 안 알림 버튼도 내지 않는다 — 설치해야 알림이 된다
    expect(within(panel).queryByRole("button")).toBeNull();
  });

  it("미지원 — 문구만, Notification 도 없으면 버튼이 없다", async () => {
    const panel = renderPanel();
    expect(await within(panel).findByText("이 브라우저는 푸시 알림을 지원하지 않습니다")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /알림 켜기/ })).not.toBeInTheDocument();
  });
});

describe("푸시 미지원 브라우저의 탭 안 알림(옛 「알림 켜기」)", () => {
  it("Notification 이 있고 아직 묻지 않았으면 「탭이 열려 있을 때만 알림 켜기」 — 누를 때만 묻고, 켜지면 사라진다", async () => {
    notification = stubNotification("default");
    notification.answer("granted");
    const panel = renderPanel();
    const button = await within(panel).findByRole("button", { name: "탭이 열려 있을 때만 알림 켜기" });
    expect(notification.asked()).toBe(0);
    await userEvent.click(button);
    await waitFor(() =>
      expect(
        within(panel).queryByRole("button", { name: "탭이 열려 있을 때만 알림 켜기" }),
      ).not.toBeInTheDocument(),
    );
    expect(notification.asked()).toBe(1);
  });

  it("사용자가 물음을 닫으면(default 그대로) 버튼이 남는다", async () => {
    notification = stubNotification("default");
    const panel = renderPanel();
    await userEvent.click(
      await within(panel).findByRole("button", { name: "탭이 열려 있을 때만 알림 켜기" }),
    );
    expect(await within(panel).findByRole("button", { name: "탭이 열려 있을 때만 알림 켜기" })).toBeEnabled();
    expect(notification.asked()).toBe(1);
  });

  it("이미 허용했거나 거부했으면 버튼이 없다 — 다시 묻지 않는다", async () => {
    for (const permission of ["granted", "denied"] as const) {
      notification?.restore();
      notification = stubNotification(permission);
      const panel = renderPanel();
      expect(
        await within(panel).findByText("이 브라우저는 푸시 알림을 지원하지 않습니다"),
      ).toBeInTheDocument();
      expect(within(panel).queryByRole("button", { name: /탭이 열려/ })).not.toBeInTheDocument();
      cleanup();
    }
  });
});

it("설치 이벤트를 받았으면 「앱 설치」", async () => {
  push = stubPush({ permission: "granted" });
  captureInstallPrompt();
  const prompt = vi.fn(async () => {});
  const panel = renderPanel();
  act(
    () =>
      void window.dispatchEvent(
        Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
          prompt,
          userChoice: Promise.resolve({ outcome: "accepted" as const }),
        }),
      ),
  );
  await userEvent.click(await within(panel).findByRole("button", { name: "앱 설치" }));
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(within(panel).queryByRole("button", { name: "앱 설치" })).not.toBeInTheDocument();
});

it("설정의 「알림」 탭 — /settings/notifications", async () => {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (String(input) === "/api/v1/auth/me") return json(200, ME);
    return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
  });
  renderRoute("/settings/agents");
  const tabs = await screen.findByRole("navigation", { name: "설정" });
  await userEvent.click(within(tabs).getByRole("link", { name: "알림" }));
  const page = await screen.findByTestId("page-notifications");
  expect(within(page).getByRole("heading", { level: 1, name: "알림" })).toBeInTheDocument();
});

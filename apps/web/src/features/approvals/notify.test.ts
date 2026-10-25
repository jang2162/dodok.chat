import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubNotification } from "../../../test/domStubs";
import { APPROVAL2, CH, CH2, approval, uid } from "../../../test/fixtures";
import {
  approvalNotifyTitle,
  forgetApproval,
  notifyApproval,
  notifyPermission,
  requestNotifyPermission,
  resetApprovalNotices,
} from "./notify";

const noop = () => {};
/** 다른 채널을 보고 있는, 알림이 떠야 하는 상황 */
const away = (over: Partial<Parameters<typeof notifyApproval>[1]> = {}) => ({
  visible: true,
  currentConversationId: CH2,
  onClick: noop,
  handle: "dev",
  ...over,
});

let stub: ReturnType<typeof stubNotification> | undefined;
const notifications = (permission: NotificationPermission = "granted") => {
  stub = stubNotification(permission);
  return stub;
};

beforeEach(() => {
  resetApprovalNotices();
});
afterEach(() => {
  stub?.restore();
  stub = undefined;
  vi.restoreAllMocks();
});

it("권한이 granted 이고 다른 채널을 보고 있으면 띄운다", () => {
  const { made } = notifications("granted");
  expect(notifyApproval(approval({ toolName: "Write" }), away())).toBe(true);
  expect(made).toHaveLength(1);
  expect(made[0]?.title).toBe("승인 필요 — @dev 가 Write 를 실행하려 합니다");
});

it("[결정 8] 이 기기에 푸시가 켜져 있으면 탭 안 알림은 쉰다 — 같은 승인이 두 번 울리지 않게", () => {
  const { made } = notifications("granted");
  localStorage.setItem("dodok.push", "u1");
  try {
    expect(notifyApproval(approval(), away())).toBe(false);
    expect(made).toHaveLength(0);
  } finally {
    localStorage.removeItem("dodok.push");
  }
  // 푸시를 끄면 다시 탭 안 알림
  expect(notifyApproval(approval(), away())).toBe(true);
});

it("같은 세션을 보고 있고 탭이 보이면 띄우지 않는다", () => {
  const { made } = notifications("granted");
  expect(notifyApproval(approval(), away({ currentConversationId: CH }))).toBe(false);
  expect(made).toHaveLength(0);
});

it("같은 채널의 다른 세션을 보고 있으면 띄운다 — 카드는 그 승인의 세션에만 보인다(채널 세션 계획 판정 PS7)", () => {
  const { made } = notifications("granted");
  expect(notifyApproval(approval(), away({ currentConversationId: uid(77) }))).toBe(true);
  expect(made).toHaveLength(1);
});

it("탭이 숨겨져 있으면 같은 세션이어도 띄운다", () => {
  const { made } = notifications("granted");
  expect(notifyApproval(approval(), away({ visible: false, currentConversationId: CH }))).toBe(true);
  expect(made).toHaveLength(1);
});

it("권한이 default·denied·미지원이면 띄우지 않고 던지지 않는다", () => {
  for (const permission of ["default", "denied"] as const) {
    stub?.restore();
    const { made } = notifications(permission);
    expect(notifyApproval(approval(), away())).toBe(false);
    expect(made).toHaveLength(0);
    expect(notifyPermission()).toBe(permission);
  }
  // 미지원 — 스텁을 벗기면 jsdom 에는 Notification 이 없다
  stub?.restore();
  stub = undefined;
  expect(notifyPermission()).toBe("unsupported");
  expect(notifyApproval(approval(), away())).toBe(false);
});

it("알림을 누르면 콜백이 불린다 — 창을 앞으로 내고 알림을 닫는다", () => {
  const focus = vi.spyOn(window, "focus").mockImplementation(noop);
  const onClick = vi.fn();
  const { made } = notifications("granted");
  expect(notifyApproval(approval(), away({ onClick }))).toBe(true);

  made[0]?.click();
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(focus).toHaveBeenCalledTimes(1);
  expect(made[0]?.closed).toBe(true);
});

/**
 * 어댑터가 전역 프레임과 세션 프레임을 병합해 **다시 발행**한다(p2-t6 Ruling C) — 같은 승인이 두 번 온다.
 * `tag` 는 알림이 쌓이는 것만 막고 브라우저에 따라 다시 울리므로, 만들기 전에 id 로 거른다
 */
it("같은 승인이 두 번 들어와도 한 번만 울린다", () => {
  const { made } = notifications("granted");
  expect(notifyApproval(approval({ toolCallId: undefined }), away())).toBe(true);
  expect(notifyApproval(approval({ toolCallId: "toolu_9" }), away())).toBe(false);
  expect(made).toHaveLength(1);
  // 다른 승인은 막히지 않는다
  expect(notifyApproval(approval({ id: APPROVAL2 }), away())).toBe(true);
  expect(made).toHaveLength(2);
});

it("확정된 승인은 잊는다 — 집합이 끝없이 자라지 않게", () => {
  const { made } = notifications("granted");
  expect(notifyApproval(approval(), away())).toBe(true);
  forgetApproval(approval().id);
  // 잊은 뒤에 같은 id 가 다시 오면 막지 않는다(승인 id 는 재사용되지 않으므로 실제로는 오지 않는다)
  expect(notifyApproval(approval(), away())).toBe(true);
  expect(made).toHaveLength(2);
});

it("알림에 인자·설명을 싣지 않는다 — 잠금 화면에도 뜬다", () => {
  const { made } = notifications("granted");
  notifyApproval(
    approval({ description: '{"file_path":"/비밀/키.txt"}', detail: "비밀값", title: "비밀 제목" }),
    away({ channelName: "일반" }),
  );
  const text = `${made[0]?.title} ${made[0]?.options?.body ?? ""}`;
  expect(text).not.toContain("비밀");
  expect(text).toContain("일반"); // 채널 이름까지만
});

it("핸들·툴 이름을 모르면 조사까지 맞춘 일반 문구", () => {
  expect(approvalNotifyTitle({ toolName: undefined }, undefined)).toBe(
    "승인 필요 — 에이전트가 도구를 실행하려 합니다",
  );
  expect(approvalNotifyTitle({ toolName: "Bash" }, "fin")).toBe(
    "승인 필요 — @fin 이 Bash 를 실행하려 합니다",
  );
});

it("같은 승인은 알림 tag 가 같다 — 쌓이지 않는다", () => {
  const { made } = notifications("granted");
  notifyApproval(approval(), away());
  expect(made[0]?.options?.tag).toBe(`approval:${approval().id}`);
});

it("권한 요청은 부를 때만 하고, 답한 권한을 돌려준다", async () => {
  const s = notifications("default");
  s.answer("granted");
  expect(s.asked()).toBe(0); // 아무도 안 눌렀다
  expect(await requestNotifyPermission()).toBe("granted");
  expect(s.asked()).toBe(1);
  expect(notifyPermission()).toBe("granted");
});

it("미지원이면 권한을 요청하지 않는다", async () => {
  expect(await requestNotifyPermission()).toBe("unsupported");
});

it("생성자가 막힌 브라우저에서도 앱이 멈추지 않는다 — 모바일 크롬", () => {
  const g = globalThis as Record<string, unknown>;
  class Blocked {
    static permission: NotificationPermission = "granted";
    static async requestPermission(): Promise<NotificationPermission> {
      return "granted";
    }
    constructor() {
      throw new TypeError("Failed to construct 'Notification'");
    }
  }
  g.Notification = Blocked;
  try {
    expect(notifyApproval(approval(), away())).toBe(false);
  } finally {
    delete g.Notification;
  }
});

it("알림 스텁은 벗기면 원래대로 — 다른 테스트 파일이 순서를 타지 않는다", () => {
  expect(Object.hasOwn(globalThis, "Notification")).toBe(false);
  const s = stubNotification("granted");
  expect(Object.hasOwn(globalThis, "Notification")).toBe(true);
  s.restore();
  expect(Object.hasOwn(globalThis, "Notification")).toBe(false);
});

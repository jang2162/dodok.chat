import type { Approval } from "@dodok/shared";
import { josa } from "@/lib/josa";
import { pushOnThisDevice } from "@/pwa/push";

/** 「미지원」은 브라우저에 `Notification` 이 없는 것 — 권한 셋과 같은 자리에서 가른다(설계 5.4) */
export type NotifyPermission = "unsupported" | "default" | "granted" | "denied";

/** 승인 알림이 쓰는 바깥 사정. 라우터·스토어를 여기로 들이지 않는다 — 부르는 쪽이 넘긴다 */
export type NotifyContext = {
  /** 탭이 보이는가(`document.visibilityState === "visible"`) */
  visible: boolean;
  /** 지금 보고 있는 채널 — 같은 채널을 보고 있으면 알리지 않는다 */
  currentChannelId?: string;
  /** 알림을 눌렀을 때 — 그 채널의 활동 탭으로 */
  onClick(): void;
  /** 에이전트 핸들(`@` 없이). 모르면 「에이전트」 */
  handle?: string;
  /** 채널 이름 — 본문 한 줄 */
  channelName?: string;
};

/** 전역이 없는 환경(jsdom·구형 브라우저)에서도 던지지 않게 이름으로 확인한다 */
const api = (): typeof Notification | undefined =>
  "Notification" in globalThis ? globalThis.Notification : undefined;

export function notifyPermission(): NotifyPermission {
  const N = api();
  if (!N || typeof N.requestPermission !== "function") return "unsupported";
  return N.permission === "granted" || N.permission === "denied" ? N.permission : "default";
}

/**
 * 권한을 묻는다 — **사용자가 「알림 켜기」를 눌렀을 때만** 부른다(스스로 묻는 앱은 브라우저가 벌준다).
 * 옛 Safari 의 콜백형은 Promise 를 돌려주지 않으므로 결과는 `Notification.permission` 으로 다시 읽는다
 */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  const N = api();
  if (notifyPermission() === "unsupported" || !N) return "unsupported";
  try {
    await N.requestPermission();
  } catch {
    // 거절·미지원 모두 아래에서 지금 권한으로 답한다
  }
  return notifyPermission();
}

/**
 * 이미 알린 승인 id. 어댑터가 전역·세션 프레임을 병합해 **다시 발행**하므로 같은 승인이 두 번 온다(p2-t6 Ruling C).
 * `tag` 는 알림이 쌓이는 것만 막고 브라우저에 따라 다시 울리므로, 만들기 전에 여기서 거른다.
 * 확정되면 지운다 — 새로고침·채널 이동으로 사라져도 되는, 자라지 않게 하는 것이 목적인 집합이다
 */
const notified = new Set<string>();

/** 승인이 확정되면 잊는다(`approval.resolved`) */
export const forgetApproval = (approvalId: string): void => void notified.delete(approvalId);

/** 로그아웃·테스트에서 처음 상태로 */
export const resetApprovalNotices = (): void => notified.clear();

/**
 * 알림 문구. 사용자·에이전트가 넣은 값(제목·설명·인자)은 **싣지 않는다** — 알림은 잠금 화면에도 뜬다.
 * 조사는 앞말의 받침을 따른다(`@dev 가` · `@fin 이`). 로마자 낱말과 조사 사이는 띄운다 —
 * 모르는 자리를 메운 우리말(「에이전트」·「도구」)은 붙여 쓴다
 */
export function approvalNotifyTitle(a: Pick<Approval, "toolName">, handle?: string): string {
  const who = handle ? `@${handle} ${josa(`@${handle}`, "이", "가")}` : "에이전트가";
  const what = a.toolName ? `${a.toolName} ${josa(a.toolName, "을", "를")}` : "도구를";
  return `승인 필요 — ${who} ${what} 실행하려 합니다`;
}

/**
 * 승인 요구 알림(설계 5.4). 같은 채널을 보고 있고 탭이 보이면 띄우지 않는다 — 카드가 이미 화면에 있다.
 * 권한이 `granted` 가 아니면 조용히 넘어간다(카드가 정본이라 앱은 그대로 돈다). 띄웠으면 `true`.
 * 이 기기에 푸시가 켜져 있으면 쉰다 — 서버 푸시가 같은 승인을 알린다(스펙 결정 8)
 */
export function notifyApproval(a: Approval, ctx: NotifyContext): boolean {
  if (notified.has(a.id)) return false;
  if (pushOnThisDevice()) return false;
  if (ctx.visible && ctx.currentChannelId === a.channelId) return false;
  const N = api();
  if (!N || notifyPermission() !== "granted") return false;

  let made: Notification;
  try {
    made = new N(approvalNotifyTitle(a, ctx.handle), {
      tag: `approval:${a.id}`,
      ...(ctx.channelName ? { body: `${ctx.channelName} 채널` } : {}),
    });
  } catch {
    // 모바일 크롬은 서비스 워커 밖의 생성자를 막는다(웹 푸시를 켜면 그쪽이 알린다)
    return false;
  }
  notified.add(a.id);
  made.onclick = () => {
    window.focus();
    made.close();
    ctx.onClick();
  };
  return true;
}

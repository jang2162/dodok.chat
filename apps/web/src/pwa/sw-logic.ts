import { PushPayload } from "@dodok/shared";

// 서비스 워커(WebWorker)와 앱(DOM)이 함께 쓰는 순수 함수 — 어느 한쪽 전역(self·window·document)도 쓰지 않는다

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
/**
 * 알림이 열 수 있는 자리 — 같은 출처 상대 경로 `/c/<uuid>`·`/c/<uuid>/activity`·`/c/<uuid>/t/<uuid>`(스레드) 뿐
 * (스펙 3장, 스레드·검색 스펙 4.2)
 */
const SAFE_URL = new RegExp(`^/c/${UUID}(?:/activity|/t/${UUID})?$`);

/** 알림 누르기가 갈 곳. 위 세 꼴이 아니면(다른 출처·`//`·`..`·쿼리·다른 값) 모두 `/` */
export function safeNotificationUrl(url: unknown): string {
  return typeof url === "string" && SAFE_URL.test(url) ? url : "/";
}

/**
 * SPA 탐색 폴백(index.html)에서 뺄 경로 — /api·/socket.io 는 네트워크만(스펙 3장). /llms.txt 는 서버가 내는 노드 설치 안내서라
 * 사람이 주소창으로 열어도 서버까지 가야 한다. workbox 는 `pathname + search` 에 맞춰 보므로 끝은 `$` 가 아니라 쿼리까지 받는다
 */
export const NAVIGATION_DENYLIST: RegExp[] = [/^\/api\//, /^\/socket\.io\//, /^\/llms\.txt(\?|$)/];

export type PushNotification = {
  title: string;
  options: { body: string; tag?: string; data: { url: string }; renotify?: boolean };
};

const fallback = (): PushNotification => ({
  title: "dodok — 새 알림",
  options: { body: "", data: { url: "/" } },
});

/**
 * 푸시 페이로드 → 알림(스펙 3장). 파싱이 안 되면 「dodok — 새 알림」을 띄운다 — 받은 푸시마다 무엇이든 띄워야 한다(결정 2).
 * 승인만 같은 tag 로 다시 울린다. `renotify` 는 tag 없이 쓰면 `showNotification` 이 던지므로 tag 가 있을 때만
 */
export function notificationFromPush(data: unknown): PushNotification {
  const parsed = PushPayload.safeParse(data);
  if (!parsed.success) return fallback();
  const p = parsed.data;
  const options: PushNotification["options"] = { body: p.body, data: { url: safeNotificationUrl(p.url) } };
  if (p.tag) {
    options.tag = p.tag;
    if (p.kind === "approval") options.renotify = true;
  }
  return { title: p.title, options };
}

export type ClientInfo = {
  url: string;
  visibilityState: "visible" | "hidden" | "prerender";
  focused: boolean;
};

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/**
 * 알림을 누르면 앞으로 올 창(Review Focus 4). 같은 출처 창 가운데 보이면서 포커스 → 보이는 → 포커스 → 첫 창
 * (`clients.matchAll` 은 최근에 포커스된 순으로 준다). 없으면 -1 — 새 창을 연다
 */
export function pickClient(clients: ReadonlyArray<ClientInfo>, origin: string): number {
  const same = clients.map((c, i) => ({ c, i })).filter(({ c }) => originOf(c.url) === origin);
  const pick =
    same.find(({ c }) => c.visibilityState === "visible" && c.focused) ??
    same.find(({ c }) => c.visibilityState === "visible") ??
    same.find(({ c }) => c.focused) ??
    same[0];
  return pick ? pick.i : -1;
}

/**
 * 고른 창을 앞으로 가져오고 그 자리로 옮긴다(라우터 이동 — 앱의 `navigate` 메시지). focus 가 거절돼도(사용자 활성화가
 * 없거나 창·OS 가 막는다) 이동은 보낸다 — 알림은 이미 닫혔으니 여기서 멈추면 아무 일도 일어나지 않는다(p4t-c1)
 */
export async function focusAndNavigate(
  client: { focus(): Promise<unknown>; postMessage(message: unknown): void },
  url: string,
): Promise<void> {
  try {
    await client.focus();
  } catch {
    // 이동만으로도 그 창이 그 자리를 보인다
  }
  client.postMessage({ type: "navigate", url });
}

/** VAPID 공개키(base64url, 패딩 없음) → `applicationServerKey` 바이트 */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

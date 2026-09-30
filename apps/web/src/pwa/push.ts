import { ApiRequestError, NetworkError, api } from "@/api/http";
import { isIos, isStandalone } from "./install";
import { urlBase64ToUint8Array } from "./sw-logic";

/** 이 기기의 푸시 상태(스펙 6장 표) */
export type PushState = "unsupported" | "install-needed" | "denied" | "off" | "on";
export type PushEnv = { ios: boolean; standalone: boolean; supported: boolean };
export type EnableResult = { ok: true } | { ok: false; reason: string };

/**
 * 이 기기에서 푸시를 켠 **사용자 id**. 값이 있으면 이 기기에 푸시가 켜져 있다(탭 안 승인 알림은 쉰다 — 결정 8).
 * `"1"` 이 아니라 사용자 id 인 것은 앱을 열 때 다른 사람이 켠 구독을 이어 등록하지 않기 위해서다(Review Focus 1)
 */
const FLAG = "dodok.push";
const READY_TIMEOUT_MS = 10_000;

function readFlag(): string | null {
  try {
    return localStorage.getItem(FLAG);
  } catch {
    return null;
  }
}
function writeFlag(userId: string | null): void {
  try {
    if (userId === null) localStorage.removeItem(FLAG);
    else localStorage.setItem(FLAG, userId);
  } catch {
    // 저장소가 없으면 플래그 없이 돈다 — 탭 안 알림이 푸시와 겹칠 수 있을 뿐이다
  }
}

/** 이 기기에 푸시가 켜져 있는가(localStorage 플래그). 저장소가 던지면 false */
export const pushOnThisDevice = (): boolean => readFlag() !== null;

export function detectPushEnv(): PushEnv {
  const supported =
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    navigator.serviceWorker !== undefined &&
    "PushManager" in globalThis &&
    "Notification" in globalThis;
  return { ios: isIos(), standalone: isStandalone(), supported };
}

export function pushStateOf(
  env: PushEnv,
  permission: NotificationPermission | "unsupported",
  subscribed: boolean,
): PushState {
  if (env.ios && !env.standalone) return "install-needed";
  if (!env.supported || permission === "unsupported") return "unsupported";
  if (permission === "denied") return "denied";
  return subscribed ? "on" : "off";
}

/**
 * 알림 권한 — `features/approvals/notify.ts` 의 것과 같은 판정이지만 그쪽이 이 파일(`pushOnThisDevice`)을 쓰므로
 * 순환을 피해 여기 둔다. 옛 Safari 의 콜백형은 Promise 를 돌려주지 않으므로 결과는 `permission` 으로 다시 읽는다
 */
export function pushPermission(): NotificationPermission | "unsupported" {
  const N = "Notification" in globalThis ? globalThis.Notification : undefined;
  return N && typeof N.requestPermission === "function" ? N.permission : "unsupported";
}
async function requestPermission(): Promise<NotificationPermission | "unsupported"> {
  if (pushPermission() === "unsupported") return "unsupported";
  try {
    await Notification.requestPermission();
  } catch {
    // 아래에서 지금 권한으로 답한다
  }
  return pushPermission();
}

/** 이 기기의 구독 — 서비스 워커가 아직 없으면 null(기다리지 않는다) */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!detectPushEnv().supported) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/** 새로 구독하려면 활성 워커가 있어야 한다 — 등록이 안 됐으면(개발 모드 SW 꺼짐 등) 끝없이 기다리지 않는다 */
async function readyRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), READY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const view = new Uint8Array(a);
  return view.every((x, i) => x === b[i]);
}

/** 서버·네트워크 오류는 그 문구(한국어), 그 밖은 부른 쪽 문구 */
const reasonOf = (e: unknown, fallback: string): string =>
  e instanceof ApiRequestError || e instanceof NetworkError ? e.message : fallback;

async function serverKey(): Promise<Uint8Array<ArrayBuffer>> {
  const { publicKey } = await api<{ publicKey: string }>("GET", "/push/vapid-public-key");
  return urlBase64ToUint8Array(publicKey);
}

const register = (sub: PushSubscription) => api<void>("POST", "/push/subscriptions", sub.toJSON());

/**
 * 「푸시 알림 켜기」(스펙 6장) — 사용자가 누를 때만 부른다. 권한 → 공개키 → 구독(`userVisibleOnly`) → 서버 등록.
 * 등록이 실패하면 기기 구독을 해지한다 — 서버가 모르는 구독을 남기지 않는다(스펙 7장)
 */
export async function enablePush(userId: string): Promise<EnableResult> {
  const env = detectPushEnv();
  const state = pushStateOf(env, pushPermission(), false);
  if (state === "install-needed")
    return { ok: false, reason: "홈 화면에 추가한 앱에서만 알림을 받을 수 있습니다" };
  if (state === "unsupported") return { ok: false, reason: "이 브라우저는 푸시 알림을 지원하지 않습니다" };

  const permission = await requestPermission();
  if (permission === "denied") return { ok: false, reason: "브라우저 설정에서 알림을 허용해 주세요" };
  if (permission !== "granted") return { ok: false, reason: "알림 권한을 허용해야 켤 수 있습니다" };

  const reg = await readyRegistration().catch(() => undefined);
  if (!reg)
    return { ok: false, reason: "서비스 워커가 준비되지 않았습니다 — 새로고침한 뒤 다시 시도해 주세요" };

  let key: Uint8Array<ArrayBuffer>;
  try {
    key = await serverKey();
  } catch (e) {
    return { ok: false, reason: reasonOf(e, "서버에서 푸시 키를 받지 못했습니다") };
  }

  let sub: PushSubscription;
  try {
    // 다른 키로 만든 구독이 남아 있으면 subscribe 가 던진다 — 먼저 걷는다
    const existing = await reg.pushManager.getSubscription();
    const reuse = existing && sameKey(existing.options.applicationServerKey, key) ? existing : null;
    if (existing && !reuse) await existing.unsubscribe();
    sub = reuse ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  } catch {
    return { ok: false, reason: "푸시 구독을 만들지 못했습니다" };
  }

  try {
    await register(sub);
  } catch (e) {
    await sub.unsubscribe().catch(() => false);
    writeFlag(null);
    return { ok: false, reason: `구독을 등록하지 못했습니다 — ${reasonOf(e, "잠시 뒤 다시 시도해 주세요")}` };
  }
  writeFlag(userId);
  return { ok: true };
}

/**
 * 「끄기」와 로그아웃(스펙 6장·Review Focus 1). 세션이 있을 때 부른다 — 서버 해지(DELETE)에 세션이 필요하다.
 * 서버 해지가 실패해도 기기 구독은 해지한다(해지된 endpoint 는 다음 발송이 404·410 으로 정리한다). 던지지 않는다
 */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (sub) {
    await api<void>("DELETE", "/push/subscriptions", { endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe().catch(() => false);
  }
  writeFlag(null);
}

/**
 * 세션이 이미 없을 때(401) — 서버에 물을 수 없으니 기기 구독만 해지한다. 서버 행은 그 세션이 지워지거나
 * 만료되면 서버가 지우고(구독은 등록한 세션에 묶인다), 그 전에는 다음 발송의 404·410 이 지운다. 해지된
 * endpoint 로는 아무것도 오지 않는다
 */
export async function dropLocalPush(): Promise<void> {
  const sub = await currentSubscription();
  await sub?.unsubscribe().catch(() => false);
  writeFlag(null);
}

/**
 * 앱을 열 때(로그인 상태) 한 번(스펙 5.1 동기화). 이 사람이 켠 구독이면 다시 등록하고, 서버 키가 바뀌었으면
 * 해지 후 새로 구독한다. 다른 사람(또는 누가 켰는지 모르는) 구독은 이어 쓰지 않고 해지한다. 던지지 않는다
 */
export async function syncPushSubscription(userId: string): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) {
    if (readFlag() !== null) writeFlag(null);
    return;
  }
  if (readFlag() !== userId) {
    await sub.unsubscribe().catch(() => false);
    writeFlag(null);
    return;
  }
  let dropped = false;
  try {
    const key = await serverKey();
    if (sameKey(sub.options.applicationServerKey, key)) {
      await register(sub);
      return;
    }
    dropped = await sub.unsubscribe();
    const reg = await readyRegistration();
    if (!reg) throw new Error("service worker not ready");
    await register(await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  } catch {
    // 네트워크·서버 실패는 다음에 앱을 열 때 다시 — 구독이 남아 있으면 플래그도 그대로 둔다
    if (dropped && (await currentSubscription()) === null) writeFlag(null);
  }
}

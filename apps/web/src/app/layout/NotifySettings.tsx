import { BellIcon, DownloadIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMe } from "@/api/queries";
import {
  type NotifyPermission,
  notifyPermission,
  requestNotifyPermission,
} from "@/features/approvals/notify";
import { useInstallPrompt } from "@/pwa/install";
import {
  currentSubscription,
  detectPushEnv,
  disablePush,
  enablePush,
  pushPermission,
  pushStateOf,
} from "@/pwa/push";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";

/** 상태별 안내 한 줄(스펙 6장 표). 꺼짐은 버튼이 곧 안내다 */
const MESSAGE = {
  unsupported: "이 브라우저는 푸시 알림을 지원하지 않습니다",
  "install-needed": "홈 화면에 추가하면 알림을 받을 수 있습니다 — 공유 → 홈 화면에 추가",
  denied: "브라우저 설정에서 알림을 허용해 주세요",
  off: "멘션·승인 요청·에이전트 대화 한도를 이 기기로 알립니다",
  on: "이 기기에서 알림을 받습니다",
} as const;

/**
 * 사이드바 하단 「알림」(스펙 6장) — 옛 「알림 켜기」 자리. 누르면 작은 패널: 이 기기의 푸시 상태 다섯·켜기·끄기·
 * iOS 안내·「앱 설치」. 권한은 켜기를 누를 때만 묻는다. 푸시가 없는 브라우저(iOS 아님)에서 `Notification` 이 있으면
 * 옛 동작 「탭이 열려 있을 때만 알림 켜기」를 남긴다. 켜고 끄는 동안은 닫지 않는다 — 결과(이유)를 잃지 않게
 */
export function NotifySettings() {
  const me = useMe();
  const userId = me.data?.user.id;
  const env = useMemo(detectPushEnv, []);
  const install = useInstallPrompt();
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState(pushPermission);
  const [tabPermission, setTabPermission] = useState<NotifyPermission>(notifyPermission);
  /** 이 기기 구독이 있는가 — 패널을 열 때 확인한다. 모르면 undefined */
  const [subscribed, setSubscribed] = useState<boolean>();
  const [busy, setBusy] = useState<"on" | "off" | "tab">();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    let live = true;
    setPermission(pushPermission());
    setTabPermission(notifyPermission());
    void currentSubscription().then((sub) => {
      if (live) setSubscribed(sub !== null);
    });
    return () => {
      live = false;
    };
  }, [open]);

  const state = pushStateOf(env, permission, subscribed ?? false);
  const checking = subscribed === undefined && (state === "off" || state === "on");

  async function turnOn() {
    if (!userId) return;
    setBusy("on");
    setError(undefined);
    const r = await enablePush(userId);
    setPermission(pushPermission());
    if (r.ok) setSubscribed(true);
    else {
      setError(r.reason);
      setSubscribed((await currentSubscription()) !== null);
    }
    setBusy(undefined);
  }

  async function turnOff() {
    setBusy("off");
    setError(undefined);
    await disablePush();
    setSubscribed((await currentSubscription()) !== null);
    setBusy(undefined);
  }

  async function allowTab() {
    setBusy("tab");
    setTabPermission(await requestNotifyPermission());
    setBusy(undefined);
  }

  function onOpenChange(next: boolean) {
    if (!next && busy) return;
    setOpen(next);
    if (!next) setError(undefined);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start px-2 font-normal text-muted-foreground"
        >
          <BellIcon className="size-4 shrink-0 opacity-70" aria-hidden />
          알림
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm" closeDisabled={busy !== undefined}>
        <DialogHeader>
          <DialogTitle>알림</DialogTitle>
          <DialogDescription>이 기기에서 받을 알림</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          {checking ? (
            <p className="text-muted-foreground">확인 중…</p>
          ) : (
            <>
              <p className={state === "on" ? "font-medium" : "text-muted-foreground"}>{MESSAGE[state]}</p>
              {state === "off" && (
                <Button disabled={busy !== undefined || !userId} onClick={() => void turnOn()}>
                  푸시 알림 켜기
                </Button>
              )}
              {state === "on" && (
                <Button variant="outline" disabled={busy !== undefined} onClick={() => void turnOff()}>
                  끄기
                </Button>
              )}
              {/* 푸시가 없는 브라우저 — 탭이 열려 있을 때의 승인 알림만(설계 5.4). 묻지 않았을 때만 */}
              {state === "unsupported" && tabPermission === "default" && (
                <Button variant="outline" disabled={busy !== undefined} onClick={() => void allowTab()}>
                  탭이 열려 있을 때만 알림 켜기
                </Button>
              )}
            </>
          )}
          {busy === "on" && <p className="text-muted-foreground">켜는 중…</p>}
          {busy === "off" && <p className="text-muted-foreground">끄는 중…</p>}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {install.canInstall && (
            <Button variant="outline" onClick={() => void install.install()}>
              <DownloadIcon aria-hidden />앱 설치
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

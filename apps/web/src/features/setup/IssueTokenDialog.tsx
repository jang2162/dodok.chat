import type { IssueBridgeTokenResult } from "@dodok/shared";
import type { QueryKey } from "@tanstack/react-query";
import { KeyRoundIcon } from "lucide-react";
import { type FormEvent, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { qk } from "@/api/queries";
import { ApiRequestError } from "@/api/http";
import { useLeaveGuard } from "@/hooks/useLeaveGuard";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { HelpDetails } from "@/features/connections/HelpDetails";
import { llmsHandoffLine } from "./llms";
import { useIssueToken } from "./mutations";
import { CopyBlock, PACK_COMMAND, pluginInstallCommand } from "./sections";

type Issued = { token: string; record: { label: string } };

/**
 * 폼에 그리는 발급 실패(스펙 7장 「서버 오류 문구를 그대로 보이지 않는다」) — 서버 문구 대신 고정 문구.
 * `VALIDATION` 은 라벨 규칙(trim 뒤 1~60자, 대화상자별 금지 라벨은 `reservedLabel`), 그 밖(네트워크·5xx)은 undefined — 전역 토스트가 알린다
 */
function issueError(e: unknown, label: string, reservedLabel?: (label: string) => string | undefined) {
  if (!(e instanceof ApiRequestError)) return undefined;
  if (e.code === "VALIDATION") return reservedLabel?.(label) ?? "라벨은 1~60자로 적어 주세요.";
  if (e.code === "CONFLICT") return "토큰을 발급하지 못했습니다. 다시 시도해 주세요.";
  return undefined;
}

/**
 * 「새 토큰 발급」(스펙 「연결 페이지」 교체 흐름 1) — 라벨 → 발급 → 원문과 설정 조각을 한 번 보인다. 브리지·러너 토큰이 함께 쓴다.
 * 원문이 보이는 동안은 「복사했습니다」로만 닫힌다(Esc·바깥 클릭·X 없음) — 복사하지 못한 채 닫히면 다시 볼 길이 없다.
 * 원문은 이 컴포넌트 상태에만 있고 닫으면 버린다 — 쿼리·뮤테이션 캐시에는 들어가지 않는다(`useIssueToken`).
 * 같은 까닭으로 원문이 보이는 동안 페이지를 떠나는 것도 막는다(`useLeaveGuard`): 라우트 이동은 대화상자 안에서 한 번 더 묻고,
 * 탭 닫기·새로고침은 브라우저가 묻게 한다. 「복사했습니다」를 누르면 둘 다 풀린다
 */
export function IssueDialog<T extends Issued>({
  triggerRef,
  triggerLabel,
  title,
  description,
  path,
  listKey,
  config,
  reservedLabel,
  handoff,
}: {
  triggerRef?: RefObject<HTMLButtonElement | null>;
  triggerLabel: string;
  /** 라벨 입력 화면의 제목·설명 */
  title: string;
  description: string;
  /** 발급 API 경로(`/api/v1` 뒤)와 다시 받을 목록 키 */
  path: string;
  listKey: QueryKey;
  /** 원문 아래에 그릴 설정 조각 */
  config: (issued: T) => ReactNode;
  /** 서버가 VALIDATION 으로 막는 라벨이면 그 까닭 */
  reservedLabel?: (label: string) => string | undefined;
  /** 원문 바로 아래 「AI 에게 맡기기」 한 줄(llmsHandoffLine) — 원문을 담으므로 원문과 같은 규칙으로 이 대화상자에서만 보인다 */
  handoff?: (issued: T) => string;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string>();
  const [issued, setIssued] = useState<T>();
  const issue = useIssueToken<T>(path, listKey, setIssued);
  const labelId = useId();
  const errorId = useId();
  const trimmed = label.trim();
  const stayRef = useRef<HTMLButtonElement>(null);
  const leave = useLeaveGuard(issued !== undefined);

  useEffect(() => {
    if (leave.status === "blocked") stayRef.current?.focus();
  }, [leave.status]);

  function reset() {
    setLabel("");
    setError(undefined);
    setIssued(undefined);
    issue.reset();
  }

  function onOpenChange(next: boolean) {
    // 발급 중·원문이 보이는 동안은 닫지 않는다 — 원문은 「복사했습니다」로만 버린다
    if (!next && (issue.isPending || issued)) return;
    setOpen(next);
    if (!next) reset();
  }

  /** 원문을 버리고 닫는다. 막아 둔 라우트 이동이 있으면 이어서 보낸다 — 떠나려던 사람이 복사를 마친 것이다 */
  function done() {
    const proceed = leave.status === "blocked" ? leave.proceed : undefined;
    setOpen(false);
    reset();
    proceed?.();
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!trimmed || issue.isPending) return;
    setError(undefined);
    issue.mutate(trimmed, { onError: (err) => setError(issueError(err, trimmed, reservedLabel)) });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button ref={triggerRef} type="button" size="sm">
          <KeyRoundIcon />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!issued} closeDisabled={issue.isPending}>
        {issued ? (
          <IssuedToken
            issued={issued}
            handoff={handoff}
            config={config}
            leave={leave}
            stayRef={stayRef}
            onDone={done}
          />
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor={labelId}>라벨</Label>
              <Input
                id={labelId}
                value={label}
                maxLength={60}
                autoComplete="off"
                aria-invalid={error !== undefined || undefined}
                aria-describedby={error !== undefined ? errorId : undefined}
                onChange={(e) => {
                  setLabel(e.target.value);
                  setError(undefined);
                }}
              />
            </div>
            {error !== undefined && (
              <p id={errorId} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={!trimmed || issue.isPending}>
                {issue.isPending ? "발급하는 중…" : "발급"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 발급·다시 발급 결과 — 원문·「AI 에게 맡기기」·설정 조각을 한 번 보이고 「복사했습니다」로만 닫는다. 떠나기 막기(`useLeaveGuard`)는 부르는
 * 대화상자가 든다 — 이 화면이 사라져도 막힌 이동을 이어 보내는 것은 그쪽이다. `onDone` 은 원문을 버리고 막아 둔 이동이 있으면 이어 보낸다
 */
export function IssuedToken<T extends Issued>({
  issued,
  title,
  handoff,
  config,
  leave,
  stayRef,
  onDone,
}: {
  issued: T;
  /** 머리 — 기본은 「「라벨」 토큰을 발급했습니다」 */
  title?: string;
  handoff?: (issued: T) => string;
  config: (issued: T) => ReactNode;
  leave: ReturnType<typeof useLeaveGuard>;
  stayRef: RefObject<HTMLButtonElement | null>;
  onDone: () => void;
}) {
  return (
    <div className="grid min-w-0 gap-4">
      <DialogHeader>
        <DialogTitle>{title ?? `「${issued.record.label}」 토큰을 발급했습니다`}</DialogTitle>
        <DialogDescription>
          원문은 지금 한 번만 보입니다. 닫으면 다시 볼 수 없으니 복사해 두세요.
        </DialogDescription>
      </DialogHeader>
      <div className="grid min-w-0 gap-1.5">
        <p className="text-sm font-medium">토큰</p>
        <CopyBlock text={issued.token} label="토큰 복사" wrap />
      </div>
      {handoff && (
        <div className="grid min-w-0 gap-1.5">
          <p className="text-sm font-medium">AI 에게 맡기기</p>
          <p className="text-xs text-muted-foreground">
            설치할 머신에서 도는 AI 에게 이 한 줄을 건네면 안내서대로 설치합니다. 토큰이 들어 있으니 원문처럼
            다루세요.
          </p>
          <CopyBlock text={handoff(issued)} label="AI 에게 맡기기 복사" wrap testId="llms-handoff" />
        </div>
      )}
      {config(issued)}
      {leave.status === "blocked" && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm"
        >
          <p className="font-medium">이 페이지를 떠나면 토큰 원문을 다시 볼 수 없습니다.</p>
          <p>복사를 마쳤다면 「복사했습니다」를 누르세요. 닫고 이어서 이동합니다.</p>
          <div className="flex flex-wrap gap-2">
            <Button ref={stayRef} type="button" size="sm" variant="outline" onClick={leave.reset}>
              머무르기
            </Button>
            <Button type="button" size="sm" variant="destructive" onClick={onDone}>
              원문을 버리고 떠나기
            </Button>
          </div>
        </div>
      )}
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          복사했습니다
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * 브리지 토큰 발급(그 Gateway 에 묶인다) — 원문과 Gateway 호스트에 붙여 넣는 설치 명령 한 줄(설치 한 줄 명령 스펙 2026-11-02 「3. 웹」).
 * 발급 응답의 `pluginConfig` 는 그리지 않는다 — 설치 스크립트가 계정 설정을 넣는다
 */
export function IssueTokenDialog({
  gatewayId,
  origin,
  pluginFileAvailable,
  triggerRef,
}: {
  gatewayId: string;
  /** 서버의 공개 오리진(publicOriginOf) — 설치 명령과 「AI 에게 맡기기」 줄의 서버 주소 */
  origin: string;
  /** 서버가 플러그인 tgz 를 품었는가(`status.pluginFile.available`) — 없으면 설치 명령 대신 만드는 명령 */
  pluginFileAvailable: boolean;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <IssueDialog<IssueBridgeTokenResult>
      triggerRef={triggerRef}
      triggerLabel="새 토큰 발급"
      title="새 브리지 토큰"
      description="알아볼 라벨(예: Gateway 호스트 이름)을 붙입니다. 원문은 발급 직후 한 번만 보입니다."
      path={`/gateways/${gatewayId}/bridge-tokens`}
      listKey={qk.bridgeTokens}
      handoff={(issued) => llmsHandoffLine("bridge", origin, issued.token)}
      config={(issued) =>
        pluginFileAvailable ? (
          <div className="grid min-w-0 gap-1.5">
            <p className="text-sm font-medium">설치 명령</p>
            <p className="text-xs text-muted-foreground">
              Gateway 호스트에 붙여 넣으면 플러그인을 설치하고 이 토큰을 넣습니다. 토큰이 들어 있으니 원문처럼
              다루세요.
            </p>
            <HelpDetails label="설치 명령">
              <p>플러그인을 받아 설치하고 이 토큰을 넣은 뒤 Gateway 를 다시 올립니다.</p>
              <p>
                맨 앞 공백은 우분투 기본 bash 가 이 줄을 히스토리에 남기지 않게 합니다(다른 셸에서는 남을 수
                있습니다).
              </p>
            </HelpDetails>
            <CopyBlock
              text={pluginInstallCommand(origin, issued.token)}
              label="설치 명령 복사"
              testId="plugin-install-command"
            />
          </div>
        ) : (
          <div className="grid min-w-0 gap-1.5">
            <p className="text-sm font-medium">설치 명령</p>
            <p className="text-xs text-muted-foreground">
              서버에 플러그인 파일이 없습니다. 저장소에서 만든 뒤 서버를 재시작하고 토큰을 다시 발급하세요.
            </p>
            <CopyBlock text={PACK_COMMAND} label="만드는 명령 복사" />
          </div>
        )
      }
    />
  );
}

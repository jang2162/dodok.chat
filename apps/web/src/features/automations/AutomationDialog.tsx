import type { AutomationKind, AutomationSchedule, AutomationSummary } from "@dodok/shared";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { detailField, formError } from "@/api/formErrors";
import { ApiRequestError } from "@/api/http";
import { useArchivedChannels, useChannels } from "@/api/queries";
import { useOpsStatus } from "@/features/ops/queries";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/ui/dialog";
import { FieldError } from "@/ui/field-error";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { REPEAT_LABEL, WEEKDAYS } from "./copy";
import { MentionTextarea } from "./MentionTextarea";
import { useCreateAutomation, useReissueWebhook, useUpdateAutomation } from "./mutations";
import { WebhookUrlOnce } from "./WebhookUrlOnce";

/** shared AutomationName·AutomationBodyMd 와 같은 상한 — 칸이 먼저 막는다 */
const NAME_MAX = 40;
const BODY_MAX = 4000;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const NAME_TAKEN = "같은 이름의 자동화가 있습니다";

const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

type Draft = {
  name: string;
  /** 비어 있으면 첫 채널(채널 목록을 받기 전에 열린 만들기) */
  channelId: string;
  kind: AutomationKind;
  bodyMd: string;
  repeat: AutomationSchedule["repeat"];
  weekday: number;
  time: string;
  minute: number;
};

function draftOf(a: AutomationSummary | undefined): Draft {
  const s = a?.schedule;
  return {
    name: a?.name ?? "",
    channelId: a?.channelId ?? "",
    kind: a?.kind ?? "schedule",
    bodyMd: a?.bodyMd ?? "",
    repeat: s?.repeat ?? "daily",
    weekday: s?.repeat === "weekly" ? s.weekday : 1,
    time: s && "time" in s ? s.time : "09:00",
    minute: s?.repeat === "hourly" ? s.minute : 0,
  };
}

function scheduleOf(d: Draft): AutomationSchedule {
  switch (d.repeat) {
    case "hourly":
      return { repeat: "hourly", minute: d.minute };
    case "weekly":
      return { repeat: "weekly", weekday: d.weekday, time: d.time };
    default:
      return { repeat: d.repeat, time: d.time };
  }
}

/**
 * 자동화 만들기·수정 대화상자(자동화 스펙 「웹」 장): 이름·채널·종류(만들 때만)·문구(작성기의 @ 후보)·예약(반복·요일·시각, 매시간이면
 * 분). 웹훅이면 만든 직후와 「주소 다시 만들기」 뒤에 URL 을 한 번 보인다 — 원문은 이 컴포넌트 상태(`url`)에만 있고 「복사했습니다」로
 * 버린다. 보내는 중·URL 이 보이는 동안은 닫지 않는다(Esc·바깥 클릭·X 없음). 수정은 채널을 바꾸지 않았으면 같은 채널을 그대로
 * 보낸다 — 보관된 채널이어도 서버는 옮길 때만 막는다
 */
export function AutomationDialog({
  automation,
  children,
}: {
  automation?: AutomationSummary;
  /** 여는 단추 */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(automation));
  const [url, setUrl] = useState<string>();
  const [issued, setIssued] = useState<"created" | "reissued">();
  const [error, setError] = useState<string>();
  const [nameError, setNameError] = useState<string>();
  const [askReissue, setAskReissue] = useState(false);
  const menuOpen = useRef(false);
  const id = useId();

  const create = useCreateAutomation((u) => {
    setUrl(u);
    setIssued("created");
  });
  const update = useUpdateAutomation();
  const reissue = useReissueWebhook((u) => {
    setUrl(u);
    setIssued("reissued");
  });
  const pending = create.isPending || update.isPending || reissue.isPending;

  const listed = useChannels().data;
  const channels = listed ?? [];
  const channelId = draft.channelId || (channels[0]?.id ?? "");
  // 보관된 채널은 사이드바 목록에 없다 — 지금 채널이 거기 없을 때만 보관 목록에서 이름을 찾는다
  const missing = channelId !== "" && !channels.some((c) => c.id === channelId);
  const archived = useArchivedChannels({ enabled: open && missing && listed !== undefined }).data;
  const timeZone = useOpsStatus({ enabled: open }).data?.timeZone;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const scheduled = draft.kind === "schedule";
  const canSubmit =
    draft.name.trim() !== "" &&
    draft.bodyMd.trim() !== "" &&
    channelId !== "" &&
    (!scheduled || draft.repeat === "hourly" || HHMM.test(draft.time));

  function reset() {
    setDraft(draftOf(automation));
    setUrl(undefined);
    setIssued(undefined);
    setError(undefined);
    setNameError(undefined);
    setAskReissue(false);
    create.reset();
    reissue.reset();
  }

  function onOpenChange(next: boolean) {
    if (!next && (pending || url)) return;
    if (next) reset();
    setOpen(next);
  }

  function done() {
    setOpen(false);
    reset();
  }

  function onError(err: Error) {
    if (detailField(err, ["name"]) === "name" || (err instanceof ApiRequestError && err.code === "CONFLICT"))
      setNameError(NAME_TAKEN);
    else setError(formError(err));
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit || pending) return;
    setError(undefined);
    setNameError(undefined);
    const base = { name: draft.name.trim(), channelId, bodyMd: draft.bodyMd };
    if (automation) {
      update.mutate(
        { id: automation.id, patch: { ...base, ...(scheduled ? { schedule: scheduleOf(draft) } : {}) } },
        { onSuccess: done, onError },
      );
      return;
    }
    // 웹훅은 응답의 URL 을 보여야 하므로 닫지 않는다 — onIssued 가 본문을 URL 로 바꾼다
    create.mutate(
      scheduled ? { kind: "schedule", ...base, schedule: scheduleOf(draft) } : { kind: "webhook", ...base },
      { onSuccess: (row) => row.kind === "schedule" && done(), onError },
    );
  }

  const title = automation ? "자동화 수정" : "자동화 만들기";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        showCloseButton={!url}
        closeDisabled={pending}
        // 입력 화면에는 설명이 없다 — 웹훅 주소 화면만 설명을 잇는다
        {...(url ? {} : { "aria-describedby": undefined })}
        // 문구 칸의 @ 후보가 열려 있으면 Esc 는 후보만 닫는다
        onEscapeKeyDown={(e) => menuOpen.current && e.preventDefault()}
      >
        {url ? (
          <WebhookUrlOnce
            title={issued === "reissued" ? "새 웹훅 주소를 만들었습니다" : "웹훅 주소를 만들었습니다"}
            url={url}
            onDone={done}
          />
        ) : (
          <form onSubmit={submit} noValidate className="grid min-w-0 gap-4">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-name`}>이름</Label>
              <Input
                id={`${id}-name`}
                value={draft.name}
                maxLength={NAME_MAX}
                aria-invalid={nameError !== undefined || undefined}
                aria-describedby={nameError ? `${id}-name-error` : undefined}
                onChange={(e) => {
                  set({ name: e.target.value });
                  setNameError(undefined);
                }}
              />
              <FieldError id={`${id}-name-error`}>{nameError}</FieldError>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-channel`}>채널</Label>
              <select
                id={`${id}-channel`}
                className={SELECT}
                value={channelId}
                onChange={(e) => set({ channelId: e.target.value })}
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
                {missing && (
                  <option value={channelId}>
                    {listed === undefined
                      ? "불러오는 중…"
                      : `#${archived?.find((c) => c.id === channelId)?.name ?? "보관된 채널"} (보관됨)`}
                  </option>
                )}
              </select>
            </div>
            {!automation && (
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">종류</legend>
                <RadioGroup
                  value={draft.kind}
                  onValueChange={(v) => set({ kind: v as AutomationKind })}
                  className="flex flex-wrap gap-4"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id={`${id}-schedule`} value="schedule" />
                    <Label htmlFor={`${id}-schedule`} className="font-normal">
                      예약
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id={`${id}-webhook`} value="webhook" />
                    <Label htmlFor={`${id}-webhook`} className="font-normal">
                      웹훅
                    </Label>
                  </div>
                </RadioGroup>
              </fieldset>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-body`}>문구</Label>
              <MentionTextarea
                id={`${id}-body`}
                channelId={channelId}
                value={draft.bodyMd}
                maxLength={BODY_MAX}
                onChange={(bodyMd) => set({ bodyMd })}
                onMenuChange={(o) => {
                  menuOpen.current = o;
                }}
              />
            </div>
            {scheduled && (
              <fieldset className="grid gap-3">
                <legend className="mb-1 text-sm font-medium">예약</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor={`${id}-repeat`}>반복</Label>
                    <select
                      id={`${id}-repeat`}
                      className={SELECT}
                      value={draft.repeat}
                      onChange={(e) => set({ repeat: e.target.value as Draft["repeat"] })}
                    >
                      {(Object.keys(REPEAT_LABEL) as Draft["repeat"][]).map((r) => (
                        <option key={r} value={r}>
                          {REPEAT_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  </div>
                  {draft.repeat === "weekly" && (
                    <div className="grid gap-1.5">
                      <Label htmlFor={`${id}-weekday`}>요일</Label>
                      <select
                        id={`${id}-weekday`}
                        className={SELECT}
                        value={draft.weekday}
                        onChange={(e) => set({ weekday: Number(e.target.value) })}
                      >
                        {WEEKDAYS.map((w, i) => (
                          <option key={w} value={i}>
                            {w}요일
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {draft.repeat === "hourly" ? (
                    <div className="grid gap-1.5">
                      <Label htmlFor={`${id}-minute`}>분</Label>
                      <select
                        id={`${id}-minute`}
                        className={SELECT}
                        value={draft.minute}
                        onChange={(e) => set({ minute: Number(e.target.value) })}
                      >
                        {Array.from({ length: 60 }, (_, m) => (
                          <option key={m} value={m}>
                            {m}분
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="grid gap-1.5">
                      <Label htmlFor={`${id}-time`}>시각</Label>
                      <Input
                        id={`${id}-time`}
                        type="time"
                        step={60}
                        value={draft.time}
                        onChange={(e) => set({ time: e.target.value })}
                      />
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {timeZone ? `시간대 ${timeZone}` : "워크스페이스 시간대"}
                </p>
              </fieldset>
            )}
            {automation?.kind === "webhook" && (
              <div className="grid gap-2 rounded-md border p-3">
                <p className="text-sm font-medium">웹훅 주소</p>
                {askReissue ? (
                  <div className="flex flex-col gap-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm">
                    <p>옛 주소는 곧바로 쓸 수 없게 됩니다.</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={pending}
                        onClick={() => reissue.mutate(automation.id)}
                      >
                        다시 만들기
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => setAskReissue(false)}>
                        취소
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="justify-self-start"
                    onClick={() => setAskReissue(true)}
                  >
                    주소 다시 만들기
                  </Button>
                )}
              </div>
            )}
            {error !== undefined && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={!canSubmit || pending}>
                {automation
                  ? update.isPending
                    ? "저장하는 중…"
                    : "저장"
                  : create.isPending
                    ? "만드는 중…"
                    : "만들기"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

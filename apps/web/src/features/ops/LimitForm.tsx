import type { OpsStatus } from "@dodok/shared";
import { type FormEvent, useId, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { Section } from "@/features/setup/sections";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { useSaveRunLimit } from "./mutations";

/** shared OpsSettingsPatch 와 같은 범위 — 서버 VALIDATION 보다 먼저 막는다 */
const MIN = 1;
const MAX = 10_000;
export const LIMIT_RANGE_ERROR = `${MIN}~${MAX} 사이 정수로 적거나 비워 두세요(비우면 무제한)`;

const NUM = new Intl.NumberFormat("ko-KR");

/** 칸 → 저장할 값. 빈칸은 무제한(null), 범위 밖·정수 아님은 undefined */
export function parseLimit(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n >= MIN && n <= MAX ? n : undefined;
}

function Usage({ status }: { status: OpsStatus }) {
  const { runsToday, dailyRunLimit: limit } = status;
  if (limit === null) return <p className="text-sm">오늘 {NUM.format(runsToday)}회 · 무제한</p>;
  const pct = Math.min(100, (runsToday / limit) * 100);
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm">
        오늘 {NUM.format(runsToday)} / {NUM.format(limit)}회
      </p>
      <div
        role="progressbar"
        aria-label="오늘 사용량"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(runsToday, limit)}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={pct >= 100 ? "h-full bg-destructive" : "h-full bg-primary"}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * 한도(스펙 7장): 워크스페이스 일일 런 상한(비우면 무제한)과 오늘 사용량 막대. 채널별 한도는 채널 설정에 있다.
 * 검증 오류·서버 거절은 섹션 안에 그린다
 */
export function LimitForm({ status }: { status: OpsStatus }) {
  const save = useSaveRunLimit();
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const id = useId();
  const value = draft ?? (status.dailyRunLimit === null ? "" : String(status.dailyRunLimit));

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (save.isPending) return;
    const limit = parseLimit(value);
    if (limit === undefined) {
      setError(LIMIT_RANGE_ERROR);
      return;
    }
    setError(undefined);
    save.mutate(limit, {
      onSuccess: () => {
        setDraft(undefined);
        setSaved(true);
      },
      onError: (err) =>
        setError(
          `저장하지 못했습니다 — ${err instanceof ApiRequestError ? err.message : "서버 연결을 확인하세요"}`,
        ),
    });
  }

  return (
    <Section title="한도">
      <Usage status={status} />
      {status.blockedToday > 0 && (
        <p className="text-sm text-destructive">
          오늘 워크스페이스 상한으로 막힌 런 {NUM.format(status.blockedToday)}회
        </p>
      )}
      <form onSubmit={submit} noValidate className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-limit`}>워크스페이스 일일 런 상한</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={`${id}-limit`}
            inputMode="numeric"
            placeholder="무제한"
            className="w-32"
            value={value}
            aria-invalid={error === LIMIT_RANGE_ERROR || undefined}
            aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
            disabled={save.isPending}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(undefined);
              setSaved(false);
            }}
          />
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? "저장 중…" : "저장"}
          </Button>
          <span role="status" className="text-xs text-muted-foreground">
            {saved ? "저장했습니다" : ""}
          </span>
        </div>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          비우면 무제한. 서버 시각 0시에 다시 셉니다. 채널별 한도는 각 채널 설정의 「릴레이 정책」에 있습니다.
        </p>
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
    </Section>
  );
}

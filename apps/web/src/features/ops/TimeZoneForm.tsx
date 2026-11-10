import type { OpsStatus } from "@dodok/shared";
import { type FormEvent, useId, useMemo, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { Section } from "@/features/setup/sections";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";
import { useSaveTimeZone } from "./mutations";

/**
 * 고를 수 있는 시간대 — 이 브라우저의 IANA 목록 앞에 UTC. `Intl.supportedValuesOf("timeZone")` 에는 `UTC`·`Etc/UTC`·`Etc/GMT-9`·
 * `EST` 같은 이름이 없다(정규 지역 이름만) — UTC 는 따로 넣고, 지금 값이 목록에 없으면 그 값도 넣어 현재 값으로 보인다(API 로 저장한
 * `Etc/GMT-9` 등). 오프셋 꼴(`+09:00`)은 서버가 400 이라 만들지 않는다
 */
export function timeZoneOptions(current: string): string[] {
  const listed = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];
  return listed.includes(current) ? listed : [current, ...listed];
}

/**
 * 워크스페이스 시간대(자동화 스펙 「워크스페이스 시간대」 절) — 예약 자동화의 시각을 이 시간대의 벽시계로 센다. 저장하면 서버가 정규형으로
 * 돌려준 이름이 선택기에 남는다. 검증 오류·서버 거절은 섹션 안에 그린다
 */
export function TimeZoneForm({ status }: { status: OpsStatus }) {
  const save = useSaveTimeZone();
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const id = useId();
  const value = draft ?? status.timeZone;
  const options = useMemo(() => timeZoneOptions(value), [value]);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (save.isPending) return;
    setError(undefined);
    save.mutate(value, {
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
    <Section title="시간대">
      <form onSubmit={submit} className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-zone`}>워크스페이스 시간대</Label>
        <div className="flex flex-wrap items-center gap-2">
          <select
            id={`${id}-zone`}
            value={value}
            aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
            disabled={save.isPending}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(undefined);
              setSaved(false);
            }}
            className="h-8 max-w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {options.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? "저장 중…" : "저장"}
          </Button>
          <span role="status" className="text-xs text-muted-foreground">
            {saved ? "저장했습니다" : ""}
          </span>
        </div>
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
    </Section>
  );
}

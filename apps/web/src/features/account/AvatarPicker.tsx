import { useEffect, useId, useState } from "react";
import { formError } from "@/api/formErrors";
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { cropToSquare } from "./avatarImage";

/**
 * 사진 바꾸기(프로필 스펙 3.6) — 사람·에이전트 공용. 고른 그림을 가운데 정사각형 256px 로 만들어 미리 보이고, 「사진 저장」을 누르면
 * 올린다. 서버의 400(형식·크기·가로세로) 문구는 이 자리 안에 보인다
 */
export function AvatarPicker({
  name,
  currentUrl,
  upload,
  remove,
  label = "사진",
}: {
  name: string;
  currentUrl: string | undefined;
  upload: (image: Blob) => Promise<unknown>;
  remove: () => Promise<unknown>;
  label?: string;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState<{ blob: Blob; url: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => () => draft && URL.revokeObjectURL(draft.url), [draft]);

  async function pick(file: File | undefined) {
    setError(undefined);
    if (!file) return;
    try {
      const blob = await cropToSquare(file);
      setDraft({ blob, url: URL.createObjectURL(blob) });
    } catch {
      setError("그림을 읽지 못했습니다 — png·jpeg·webp·gif 를 고르세요");
    }
  }

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      setDraft(undefined);
    } catch (e) {
      setError(formError(e) ?? (e instanceof Error ? e.message : "저장하지 못했습니다"));
    } finally {
      setBusy(false);
    }
  }

  const shown = draft?.url ?? currentUrl;
  return (
    <div className="flex items-center gap-3">
      <Avatar className="size-16">
        {shown && <AvatarImage src={shown} alt={draft ? "새 사진 미리보기" : ""} />}
        <AvatarFallback className="text-xl">{name.slice(0, 1)}</AvatarFallback>
      </Avatar>
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm" disabled={busy}>
            <label htmlFor={inputId} className="cursor-pointer">
              {label} 고르기
            </label>
          </Button>
          <input
            id={inputId}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-label={`${label} 고르기`}
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {draft && (
            <Button size="sm" disabled={busy} onClick={() => void run(() => upload(draft.blob))}>
              {label} 저장
            </Button>
          )}
          {!draft && currentUrl && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(remove)}>
              {label} 지우기
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

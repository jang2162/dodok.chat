import type { ReactNode } from "react";

/** 프로필 칸 한 줄 — 이름표와 값 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

export function NotFound() {
  return <p className="p-4 text-sm text-muted-foreground">프로필을 찾을 수 없습니다.</p>;
}

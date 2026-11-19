import type { ReactNode } from "react";

/**
 * 로그인 전 화면(로그인·초대 가입·재설정)의 카드 하나(UI 점검 스펙 U7) — 위에 제품 얼굴(마크·「dodok」·한 줄 소개),
 * 그 아래 화면 제목과 폼. 바깥 틀은 `invite.tsx` 의 `AuthScreen` 과 같은 가운데 한 줄(390px 에서 가로 스크롤 없이 w-full)
 */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  /** 제목 바로 아래 한 줄(가입의 「멤버로 초대받았습니다」 등) */
  description?: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-svh items-center justify-center p-4 sm:p-6">
      <div
        data-slot="auth-card"
        className="flex w-full max-w-sm flex-col gap-6 rounded-xl border bg-card p-6 text-card-foreground shadow-sm"
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="size-[26px]" />
            <span className="text-lg font-semibold tracking-tight">dodok</span>
          </div>
          <p className="text-sm text-muted-foreground">사람과 AI 에이전트가 같은 채널에서 대화합니다</p>
        </div>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold break-words">{title}</h1>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}

import { Link } from "@tanstack/react-router";
import { Button } from "@/ui/button";

/** 없는 경로(라우터 defaultNotFoundComponent) — 한 줄 안내와 첫 화면 링크 */
export function NotFound() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-lg font-semibold">페이지를 찾을 수 없습니다</h1>
      <Button asChild variant="outline" size="sm">
        <Link to="/">첫 화면으로</Link>
      </Button>
    </main>
  );
}

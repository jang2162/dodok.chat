import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { ApiRequestError } from "@/api/http";
import { Button } from "@/ui/button";

/** 네트워크 실패(fetch 의 TypeError)나 API 오류면 서버 연결 문제로, 그 밖은 화면 오류로 알린다 */
const isServerProblem = (e: unknown) => e instanceof ApiRequestError || e instanceof TypeError;

/** 라우트 오류 화면 — 「다시 시도」는 라우트를 다시 불러 가드부터 다시 돈다 */
export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <div role="alert" className="flex min-h-svh flex-col items-center justify-center gap-3 p-6 text-sm">
      <p>{isServerProblem(error) ? "서버에 연결할 수 없습니다" : "화면을 표시할 수 없습니다"}</p>
      <Button variant="outline" onClick={() => void router.invalidate()}>
        다시 시도
      </Button>
    </div>
  );
}

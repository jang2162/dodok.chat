import type { App } from "./app";

/** 신호·예외로 내릴 때 close() 를 기다리는 상한 — 넘기면 exit(1)(깨끗한 종료로 적지 않는다) */
export const PROCESS_EXIT_TIMEOUT_MS = 10_000;

/** 사건 detail 에는 오류 이름만 — 메시지·스택에는 본문·경로·토큰이 섞일 수 있다(스펙 8장). 스택은 로그 줄의 err 에만 */
const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/**
 * 운영 보강 스펙 5.1 — 처리 안 된 예외·신호. unhandledRejection 은 기록하고 계속 돈다. uncaughtException 은 기록(동기 —
 * better-sqlite3 라 record 가 끝나면 DB 에 있다)한 뒤 닫고 exit(1). SIGINT·SIGTERM 은 닫은 뒤 깨끗한 표지를 쓰고 exit(0).
 * 종료는 한 번만 시작한다 — 도중의 신호는 무시하고, 도중의 예외는 기록만 하고 종료 코드를 1 로 바꾼다
 */
export function installProcessHandlers(deps: {
  app: Pick<App, "close" | "logger"> & { ops: Pick<App["ops"], "record"> };
  runState: { markClean(): void };
  exit: (code: number) => void;
  proc: Pick<NodeJS.EventEmitter, "on">;
}): void {
  const { app, runState, exit, proc } = deps;
  let exitCode: number | undefined;
  const shutdown = (code: number) => {
    if (exitCode !== undefined) {
      exitCode = Math.max(exitCode, code);
      return;
    }
    exitCode = code;
    const deadline = setTimeout(() => exit(1), PROCESS_EXIT_TIMEOUT_MS);
    void app.close().then(() => {
      clearTimeout(deadline);
      if (exitCode === 0) runState.markClean();
      exit(exitCode ?? 1);
    });
  };

  proc.on("unhandledRejection", (err) => {
    app.logger.error({ err, event: "ops.crash_rejection" }, "unhandled rejection");
    app.ops.record({
      kind: "crash_rejection",
      key: "process",
      severity: "error",
      detail: { name: errorName(err) },
    });
  });
  proc.on("uncaughtException", (err) => {
    app.logger.error({ err, event: "ops.crash_exception" }, "uncaught exception");
    app.ops.record({
      kind: "crash_exception",
      key: "process",
      severity: "error",
      detail: { name: errorName(err) },
    });
    shutdown(1);
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) proc.on(sig, () => shutdown(0));
}

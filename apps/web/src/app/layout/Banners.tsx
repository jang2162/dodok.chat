import { UnplugIcon } from "lucide-react";
import { useAdapterStatus } from "@/api/queries";
import { useWireStatus } from "@/realtime/wire";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";

/**
 * 연결 문제 배너(스펙 6.5·8장) — wire 자체와 OpenClaw 연결, 둘은 함께 보일 수 있다.
 * wire 는 `reconnecting` 만 끊김으로 본다(`offline` 은 이쪽에서 끊은 것이라 머물지 않는다).
 * `protocol_mismatch`·`rejected` 는 재연결을 멈춘 상태라 사용자가 할 일을 알린다.
 * OpenClaw 배너는 점(ConnectionDots)과 같은 규칙을 따른다 — wire 가 끊기면 `adapter.status` 가 더는 오지 않아
 * 마지막 값이 남으므로 「모름」으로 보고 띄우지 않는다. 그 사정은 끊김 배너가 이미 알린다(브라우저 재검증 걱정 3).
 * 라이브 영역(alert — 할 일이 있는 것, status — 기다리면 되는 것)은 비어 있는 채로 늘 두고 안의 배너만 바꾼다 —
 * 새로 끼운 라이브 영역은 스크린 리더가 놓칠 수 있다. 두 wire 상태는 함께 올 수 없어 alert 를 위에 두어도 순서가 같다
 */
export function Banners() {
  const wire = useWireStatus((s) => s.status);
  const { data: adapter } = useAdapterStatus();
  const openclawDown =
    wire === "connected" &&
    adapter !== undefined &&
    (adapter.gateway !== "connected" || adapter.bridge === "down");

  return (
    <>
      <div role="alert">
        {wire === "protocol_mismatch" && (
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 bg-destructive/10 px-4 py-1.5 text-sm">
            <span>서버가 새 버전입니다.</span>
            <span>앱을 새로고침하세요</span>
            <Button size="xs" variant="outline" onClick={() => window.location.reload()}>
              새로고침
            </Button>
          </div>
        )}
        {wire === "rejected" && (
          <div className="bg-destructive/10 px-4 py-1.5 text-center text-sm">
            실시간 연결이 거부되었습니다 — 주소(localhost:5173)를 확인하세요
          </div>
        )}
      </div>
      <div role="status">
        {wire === "reconnecting" && (
          <div className="bg-muted px-4 py-1 text-center text-xs text-muted-foreground">
            서버에 다시 연결하는 중…
          </div>
        )}
        {openclawDown && (
          // 바깥 status 영역이 읽는다 — Alert 의 기본 role="alert" 는 뺀다
          <Alert role={undefined} className="rounded-none border-x-0 border-t-0">
            <UnplugIcon />
            <AlertDescription>
              OpenClaw 에 연결되지 않아 에이전트가 답하지 못합니다. 메시지는 저장됩니다.
            </AlertDescription>
          </Alert>
        )}
      </div>
    </>
  );
}

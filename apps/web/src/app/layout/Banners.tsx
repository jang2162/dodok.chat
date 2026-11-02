import { Link } from "@tanstack/react-router";
import { UnplugIcon } from "lucide-react";
import { useAdapterStatus, useIsOwner } from "@/api/queries";
import { useOffline } from "@/pwa/offline";
import { useWireStatus } from "@/realtime/wire";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { gatewayDown } from "./gatewayHealth";

/**
 * 연결 문제 배너(스펙 6.5·8장) — wire 자체와 OpenClaw 연결, 둘은 함께 보일 수 있다.
 * wire 는 `reconnecting` 만 끊김으로 본다(`offline` 은 이쪽에서 끊은 것이라 머물지 않는다).
 * `protocol_mismatch`·`rejected` 는 재연결을 멈춘 상태라 사용자가 할 일을 알린다. `rejected` 는 REST 세션은 살아 있는데
 * wire 가 UNAUTHORIZED 일 때라(`realtime/handlers.ts` `verifySession`) 원인은 브라우저 주소와 서버 APP_ORIGIN 의 불일치뿐이다 —
 * 그래서 지금 연 주소를 그대로 보인다(운영 주소는 배포마다 달라 박을 수 없다).
 * OpenClaw 배너는 점(ConnectionDots)과 같은 규칙을 따른다 — wire 가 끊기면 `adapter.status` 가 더는 오지 않아
 * 마지막 값이 남으므로 「모름」으로 보고 띄우지 않는다. 그 사정은 끊김 배너가 이미 알린다(브라우저 재검증 걱정 3).
 * 오프라인(스펙 4장 — 브라우저 오프라인이거나 me 가 네트워크 오류)이면 「오프라인」 배너 하나만 — 그동안 wire 도
 * `reconnecting` 이지만 같은 사실을 두 번 말하지 않는다. OpenClaw 배너는 wire 가 붙어 있을 때만이라 겹치지 않는다.
 * 라이브 영역(alert — 할 일이 있는 것, status — 기다리면 되는 것)은 비어 있는 채로 늘 두고 안의 배너만 바꾼다 —
 * 새로 끼운 라이브 영역은 스크린 리더가 놓칠 수 있다. 두 wire 상태는 함께 올 수 없어 alert 를 위에 두어도 순서가 같다.
 * OpenClaw 배너는 끊긴 Gateway 를 이름으로 부르고 둘 이상이면 수로 묶는다(멀티 Gateway 스펙 「웹」 절) — Gateway 가 없거나 모두 꺼졌으면
 * 끊긴 연결이 없다. 「연결 설정 보기」는 owner 에게만(주소·토큰을 고치는 것은 owner 의 일) — 끊긴 Gateway 가 하나면 그 Gateway
 * 상세로, 여럿이면 「연결」 탭으로
 */
export function Banners() {
  const wire = useWireStatus((s) => s.status);
  const offline = useOffline();
  const { data: adapter } = useAdapterStatus();
  const owner = useIsOwner();
  const down =
    wire === "connected" && adapter?.provider === "openclaw" ? adapter.gateways.filter(gatewayDown) : [];
  const [first] = down;
  const which = down.length === 1 && first ? `「${first.name}」` : `${down.length}개`;

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
            실시간 연결이 거부되었습니다 — 이 주소({window.location.origin})가 서버의 APP_ORIGIN 과 다릅니다
          </div>
        )}
      </div>
      <div role="status">
        {offline ? (
          <div className="bg-muted px-4 py-1 text-center text-xs text-muted-foreground">
            오프라인 — 저장된 내용을 보여 줍니다
          </div>
        ) : (
          wire === "reconnecting" && (
            <div className="bg-muted px-4 py-1 text-center text-xs text-muted-foreground">
              서버에 다시 연결하는 중…
            </div>
          )
        )}
        {down.length > 0 && (
          // 바깥 status 영역이 읽는다 — Alert 의 기본 role="alert" 는 뺀다
          <Alert role={undefined} className="rounded-none border-x-0 border-t-0">
            <UnplugIcon />
            <AlertDescription>
              <p>
                OpenClaw Gateway {which}에 연결되지 않아 그 Gateway 의 에이전트가 답하지 못합니다. 메시지는
                저장됩니다.
              </p>
              {owner &&
                (down.length === 1 && first ? (
                  <Link
                    to="/settings/connection/gateway/$gatewayId"
                    params={{ gatewayId: first.id }}
                    className="text-foreground underline underline-offset-4"
                  >
                    연결 설정 보기
                  </Link>
                ) : (
                  <Link to="/settings/connection" className="text-foreground underline underline-offset-4">
                    연결 설정 보기
                  </Link>
                ))}
            </AlertDescription>
          </Alert>
        )}
      </div>
    </>
  );
}

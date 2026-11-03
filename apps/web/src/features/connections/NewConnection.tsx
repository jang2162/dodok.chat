import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { roleAtLeast } from "@dodok/shared";
import { useRole } from "@/api/queries";
import { GatewayFormBody } from "@/features/setup/GatewayForm";
import { IssueRunnerTokenDialog } from "@/features/setup/IssueRunnerTokenDialog";
import { RunnerExposure } from "@/features/setup/RunnerSection";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { useConnections } from "./context";
import { DetailHeader } from "./DetailHeader";

type Kind = "gateway" | "runner";
const KIND_LABEL: Record<Kind, string> = { gateway: "OpenClaw Gateway", runner: "러너" };

/**
 * 연결 추가(연결 탭 통합 스펙 3.3·5.2 — 멤버 누구나, 만든 사람이 그 연결의 주인). 「OpenClaw Gateway」·「러너」 둘 중 하나.
 * member 가 만든 Gateway 는 admin 이 승인할 때까지 서버가 접속하지 않는다(5.4 — 상세 머리에 「승인 대기」).
 * Gateway: 이름·주소·토큰 → 저장하면 그 Gateway 상세(플러그인 설치 상자가 펼쳐진 채). 러너: 「러너를 붙이면 드러나는 것」 네 줄을
 * 펼친 채 보이고, 토큰을 발급(원문 한 번·「AI 에게 맡기기」)해 「복사했습니다」를 누르면 그 러너 상세(설치 안내 펼침)로
 */
export function NewConnection() {
  const role = useRole();
  const member = roleAtLeast(role, "member");
  const admin = roleAtLeast(role, "admin");
  const navigate = useNavigate();
  const { focusDetail } = useConnections();
  const [kind, setKind] = useState<Kind>("gateway");
  const id = useId();
  if (!member)
    return (
      <p className="text-sm text-muted-foreground">
        권한이 없습니다 — 워크스페이스 멤버만 연결을 더할 수 있습니다.
      </p>
    );
  return (
    <>
      <DetailHeader title="연결 추가" />
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">무엇을 붙이나요</legend>
        <RadioGroup value={kind} onValueChange={(v) => setKind(v as Kind)} className="flex flex-wrap gap-4">
          {(["gateway", "runner"] as const).map((k) => (
            <div key={k} className="flex items-center gap-2">
              <RadioGroupItem id={`${id}-${k}`} value={k} />
              <Label htmlFor={`${id}-${k}`} className="font-normal">
                {KIND_LABEL[k]}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </fieldset>
      {kind === "gateway" ? (
        <div className="flex flex-col gap-4">
          {!admin && (
            <p className="text-sm text-muted-foreground">
              admin 이 승인하면 서버가 이 Gateway 에 접속합니다.
            </p>
          )}
          <GatewayFormBody
            embedded
            onSaved={(gateway) => {
              focusDetail.current = true;
              void navigate({
                to: "/settings/connection/gateway/$gatewayId",
                params: { gatewayId: gateway.id },
              });
            }}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            러너는 사람의 머신에서 에이전트를 돌리고, 이 서버로 나가는 연결 하나로 붙습니다. 토큰을 발급하면
            원문이 한 번만 보입니다.
          </p>
          <RunnerExposure />
          <div>
            <IssueRunnerTokenDialog
              onDone={(runnerId) => {
                focusDetail.current = true;
                void navigate({ to: "/settings/connection/runner/$runnerId", params: { runnerId } });
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}

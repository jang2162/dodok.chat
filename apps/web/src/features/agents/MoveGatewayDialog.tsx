import type { Agent } from "@dodok/shared";
import { useId, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { useAdapterStatus } from "@/api/queries";
import { josa } from "@/lib/josa";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { useMoveAgentGateway } from "./mutations";

/** 옮기기 실패 — 서버 문구 대신 고정 문구. 그 밖(네트워크·5xx·403)은 전역 토스트가 알린다 */
function moveErrorText(e: unknown): string | undefined {
  if (!(e instanceof ApiRequestError)) return undefined;
  if (e.code === "CONFLICT") return "옮길 Gateway 에 같은 id 의 에이전트가 이미 있습니다";
  if (e.code === "VALIDATION") return "그 Gateway 를 찾지 못했습니다 — 다시 고르세요";
  return undefined;
}

/**
 * 「Gateway 옮기기」 버튼과 대화상자(owner, 멀티 Gateway 스펙 「에이전트 API」·「웹」 절) — 지금 Gateway 를 뺀 Gateway 가운데 하나를 고른다.
 * Gateway 목록은 어댑터 상태(연결 점과 같은 캐시)에서. 옮기면 응답의 에이전트로 목록 캐시를 고친다(mutations). 옮기는 중엔 닫지 않는다
 */
export function MoveGatewayDialog({ agent }: { agent: Agent }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string>();
  const move = useMoveAgentGateway();
  const fieldId = useId();
  const adapter = useAdapterStatus().data;
  const targets = (adapter?.provider === "openclaw" ? adapter.gateways : []).filter(
    (g) => g.id !== agent.gateway?.id,
  );
  const target = targets.some((g) => g.id === picked) ? picked : targets[0]?.id;
  const handle = `@${agent.handle}`;
  const error = move.isError ? moveErrorText(move.error) : undefined;

  function change(next: boolean) {
    if (!next && move.isPending) return;
    if (next) {
      setPicked(undefined);
      move.reset();
    }
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`${handle} Gateway 옮기기`}>
          Gateway 옮기기
        </Button>
      </DialogTrigger>
      <DialogContent closeDisabled={move.isPending}>
        <DialogHeader>
          <DialogTitle>Gateway 옮기기</DialogTitle>
          <DialogDescription>
            {handle} {josa(agent.handle, "이", "가")} 답할 Gateway 를 고릅니다. 옮길 Gateway 에도 같은 id(
            {agent.providerAgentId})의 에이전트가 있어야 합니다.
          </DialogDescription>
        </DialogHeader>
        {targets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            옮길 다른 Gateway 가 없습니다 — 연결 페이지에서 Gateway 를 추가하세요.
          </p>
        ) : (
          <fieldset className="grid gap-2" disabled={move.isPending}>
            <legend className="mb-1 text-sm font-medium">옮길 Gateway</legend>
            <RadioGroup value={target ?? ""} onValueChange={setPicked} className="flex flex-col gap-2">
              {targets.map((g) => (
                <div key={g.id} className="flex items-center gap-2">
                  <RadioGroupItem id={`${fieldId}-${g.id}`} value={g.id} />
                  <Label htmlFor={`${fieldId}-${g.id}`} className="font-normal">
                    {g.name}
                    {!g.enabled && <span className="text-muted-foreground"> (꺼짐)</span>}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={move.isPending} onClick={() => change(false)}>
            취소
          </Button>
          {target !== undefined && (
            <Button
              disabled={move.isPending}
              onClick={() =>
                move.mutate({ id: agent.id, gatewayId: target }, { onSuccess: () => setOpen(false) })
              }
            >
              {move.isPending ? "옮기는 중…" : "옮기기"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

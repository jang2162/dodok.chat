import type { GatewaySetup } from "@dodok/shared";
import { useEffect, useRef } from "react";
import { useAgents } from "@/api/queries";
import { Button } from "@/ui/button";
import { useDeleteGateway } from "./mutations";
import { useBridgeTokens } from "./queries";
import { Pending } from "./sections";

/**
 * Gateway 삭제를 페이지 안에서 한 번 더 묻는다(멀티 Gateway 스펙 「웹」 절의 「연결 페이지」·결정 7). 에이전트는 남아 연결이 비고,
 * 그 Gateway 의 브리지 토큰은 폐기된 것까지 모두 지워진다(서버 응답 `deletedTokens` 와 같은 수). 두 수를 다 받기 전에는 지울 수 없다.
 * 열리면 초점은 「취소」 — 「삭제」를 두 번 눌러 곧장 지우지 않게
 */
export function DeleteGatewayConfirm({
  id,
  gateway,
  onCancel,
  onDeleted,
}: {
  /** 「삭제」 메뉴 버튼의 aria-controls 가 가리킨다 */
  id: string;
  gateway: GatewaySetup;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const agents = useAgents();
  const tokens = useBridgeTokens(gateway.id);
  const remove = useDeleteGateway(gateway.id);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  // 같은 틱의 둘째 클릭은 렌더된 `isPending` 이 아직 false 라 통과한다(GatewayForm 과 같은 까닭). 성공하면 카드째 사라진다
  const sending = useRef(false);
  function confirm() {
    if (sending.current) return;
    sending.current = true;
    // 실패는 전역 토스트가 알린다
    remove.mutateAsync().then(onDeleted, () => {
      sending.current = false;
    });
  }

  const agentCount = agents.data?.filter((a) => a.gateway?.id === gateway.id).length;
  const tokenCount = tokens.data?.length;
  const ready = agentCount !== undefined && tokenCount !== undefined;

  return (
    <div
      id={id}
      role="group"
      aria-label={`「${gateway.name}」 Gateway 삭제`}
      className="flex flex-col gap-3 rounded-md border border-destructive bg-destructive/10 p-3 text-sm"
    >
      <p className="font-medium">「{gateway.name}」 Gateway 를 삭제할까요?</p>
      {ready ? (
        <p>
          이 Gateway 의 에이전트 {agentCount}개는 남고 연결이 비어 옮기기를 기다립니다 · 브리지 토큰{" "}
          {tokenCount}개가 지워집니다
        </p>
      ) : agents.data === undefined ? (
        <Pending what="에이전트 목록" query={agents} />
      ) : (
        <Pending what="토큰 목록" query={tokens} />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={!ready || remove.isPending}
          onClick={confirm}
        >
          {remove.isPending ? "삭제하는 중…" : "삭제"}
        </Button>
        <Button
          ref={cancelRef}
          type="button"
          size="sm"
          variant="outline"
          disabled={remove.isPending}
          onClick={onCancel}
        >
          취소
        </Button>
      </div>
    </div>
  );
}

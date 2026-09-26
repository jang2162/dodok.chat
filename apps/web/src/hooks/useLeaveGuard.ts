import { useBlocker } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

/**
 * 한 번만 보이는 원문(브리지 토큰·초대·재설정 링크)이 화면에 있는 동안 페이지를 떠나지 못하게 한다 — 닫히면 다시 볼 길이 없다.
 * 라우트 이동(뒤로 가기·주소 변경)은 막아 두고 부르는 쪽이 대화상자 안에서 한 번 더 묻는다(`status === "blocked"` 면
 * `proceed`·`reset`). 탭 닫기·새로고침은 브라우저가 묻게 한다(`beforeunload`). `active` 가 거짓이 되면 둘 다 풀린다.
 * 막아 둔 채 부르는 컴포넌트가 사라지면(역할이 바뀌어 화면이 잠김 등) 이어서 보낸다 — useBlocker 는 언마운트 때 대기를 풀지 않아
 * 이동이 매달린다. 원문은 그 컴포넌트와 함께 이미 사라졌다
 */
export function useLeaveGuard(active: boolean) {
  const leave = useBlocker({
    shouldBlockFn: () => true,
    disabled: !active,
    // 라우터의 beforeunload 는 브라우저 히스토리에만 붙는다 — 히스토리 종류와 무관하게 아래 효과가 직접 건다
    enableBeforeUnload: false,
    withResolver: true,
  });

  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 옛 브라우저는 returnValue 가 있어야 묻는다
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useEffect(
    () => () => {
      const last = leaveRef.current;
      if (last.status === "blocked") last.proceed();
    },
    [],
  );

  return leave;
}

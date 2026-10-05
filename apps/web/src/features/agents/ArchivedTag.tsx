/**
 * 이름·핸들 바로 뒤에 붙는 작은 「삭제됨」(스펙 「에이전트 보관」 절) — 눈에는 여백으로만 떨어져 있어 접근성 트리에서는 앞 글자와 붙어
 * 「@dev삭제됨」 한 낱말이 된다. 보이는 글자는 숨기고 스크린 리더에는 띄운 「 (삭제됨)」을 준다
 */
export function ArchivedTag({ className }: { className?: string }) {
  return (
    <>
      <span aria-hidden className={className}>
        삭제됨
      </span>
      <span className="sr-only"> (삭제됨)</span>
    </>
  );
}

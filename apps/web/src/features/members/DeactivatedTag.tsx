/**
 * 핸들 바로 뒤에 붙는 작은 「비활성」 — 보이는 글자는 숨기고 스크린 리더에는 띄운 「 (비활성)」을 준다. 까닭은 `ArchivedTag` 와 같다
 * (여백으로만 떨어진 글자는 접근성 트리에서 앞 글자와 붙어 한 낱말이 된다)
 */
export function DeactivatedTag({ className }: { className?: string }) {
  return (
    <>
      <span aria-hidden className={className}>
        비활성
      </span>
      <span className="sr-only"> (비활성)</span>
    </>
  );
}

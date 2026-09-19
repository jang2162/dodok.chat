/** 핸들 → 8색 팔레트 색인(FNV-1a 32비트). 색 값은 theme/tokens.css 의 --agent-1…8(라이트·다크) */
export function agentColorIndex(handle: string): number {
  let h = 2166136261;
  for (const ch of handle) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 8;
}

/** 인라인 style 용 CSS 변수 참조. 클래스는 tokens.css 의 `bg-agent-N`·`border-agent-N`·`text-agent-N` */
export const agentColorVar = (handle: string): string => `var(--agent-${agentColorIndex(handle) + 1})`;

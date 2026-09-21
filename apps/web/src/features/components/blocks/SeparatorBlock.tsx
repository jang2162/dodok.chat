import { Separator } from "@/ui/separator";

/** separator 블록 — 구분선 한 줄. 에이전트가 넣은 내용의 경계라 장식이 아닌 구분선(role=separator)으로 알린다 */
export function SeparatorBlock() {
  return <Separator decorative={false} />;
}

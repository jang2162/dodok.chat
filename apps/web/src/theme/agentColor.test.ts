import { expect, it } from "vitest";
import { agentColorIndex, agentColorVar } from "./agentColor";

it("같은 핸들은 같은 색, 0~7, 여러 핸들이면 여러 색", () => {
  expect(agentColorIndex("dev")).toBe(agentColorIndex("dev"));
  const idx = Array.from({ length: 100 }, (_, i) => agentColorIndex(`agent-${i}`));
  expect(idx.every((i) => i >= 0 && i <= 7)).toBe(true);
  expect(new Set(idx).size).toBeGreaterThanOrEqual(6);
  expect(agentColorVar("dev")).toBe(`var(--agent-${agentColorIndex("dev") + 1})`);
});

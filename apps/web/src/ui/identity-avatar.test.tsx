import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentColorIndex } from "@/theme/agentColor";
import { IdentityAvatar, initialOf, personHue } from "@/ui/identity-avatar";

afterEach(() => vi.unstubAllGlobals());

describe("initialOf", () => {
  it("initial of odd names", () => {
    expect(initialOf("owner")).toBe("O");
    expect(initialOf("미아")).toBe("미");
    expect(initialOf("👩‍💻 dev")).toBe("👩‍💻");
    expect(initialOf("  dev")).toBe("D");
    expect(initialOf("  ")).toBe("?");
    expect(initialOf("")).toBe("?");
    expect(initialOf("élodie")).toBe("É");
  });
});

describe("personHue", () => {
  // tokens.css --agent-1…8 의 색상각
  const AGENT_HUES = [25, 70, 110, 150, 195, 240, 285, 330];
  const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

  it("사람 색상각은 가장 가까운 에이전트 색상각과 20° 이상 떨어진다(여덟 칸 전부)", () => {
    // 칸마다 그 칸으로 떨어지는 id 를 하나씩 찾는다
    const byIndex = new Map<number, string>();
    for (let i = 0; byIndex.size < 8 && i < 10000; i++) {
      const id = `u${i}`;
      if (!byIndex.has(agentColorIndex(id))) byIndex.set(agentColorIndex(id), id);
    }
    expect(byIndex.size).toBe(8);
    for (const id of byIndex.values()) {
      const nearest = Math.min(...AGENT_HUES.map((h) => gap(personHue(id), h)));
      expect(nearest).toBeGreaterThanOrEqual(20);
    }
  });

  it("같은 id 는 같은 색상각", () => {
    expect(personHue("owner")).toBe(personHue("owner"));
  });
});

describe("IdentityAvatar", () => {
  it("person gets tinted fill without ring, agent gets ring", () => {
    render(
      <>
        <IdentityAvatar kind="person" id="u1" name="owner" size={24} />
        <IdentityAvatar kind="agent" id="a1" name="dev" handle="dev" size={24} />
      </>,
    );
    const person = screen.getByText("O");
    expect(person.style.backgroundColor).toContain("var(--person-tint-l)");
    expect(person.style.color).toContain("var(--person-ink-l)");
    const personRoot = person.closest("[data-slot=avatar]") as HTMLElement;
    expect(personRoot).toHaveAttribute("data-kind", "person");
    expect(personRoot.className).not.toMatch(/\bborder-2\b/);
    expect(personRoot.style.borderColor).toBe("");

    const agent = screen.getByText("D");
    const agentRoot = agent.closest("[data-slot=avatar]") as HTMLElement;
    expect(agentRoot).toHaveAttribute("data-kind", "agent");
    expect(agentRoot.className).toMatch(/\bborder-2\b/);
    expect(agentRoot.style.borderColor).toBe(`var(--agent-${agentColorIndex("dev") + 1})`);
    expect(agent.style.backgroundColor).toContain("16%");
    expect(agent.style.color).toContain("75%");
  });

  it("initial size by avatar size", () => {
    render(
      <>
        <IdentityAvatar kind="person" id="u1" name="a" size={24} />
        <IdentityAvatar kind="person" id="u2" name="b" size={32} />
        <IdentityAvatar kind="person" id="u3" name="c" size={36} />
        <IdentityAvatar kind="person" id="u4" name="d" size={64} />
      </>,
    );
    expect(screen.getByText("A")).toHaveClass("text-xs");
    expect(screen.getByText("B")).toHaveClass("text-sm");
    expect(screen.getByText("C")).toHaveClass("text-[15px]");
    expect(screen.getByText("D")).toHaveClass("text-xl");
    expect(screen.getByText("D").closest("[data-slot=avatar]")).toHaveClass("size-16");
    for (const t of ["A", "B", "C", "D"]) expect(screen.getByText(t).className).not.toContain("text-[10px]");
  });

  it("image wins over initials", () => {
    // jsdom 은 사진을 내려받지 않는다 — Radix Avatar 가 쓰는 window.Image 를 「이미 받은 사진」으로 바꾼다
    vi.stubGlobal(
      "Image",
      class {
        complete = true;
        naturalWidth = 24;
        src = "";
        crossOrigin: string | null = null;
        addEventListener() {}
        removeEventListener() {}
      },
    );
    const { container } = render(
      <IdentityAvatar kind="person" id="u1" name="owner" avatarUrl="/a.png" size={24} />,
    );
    expect(container.querySelector("img")).toHaveAttribute("src", "/a.png");
    expect(screen.queryByText("O")).not.toBeInTheDocument();
  });

  it("사진을 아직 못 받았으면 그 사이만 이니셜", () => {
    const { container } = render(
      <IdentityAvatar kind="person" id="u1" name="owner" avatarUrl="/a.png" size={24} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("O")).toBeInTheDocument();
  });
});

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
  it("에이전트 8색 사이(22.5° 어긋남)에 온다", () => {
    for (const id of ["u1", "owner", "mia", "00000000-0000-4000-8000-000000000001"]) {
      expect(personHue(id)).toBe((agentColorIndex(id) * 45 + 25 + 22.5) % 360);
    }
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
      </>,
    );
    expect(screen.getByText("A")).toHaveClass("text-xs");
    expect(screen.getByText("B")).toHaveClass("text-sm");
    expect(screen.getByText("C")).toHaveClass("text-[15px]");
    for (const t of ["A", "B", "C"]) expect(screen.getByText(t).className).not.toContain("text-[10px]");
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

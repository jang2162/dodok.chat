import type { SelectOption } from "@dodok/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { OptionList, withinBounds } from "./OptionList";

const OPTS: SelectOption[] = [
  { value: "pdf", label: "PDF" },
  { value: "md", label: "마크다운", description: "가볍다", emoji: "📝" },
  { value: "html", label: "HTML" },
];
const FOUR: SelectOption[] = ["a", "b", "c", "d"].map((v) => ({ value: v, label: v.toUpperCase() }));
const opts = (n: number): SelectOption[] =>
  Array.from({ length: n }, (_, i) => ({ value: `o${i}`, label: `옵션${i}` }));

type Props = ComponentProps<typeof OptionList>;

/** value 를 쥐고 onChange 로 바꾸는 부모 — 제어 컴포넌트를 실제처럼 돌린다. 받은 next 는 spy 로도 남긴다 */
function Harness({
  initial = [],
  spy,
  ...over
}: Partial<Props> & { initial?: string[]; spy?: (n: string[]) => void }) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <OptionList
      name="보고서 형식"
      options={OPTS}
      multi={false}
      {...over}
      value={value}
      onChange={(next) => {
        spy?.(next);
        setValue(next);
      }}
    />
  );
}

describe("withinBounds", () => {
  it.each([
    [0, 1, 1, false],
    [1, 1, 1, true],
    [2, 1, 1, false],
    [0, 0, 25, true],
    [1, 2, 3, false],
    [2, 2, 3, true],
    [3, 2, 3, true],
    [4, 2, 3, false],
  ])("고른 %i개가 [%i, %i] 안인가 → %s", (count, min, max, ok) => {
    expect(withinBounds(count, min, max)).toBe(ok);
  });
});

describe("OptionList — 단일(라디오)", () => {
  it("fieldset 의 legend 가 무리의 이름이고, 라디오로 하나만 고른다", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const group = screen.getByRole("group", { name: "보고서 형식" });
    expect(group.tagName).toBe("FIELDSET");
    // aria-label 로는 같은 이름이 나지만 화면에서 사라진다 — 보이는 legend 여야 한다
    expect(within(group).getByText("보고서 형식").tagName).toBe("LEGEND");
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect(within(group).queryAllByRole("checkbox")).toEqual([]);

    await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
    expect(screen.getByRole("radio", { name: "PDF" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "HTML" }));
    expect(screen.getByRole("radio", { name: "PDF" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "HTML" })).toBeChecked();
    expect(spy.mock.calls).toEqual([[["pdf"]], [["html"]]]);
  });

  it("단일에는 max 를 무시한다 — 하나 고른 뒤에도 다른 것으로 바꿀 수 있다", async () => {
    render(<Harness max={1} />);
    await userEvent.click(screen.getByRole("radio", { name: "PDF" }));
    const html = screen.getByRole("radio", { name: "HTML" });
    expect(html).toBeEnabled();
    await userEvent.click(html);
    expect(html).toBeChecked();
    expect(screen.queryByText(/최대/)).toBeNull();
  });

  it("value 의 첫 값이 골라져 있다", () => {
    render(<Harness initial={["html"]} />);
    expect(screen.getByRole("radio", { name: "HTML" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "PDF" })).not.toBeChecked();
  });
});

describe("OptionList — 다중(체크박스)", () => {
  it("체크박스로 켜고 끈다", async () => {
    const spy = vi.fn();
    render(<Harness multi spy={spy} />);
    const group = screen.getByRole("group", { name: "보고서 형식" });
    expect(within(group).getAllByRole("checkbox")).toHaveLength(3);
    expect(within(group).queryAllByRole("radio")).toEqual([]);

    await userEvent.click(screen.getByRole("checkbox", { name: "PDF" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "HTML" }));
    expect(spy).toHaveBeenLastCalledWith(["pdf", "html"]);
    await userEvent.click(screen.getByRole("checkbox", { name: "PDF" }));
    expect(spy).toHaveBeenLastCalledWith(["html"]);
    expect(screen.getByRole("checkbox", { name: "PDF" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "HTML" })).toBeChecked();
  });

  it("max 에 다다르면 안 고른 항목이 잠기고, 「최대 N개」가 그 까닭을 보이게 말한다", async () => {
    render(<Harness multi options={FOUR} max={2} />);
    const hint = screen.getByText("최대 2개까지 고를 수 있습니다");
    expect(hint).toBeVisible();
    await userEvent.click(screen.getByRole("checkbox", { name: "A" }));
    expect(screen.getByRole("checkbox", { name: "C" })).toBeEnabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "B" }));

    for (const name of ["C", "D"]) {
      const locked = screen.getByRole("checkbox", { name });
      expect(locked).toBeDisabled();
      expect(locked).toHaveAccessibleDescription("최대 2개까지 고를 수 있습니다");
    }
    await userEvent.click(screen.getByRole("checkbox", { name: "C" }));
    expect(screen.getByRole("checkbox", { name: "C" })).not.toBeChecked();
  });

  it("max 에 다다라도 고른 항목은 그대로 끌 수 있고, 하나 끄면 다시 열린다", async () => {
    const spy = vi.fn();
    render(<Harness multi options={FOUR} max={2} initial={["a", "b"]} spy={spy} />);
    const a = screen.getByRole("checkbox", { name: "A" });
    expect(a).toBeEnabled();
    expect(a).not.toHaveAccessibleDescription();
    expect(screen.getByRole("checkbox", { name: "C" })).toBeDisabled();

    await userEvent.click(a);
    expect(spy).toHaveBeenLastCalledWith(["b"]);
    expect(a).not.toBeChecked();
    const c = screen.getByRole("checkbox", { name: "C" });
    expect(c).toBeEnabled();
    expect(c).not.toHaveAccessibleDescription();
    await userEvent.click(c);
    expect(spy).toHaveBeenLastCalledWith(["b", "c"]);
  });

  it("max 를 안 넘기면 제한이 없다 — 모두 고를 수 있고 「최대」 줄도 없다", async () => {
    render(<Harness multi options={FOUR} />);
    for (const name of ["A", "B", "C", "D"]) await userEvent.click(screen.getByRole("checkbox", { name }));
    for (const name of ["A", "B", "C", "D"]) expect(screen.getByRole("checkbox", { name })).toBeChecked();
    expect(screen.queryByText(/최대/)).toBeNull();
  });

  it("max 가 옵션 수 이상이면 잠길 일이 없어 「최대」 줄을 그리지 않는다", () => {
    render(<Harness multi options={FOUR} max={4} />);
    expect(screen.queryByText(/최대/)).toBeNull();
  });
});

describe("OptionList — 공통", () => {
  it("옵션의 이모지는 라벨 앞, description 은 그 옵션의 설명 — value 는 화면에 없다", () => {
    render(<Harness />);
    const md = screen.getByRole("radio", { name: "📝 마크다운" });
    expect(md).toHaveAccessibleDescription("가볍다");
    expect(screen.getByText("가볍다")).toBeVisible();
    expect(screen.getByRole("radio", { name: "PDF" })).not.toHaveAccessibleDescription();
    for (const value of ["pdf", "md", "html"]) expect(screen.queryByText(value)).toBeNull();
  });

  it("name 이 비면 legend 를 그리지 않는다(이름 없는 무리)", () => {
    const { container } = render(<Harness name="" />);
    expect(container.querySelector("legend")).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it.each([false, true])(
    "disabled 면 모든 항목이 잠기고 describedBy 가 무리를 설명한다 (multi=%s)",
    async (multi) => {
      const spy = vi.fn();
      render(
        <>
          <Harness multi={multi} disabled describedBy="why" spy={spy} />
          <span id="why">만료되었습니다</span>
        </>,
      );
      expect(screen.getByRole("group", { name: "보고서 형식" })).toHaveAccessibleDescription(
        "만료되었습니다",
      );
      const items = screen.getAllByRole(multi ? "checkbox" : "radio");
      expect(items).toHaveLength(3);
      for (const item of items) expect(item).toBeDisabled();
      await userEvent.click(items[0] as HTMLElement);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("describedBy 가 없으면 무리에 설명이 붙지 않는다", () => {
    render(<Harness />);
    expect(screen.getByRole("group", { name: "보고서 형식" })).not.toHaveAttribute("aria-describedby");
  });

  it("옵션이 6개까지는 그대로, 넘으면 스크롤 상자에 담는다", () => {
    const six = render(<Harness options={opts(6)} />);
    expect(six.container.querySelector(".overflow-y-auto")).toBeNull();
    six.unmount();
    const seven = render(<Harness options={opts(7)} />);
    const box = seven.container.querySelector(".overflow-y-auto");
    expect(box).not.toBeNull();
    expect(within(box as HTMLElement).getAllByRole("radio")).toHaveLength(7);
  });
});

import type { Person } from "@dodok/shared";
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { qk } from "@/api/queries";
import { msg, uid } from "../../../test/fixtures";
import { authorsClient, DEV, OWNER_PERSON, renderWithClient } from "../../../test/messages";
import { MessageBody } from "./MessageBody";
import { MessageItem } from "./MessageItem";

// 사람 작성자·멘션은 사람 목록(`GET /people`, wire `people.changed`)으로 푼다(팀 스펙 5·6장)
const MINA: Person = {
  id: uid(30),
  handle: "mina",
  displayName: "미나",
  role: "member",
  deactivatedAt: null,
};
const GONE: Person = {
  id: uid(31),
  handle: "jihoon",
  displayName: "지훈",
  role: "member",
  deactivatedAt: "2026-10-06T00:00:00.000Z",
};

describe("사람 작성자", () => {
  it("다른 사람의 메시지는 그 사람의 표시 이름", () => {
    renderWithClient(
      <MessageItem message={msg(1, { authorId: MINA.id })} head />,
      authorsClient(undefined, [OWNER_PERSON, MINA]),
    );
    expect(within(screen.getByRole("article")).getByText("미나")).toBeInTheDocument();
  });

  it("people.changed 로 캐시가 바뀌면 이름이 따라간다", async () => {
    const qc = authorsClient(undefined, [OWNER_PERSON, MINA]);
    renderWithClient(<MessageItem message={msg(1, { authorId: MINA.id })} head />, qc);
    act(() => qc.setQueryData<Person[]>(qk.people, [OWNER_PERSON, { ...MINA, displayName: "미나리" }]));
    expect(await within(screen.getByRole("article")).findByText("미나리")).toBeInTheDocument();
  });

  it("비활성 멤버는 「나간 멤버 @<핸들>」 흐린 글씨", () => {
    renderWithClient(
      <MessageItem message={msg(1, { authorId: GONE.id })} head />,
      authorsClient(undefined, [OWNER_PERSON, GONE]),
    );
    const name = within(screen.getByRole("article")).getByText("나간 멤버 @jihoon");
    expect(name).toHaveClass("text-muted-foreground");
    expect(screen.queryByText("지훈")).toBeNull();
  });

  it("사람 목록을 아직 못 받았으면 나는 me 로 푼다", () => {
    const qc = authorsClient();
    qc.removeQueries({ queryKey: qk.people });
    qc.setQueryDefaults(qk.people, { enabled: false });
    renderWithClient(<MessageItem message={msg(1)} head />, qc);
    expect(within(screen.getByRole("article")).getByText("주인")).toBeInTheDocument();
  });

  it("목록에 없는 사람은 「알 수 없음」", () => {
    renderWithClient(<MessageItem message={msg(1, { authorId: uid(99) })} head />);
    expect(within(screen.getByRole("article")).getByText("알 수 없음")).toBeInTheDocument();
  });
});

describe("사람 멘션", () => {
  it("다른 사람 멘션은 그 핸들, 비활성 멤버도 그 핸들", () => {
    renderWithClient(
      <MessageBody bodyMd={`<@u:${MINA.id}> <@u:${GONE.id}>`} />,
      authorsClient(undefined, [OWNER_PERSON, MINA, GONE]),
    );
    expect(screen.getByText("@mina")).toBeInTheDocument();
    expect(screen.getByText("@jihoon")).toBeInTheDocument();
  });
});

// 보관(삭제)한 에이전트도 목록(`GET /agents`)에 남아 기록이 그 에이전트를 계속 가리킨다(스펙 「에이전트 보관」 절)
describe("삭제된 에이전트", () => {
  const GONE_DEV = { ...DEV, archivedAt: "2026-10-05T00:00:00.000Z" };

  it("작성자 이름 옆에 「삭제됨」 — 이름은 그대로, 「알 수 없음」이 아니다", () => {
    renderWithClient(
      <MessageItem message={msg(1, { authorType: "agent", authorId: DEV.id })} head />,
      authorsClient([GONE_DEV]),
    );
    const article = screen.getByRole("article");
    expect(within(article).getByText(DEV.name)).toBeInTheDocument();
    expect(within(article).getByText("삭제됨")).toBeInTheDocument();
    expect(within(article).queryByText("알 수 없음")).toBeNull();
  });

  it("살아 있는 에이전트 작성자에는 「삭제됨」이 없다", () => {
    renderWithClient(<MessageItem message={msg(1, { authorType: "agent", authorId: DEV.id })} head />);
    expect(within(screen.getByRole("article")).queryByText("삭제됨")).toBeNull();
  });

  it("멘션 칩은 그 핸들 + 「삭제됨」 — 스크린 리더에는 핸들과 띄어 「(삭제됨)」으로 읽힌다", () => {
    renderWithClient(<MessageBody bodyMd={`<@a:${DEV.id}> 안녕`} />, authorsClient([GONE_DEV]));
    const chip = screen.getByText(`@${DEV.handle}`, { exact: false }).closest("[data-mention]");
    expect(chip).toHaveAttribute("data-archived");
    expect(within(chip as HTMLElement).getByText("삭제됨")).toBeInTheDocument();
    expect(spoken(chip)).toBe(`@${DEV.handle} (삭제됨)`);
  });
});

/** 접근성 트리에 가는 글자 — aria-hidden 을 걷은 textContent(jsdom 은 sr-only 를 숨기지 않으므로 그대로 남는다) */
function spoken(el: Element | null): string {
  const clone = el?.cloneNode(true) as Element | undefined;
  for (const hidden of clone?.querySelectorAll("[aria-hidden]") ?? []) hidden.remove();
  return clone?.textContent ?? "";
}

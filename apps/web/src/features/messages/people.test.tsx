import type { Person } from "@dodok/shared";
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { qk } from "@/api/queries";
import { msg, uid } from "../../../test/fixtures";
import { authorsClient, OWNER_PERSON, renderWithClient } from "../../../test/messages";
import { MessageBody } from "./MessageBody";
import { MessageItem } from "./MessageItem";

// 사람 작성자·멘션은 사람 목록(`GET /people`, wire `people.changed`)으로 푼다(팀 스펙 5·6장)
const MINA: Person = { id: uid(30), handle: "mina", displayName: "미나", role: "member" };
const GONE: Person = { id: uid(31), handle: "left-abc", displayName: "지훈", leftHandle: "jihoon" };

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

  it("나간 멤버는 「나간 멤버 @<leftHandle>」 흐린 글씨", () => {
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
  it("다른 사람 멘션은 그 핸들, 나간 멤버는 옛 핸들", () => {
    renderWithClient(
      <MessageBody bodyMd={`<@u:${MINA.id}> <@u:${GONE.id}>`} />,
      authorsClient(undefined, [OWNER_PERSON, MINA, GONE]),
    );
    expect(screen.getByText("@mina")).toBeInTheDocument();
    expect(screen.getByText("@jihoon")).toBeInTheDocument();
  });
});

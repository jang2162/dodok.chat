import type { Agent, MemberRow, Person } from "@dodok/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { emptyTimeline } from "@/features/messages/timeline";
import { usePresenceStore } from "@/features/presence/store";
import { setChannelSeq } from "@/realtime/timelineCache";
import { stubEditorDom } from "../../../test/domStubs";
import { CH as FCH, msg, uid } from "../../../test/fixtures";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { agentOf } from "../../../test/settingsServer";
import { json, ME, renderRoute, shellGet } from "../../../test/shellApi";

// 프로필 패널(프로필 스펙 3.1) — 세션 화면 오른쪽 패널의 탭 하나. member 에게 admin 칸이 보이지 않는다

const CH = "abc";
const ADA = uid(40);
const GONE = uid(41);
const RUNNER_TOKEN = uid(50);

const person = (id: string, handle: string, over: Partial<Person> = {}): Person => ({
  id,
  handle,
  displayName: handle,
  role: "member",
  deactivatedAt: null,
  statusMessage: null,
  ...over,
});
const PEOPLE: Person[] = [
  person(ME.user.id, "owner", { displayName: "주인", role: "owner" }),
  person(ADA, "ada", {
    displayName: "에이다",
    statusMessage: { emoji: "🌴", text: "휴가 중", until: null },
  }),
  person(GONE, "gone", { deactivatedAt: "2026-10-01T00:00:00.000Z" }),
];
const CODER: Agent = agentOf(uid(60), "coder", {
  name: "코더",
  provider: "runner",
  program: "claude",
  model: "claude-sonnet-5-5",
  createdBy: ME.user.id,
  dmAccess: "admins",
  runner: { tokenId: RUNNER_TOKEN, label: "laptop", revoked: false },
  basePrompt: "늘 짧게 답한다",
  runnerAgent: {
    projectId: uid(61),
    model: "claude-sonnet-5-5",
    permissionMode: "acceptEdits",
    allowedTools: ["Read"],
    disallowedTools: ["Bash"],
  },
});
const LEGACY: Agent = agentOf(uid(62), "legacy", { name: "옛봇", createdBy: null, dmAccess: "everyone" });

/** 역할마다 서버가 주는 모양 — admin 미만에게는 runnerAgent·basePrompt 가 없다(서버 agentForRole) */
function serve(role: "owner" | "admin" | "member") {
  const asMember = (a: Agent): Agent => {
    if (role !== "member") return a;
    const { runnerAgent: _r, basePrompt: _p, ...rest } = a;
    return rest;
  };
  const members: MemberRow[] = [
    {
      ...person(ADA, "ada"),
      role: "member",
      email: "ada@example.com",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/people") return json(200, { people: PEOPLE });
      if (url === "/api/v1/agents") return json(200, { agents: [CODER, LEGACY].map(asMember) });
      if (url === "/api/v1/members")
        return role === "member" ? json(403, { code: "FORBIDDEN", message: "x" }) : json(200, { members });
      if (url === "/api/v1/auth/me") return json(200, { ...ME, role });
      return shellGet(input, init) ?? json(200, { ...ME, role });
    }),
  );
}

const open = (kind: "u" | "a" | "x", id: string) => renderRoute(`/c/${CH}/s/${CH}/p/${kind}/${id}`);
// 패널 내용은 지연 import 다 — 첫 시험은 모듈을 처음 읽느라 기본 1초를 넘긴다
const panel = async () => within(await screen.findByTestId("page-channel-panel", {}, { timeout: 5000 }));

beforeEach(() => {
  usePresenceStore.getState().applySnapshot([]);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("에이전트 프로필", () => {
  it("member — 연결·모델·소유자·DM 허용은 보이고 권한·도구·기본 프롬프트는 없다", async () => {
    serve("member");
    open("a", CODER.id);
    const p = await panel();
    expect(await p.findByRole("heading", { name: "코더" })).toBeInTheDocument();
    expect(p.getByText("에이전트")).toBeInTheDocument();
    expect(p.getByText("laptop · Claude Code")).toBeInTheDocument();
    expect(p.getByText("claude-sonnet-5-5")).toBeInTheDocument();
    expect(p.getByText("@owner")).toBeInTheDocument();
    expect(p.getByText("admin 이상")).toBeInTheDocument();
    expect(p.queryByText("권한 모드")).toBeNull();
    expect(p.queryByText("허용 도구")).toBeNull();
    expect(p.queryByText("기본 프롬프트")).toBeNull();
    // DM 허용이 admin 이상이라 member 는 열 수 없다
    expect(p.queryByRole("link", { name: "DM 열기" })).toBeNull();
    expect(p.queryByRole("link", { name: "에이전트 설정" })).toBeNull();
    expect(p.queryByLabelText("사진 고르기")).toBeNull();
    expect(p.getByRole("button", { name: "멘션" })).toBeInTheDocument();
  });

  it("admin 이상 — 권한 모드·허용·금지 도구·기본 프롬프트와 「에이전트 설정」·「DM 열기」", async () => {
    serve("owner");
    open("a", CODER.id);
    const p = await panel();
    expect(await p.findByText("권한 모드")).toBeInTheDocument();
    expect(p.getByText("허용 도구")).toBeInTheDocument();
    expect(p.getByText("금지 도구")).toBeInTheDocument();
    expect(p.getByText("기본 프롬프트")).toBeInTheDocument();
    expect(p.getByRole("link", { name: "에이전트 설정" })).toHaveAttribute(
      "href",
      `/settings/connection/agent/${CODER.id}`,
    );
    expect(p.getByRole("link", { name: "DM 열기" })).toBeInTheDocument();
    // admin 이상은 패널에서 사진을 바꾼다
    expect(p.getByLabelText("사진 고르기")).toBeInTheDocument();
  });

  it("소유자 기록이 없으면 「기록 없음」, OpenClaw 에는 모델 줄이 없다(러너만)", async () => {
    serve("member");
    open("a", LEGACY.id);
    const p = await panel();
    expect(await p.findByText("기록 없음")).toBeInTheDocument();
    expect(p.queryByText("모델")).toBeNull();
    // everyone 이면 member 도 연다
    expect(p.getByRole("link", { name: "DM 열기" })).toBeInTheDocument();
  });

  it("점 이름(작업 중)이 보인다", async () => {
    serve("member");
    usePresenceStore.getState().applySnapshot([{ kind: "agent", id: CODER.id, state: "working" }]);
    open("a", CODER.id);
    const p = await panel();
    expect(await p.findAllByText("작업 중")).not.toHaveLength(0);
  });
});

describe("사람 프로필", () => {
  it("상태 메시지(이모지 + 글), 방해 금지면 「방해 금지 중」 줄 — 오프라인이어도", async () => {
    serve("member");
    usePresenceStore
      .getState()
      .applySnapshot([{ kind: "user", id: ADA, state: "offline", dnd: { until: null } }]);
    open("u", ADA);
    const p = await panel();
    expect(await p.findByRole("heading", { name: "에이다" })).toBeInTheDocument();
    expect(p.getByText("@ada")).toBeInTheDocument();
    expect(p.getByText("🌴")).toBeInTheDocument();
    expect(p.getByText("휴가 중")).toBeInTheDocument();
    expect(p.getByText(/방해 금지 중/)).toBeInTheDocument();
  });

  it("이메일은 admin 이상에게만", async () => {
    serve("owner");
    open("u", ADA);
    const p = await panel();
    expect(await p.findByText("ada@example.com")).toBeInTheDocument();
  });

  it("member 에게는 이메일이 없다", async () => {
    serve("member");
    open("u", ADA);
    const p = await panel();
    await p.findByRole("heading", { name: "에이다" });
    expect(p.queryByText("ada@example.com")).toBeNull();
  });

  it("「상태 바꾸기」는 내 패널에만 — 누르면 상태 폼이 패널 안에 열린다", async () => {
    serve("member");
    open("u", ME.user.id);
    const p = await panel();
    await userEvent.click(await p.findByRole("button", { name: "상태 바꾸기" }));
    expect(p.getByRole("form", { name: "상태 바꾸기" })).toBeInTheDocument();
    expect(p.getByRole("checkbox", { name: "도구 승인 요청은 계속 받기" })).toBeChecked();
  });

  it("남의 패널에는 「상태 바꾸기」가 없다", async () => {
    serve("member");
    open("u", ADA);
    const p = await panel();
    await p.findByRole("heading", { name: "에이다" });
    expect(p.queryByRole("button", { name: "상태 바꾸기" })).toBeNull();
    expect(p.getByRole("button", { name: "멘션" })).toBeInTheDocument();
  });

  it("비활성 멤버는 「비활성」, 점을 그리지 않는다", async () => {
    serve("member");
    usePresenceStore.getState().applySnapshot([{ kind: "user", id: GONE, state: "offline" }]);
    open("u", GONE);
    const p = await panel();
    expect(await p.findByText("비활성")).toBeInTheDocument();
    expect(p.queryByRole("img", { name: "오프라인" })).toBeNull();
  });
});

describe("경로", () => {
  it("/c/<ch>/s/<cv>/p/u/<id> 를 바로 열면 패널이 프로필 탭으로 그린다", async () => {
    serve("member");
    const { router } = open("u", ADA);
    const node = await screen.findByTestId("page-channel-panel");
    expect(node).toHaveAttribute("data-panel-tab", "profile");
    expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}/p/u/${ADA}`);
  });

  it("모르는 kind·없는 사람은 「찾을 수 없습니다」", async () => {
    serve("member");
    open("x", ADA);
    expect(await (await panel()).findByText(/찾을 수 없습니다/)).toBeInTheDocument();
  });
});

describe("여는 자리", () => {
  let restore: Array<() => void> = [];
  beforeEach(() => {
    restore = [stubEditorDom(), stubScrollLayout({ width: 800, height: 600 })];
  });
  afterEach(() => {
    for (const r of restore.splice(0)) r();
  });

  function withTimeline() {
    const qc = createQueryClient(() => {});
    const message = msg(1, { authorId: ADA, bodyMd: `<@a:${CODER.id}> 봐 주세요` });
    qc.setQueryData(qk.timeline(FCH, FCH), { ...emptyTimeline(), items: [message], lastSeq: 1 });
    setChannelSeq(qc, FCH, 1);
    return qc;
  }

  it("작성자 이름을 누르면 그 사람, 멘션 칩을 누르면 그 에이전트의 프로필 — 「멘션」은 작성기에 @핸들을 넣는다", async () => {
    serve("member");
    const { router } = renderRoute(`/c/${FCH}/s/${FCH}`, withTimeline());
    const list = within(await screen.findByRole("region", { name: "메시지" }, { timeout: 5000 }));
    await userEvent.click(await list.findByRole("button", { name: "에이다" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${FCH}/s/${FCH}/p/u/${ADA}`));
    expect(await (await panel()).findByRole("heading", { name: "에이다" })).toBeInTheDocument();

    await userEvent.click(list.getByRole("button", { name: "@coder" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${FCH}/s/${FCH}/p/a/${CODER.id}`));
    const p = await panel();
    await p.findByRole("heading", { name: "코더" });
    await userEvent.click(p.getByRole("button", { name: "멘션" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "메시지 입력" }).textContent).toContain("@coder"),
    );
  });
});

import { ComponentsV1 } from "@dodok/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { emptyTimeline } from "@/features/messages/timeline";
import { useRunStore } from "@/features/runs/runStore";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../test/domStubs";
import { AGENT, CH, msg, runState, textDelta, uid } from "../test/fixtures";
import { stubScrollLayout } from "../test/scrollLayout";
import { renderRoute } from "../test/shellApi";
import { DEV_AGENT, FIN_AGENT, agentOf, memberOf, stubSettingsServer } from "../test/settingsServer";

/**
 * 스펙 7.3 접근성 — 화면마다 (a) 이름 없는 버튼·링크·입력·그림이 없다(아이콘만 있는 버튼 포함),
 * (b) 대화상자·시트에는 제목(이름)이 있다, (c) 새 메시지 칩 영역은 aria-live="polite".
 * 이름은 Testing Library 의 접근 이름 계산(aria-label·aria-labelledby·label·글자)으로 잰다
 */

const ROLES = [
  "button",
  "link",
  "textbox",
  "combobox",
  "switch",
  "checkbox",
  "img",
  "dialog",
  "region",
] as const;

/** 접근 이름이 빈 요소를 역할마다 모은다 — 모두 비어 있어야 한다 */
function unnamed(root: HTMLElement = document.body) {
  return Object.fromEntries(
    ROLES.map((role) => [
      role,
      within(root)
        .queryAllByRole(role, { name: "" })
        .map((el) => el.outerHTML.slice(0, 160)),
    ]),
  );
}
const NONE = Object.fromEntries(ROLES.map((role) => [role, []]));

const narrow = () =>
  vi.spyOn(window, "matchMedia").mockImplementation((query: string): MediaQueryList => ({
    matches: query === "(max-width: 767px)",
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));

// 헤더 아바타 넷 + 「+N」 이 보이게 에이전트 여섯
const EXTRA = [3, 4, 5, 6].map((n) => agentOf(uid(20 + n), `ag${n}`));
const AGENTS = [DEV_AGENT, FIN_AGENT, ...EXTRA];

/** 채널 화면에 보일 것: 사람·에이전트 메시지(멘션), 「이어가기」 버튼이 있는 시스템 카드, 스트리밍 버블 */
function seedChannel() {
  const qc = createQueryClient(() => {});
  qc.setQueryData(qk.timeline(CH), {
    ...emptyTimeline(),
    items: [
      msg(1, { bodyMd: `<@a:${AGENT}> 정리해 줘` }),
      msg(2, {
        authorType: "agent",
        authorId: AGENT,
        bodyMd: "**정리**했습니다. [문서](https://example.com)",
      }),
      msg(3, {
        kind: "system",
        authorType: "system",
        authorId: undefined,
        bodyMd: "릴레이 한도에 도달했습니다.",
        systemMeta: { kind: "relay_limit" },
        components: ComponentsV1.parse({
          id: "cmp_1",
          blocks: [{ type: "actions", items: [{ type: "button", id: "go", label: "이어가기" }] }],
        }),
        componentState: { expiresAt: "2999-01-01T00:00:00.000Z", consumed: [] },
      }),
    ],
    lastSeq: 3,
  });
  act(() => {
    useRunStore.getState().applyState(runState({ status: "streaming" }));
    useRunStore.getState().applyEvent(textDelta(1, "답하는 중"));
  });
  return qc;
}

let restore: Array<() => void>;
beforeEach(() => {
  restore = [stubEditorDom(), stubScrollLayout()];
  useWireStatus.getState().setStatus("connected");
  useRunStore.getState().reset();
});
afterEach(() => {
  for (const fn of restore) fn();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useWireStatus.getState().setStatus("idle");
  useRunStore.getState().reset();
});

describe("앱 셸 + 채널 화면", () => {
  it("버튼·링크·입력·그림에 모두 이름이 있고, 새 메시지 칩 영역은 polite 라이브 영역", async () => {
    stubSettingsServer({
      agents: AGENTS,
      members: AGENTS.map((a) => memberOf("agent", a.id)),
    });
    renderRoute(`/c/${CH}`, seedChannel());
    expect(await screen.findByText("답하는 중")).toBeInTheDocument();
    const header = screen.getByTestId("channel-header");
    // 헤더 아바타 묶음: 넷 + 「+2」(이름이 있는 그림)
    expect(await within(header).findByRole("img", { name: "에이전트 2명 더" })).toHaveTextContent("+2");
    expect(screen.getByRole("button", { name: "이어가기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "실행 중지" })).toBeInTheDocument();

    expect(unnamed()).toEqual(NONE);
    const list = screen.getByRole("region", { name: "메시지" });
    expect(list.parentElement?.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it("좁은 화면: 사이드바 시트는 제목 「채널 목록」인 대화상자, 그 안도 이름이 다 있다", async () => {
    narrow();
    stubSettingsServer();
    renderRoute(`/c/${CH}`, seedChannel());
    const header = await screen.findByTestId("channel-header");
    await userEvent.click(within(header).getByRole("button", { name: "채널 목록 열기" }));
    const sheet = await screen.findByRole("dialog", { name: "채널 목록" });
    expect(unnamed(sheet)).toEqual(NONE);
  });

  it("「채널 만들기」 대화상자에 제목이 있다", async () => {
    stubSettingsServer();
    renderRoute(`/c/${CH}`);
    const nav = await screen.findByRole("navigation", { name: "채널" });
    await userEvent.click(within(nav).getByRole("button", { name: "채널 만들기" }));
    const dialog = await screen.findByRole("dialog", { name: "채널 만들기" });
    expect(unnamed(dialog)).toEqual(NONE);
  });
});

describe("채널 설정 패널", () => {
  it("넓은 화면: 섹션·칸·스위치·체크박스·버튼에 모두 이름이 있다", async () => {
    stubSettingsServer({
      channel: { relayPolicy: { maxRelayTurns: 4, allowPairs: [] } },
      members: [memberOf("agent", DEV_AGENT.id), memberOf("agent", FIN_AGENT.id)],
    });
    renderRoute(`/c/${CH}/settings`);
    const panel = await screen.findByTestId("page-channel-settings");
    await within(panel).findByRole("list", { name: "채널 에이전트" });
    await userEvent.click(within(panel).getByRole("button", { name: "@dev 채널 프롬프트 편집" }));
    expect(within(panel).getByRole("textbox", { name: "@dev 채널 프롬프트 오버라이드" })).toBeInTheDocument();
    expect(within(panel).getByRole("checkbox", { name: "@dev → @fin" })).toBeInTheDocument();
    expect(unnamed(panel)).toEqual(NONE);
  });

  it("좁은 화면: 전체 화면 시트는 제목 「채널 설정」인 대화상자", async () => {
    narrow();
    stubSettingsServer();
    renderRoute(`/c/${CH}/settings`);
    const sheet = await screen.findByRole("dialog", { name: "채널 설정" });
    await within(sheet).findByRole("region", { name: "멤버" });
    expect(unnamed(sheet)).toEqual(NONE);
  });

  it("「에이전트 제거」·「새 대화」 확인 대화상자에 제목이 있다", async () => {
    stubSettingsServer({ members: [memberOf("agent", DEV_AGENT.id)] });
    renderRoute(`/c/${CH}/settings`);
    const list = await screen.findByRole("list", { name: "채널 에이전트" });
    await userEvent.click(within(list).getByRole("button", { name: "@dev 제거" }));
    expect(unnamed(await screen.findByRole("dialog", { name: "에이전트 제거" }))).toEqual(NONE);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(within(list).getByRole("button", { name: "@dev 새 대화" }));
    expect(unnamed(await screen.findByRole("dialog", { name: "새 대화" }))).toEqual(NONE);
  });
});

describe("에이전트 화면", () => {
  it("목록·스위치·편집 버튼, 「Gateway 에서 가져오기」 대화상자(제목·닫기)까지 이름이 있다", async () => {
    stubSettingsServer({
      override: ({ method, url }) =>
        method === "GET" && url === "/api/v1/agents/discover"
          ? new Response(JSON.stringify({ agents: [{ providerAgentId: "ops", name: "Ops" }] }), {
              status: 200,
            })
          : undefined,
    });
    renderRoute("/agents");
    const page = await screen.findByTestId("page-agents");
    await within(page).findByRole("switch", { name: "@dev 사용" });
    expect(unnamed()).toEqual(NONE);

    await userEvent.click(within(page).getByRole("button", { name: "Gateway 에서 가져오기" }));
    const dialog = await screen.findByRole("dialog", { name: "Gateway 에서 가져오기" });
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: "Ops" }));
    expect(within(dialog).getByRole("button", { name: "닫기" })).toBeInTheDocument();
    expect(unnamed(dialog)).toEqual(NONE);
  });
});

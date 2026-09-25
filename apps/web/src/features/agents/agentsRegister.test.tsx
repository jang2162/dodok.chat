import { onlineManager } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { qk } from "@/api/queries";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { apiErr, dev, gate, json, openDiscover, renderPage, stubServer } from "../../../test/agentsPage";

let toastError: MockInstance<typeof toast.error>;
beforeEach(() => {
  toastError = vi.spyOn(toast, "error");
});
afterEach(() => {
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Gateway 에서 가져오기", () => {
  const discovered = [
    { providerAgentId: "dev", name: "Dev" },
    { providerAgentId: "Fin Bot", name: "Fin" },
    { providerAgentId: "ops" },
  ];

  it("등록 안 된 것만 체크 목록 — 핸들 기본값은 handleFrom, 고른 수만큼 POST 하고 목록을 갱신한다", async () => {
    const server = stubServer({ agents: [dev()], discover: () => json(200, { agents: discovered }) });
    renderPage();
    const dialog = await openDiscover();
    await within(dialog).findByRole("checkbox", { name: "Fin" });
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(dialog).queryByRole("checkbox", { name: "Dev" })).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Fin" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "ops" }));
    expect(within(dialog).getByRole("textbox", { name: "Fin 핸들" })).toHaveValue("fin-bot");
    expect(within(dialog).getByRole("textbox", { name: "Fin 이름" })).toHaveValue("Fin");
    expect(within(dialog).getByRole("textbox", { name: "ops 핸들" })).toHaveValue("ops");
    const opsName = within(dialog).getByRole("textbox", { name: "ops 이름" });
    expect(opsName).toHaveValue("ops");
    await userEvent.clear(opsName);
    await userEvent.type(opsName, "Ops");

    await userEvent.click(within(dialog).getByRole("button", { name: "2개 등록" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.bodies("POST")).toEqual([
      { providerAgentId: "Fin Bot", handle: "fin-bot", name: "Fin" },
      { providerAgentId: "ops", handle: "ops", name: "Ops" },
    ]);
    expect(screen.getByText("@fin-bot")).toBeInTheDocument();
    expect(screen.getByText("@ops")).toBeInTheDocument();
    expect(server.count("GET", "/api/v1/agents")).toBe(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("핸들이 겹치면(409) 그 항목 핸들 칸 아래 서버 message — 나머지는 등록되고 대화상자는 남는다(토스트 없음)", async () => {
    const server = stubServer({
      agents: [dev()],
      discover: () => json(200, { agents: discovered }),
      create: (body, fallback) =>
        body.handle === "ops" ? apiErr(409, "CONFLICT", "handle @ops 는 이미 쓰이고 있다") : fallback(body),
    });
    renderPage();
    const dialog = await openDiscover();
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: "Fin" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "ops" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "2개 등록" }));

    const opsHandle = within(dialog).getByRole("textbox", { name: "ops 핸들" });
    await waitFor(() => expect(opsHandle).toHaveAccessibleDescription("handle @ops 는 이미 쓰이고 있다"));
    expect(opsHandle).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).queryByRole("checkbox", { name: "Fin" })).not.toBeInTheDocument();
    expect(screen.getByText("@fin-bot")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();

    await userEvent.clear(opsHandle);
    await userEvent.type(opsHandle, "ops2");
    expect(within(dialog).queryByText("handle @ops 는 이미 쓰이고 있다")).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "1개 등록" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("@ops2")).toBeInTheDocument();
    expect(server.bodies("POST")).toHaveLength(3);
  });

  it("항목 옆 OpenClaw id 는 이름과 다를 때만 적는다", async () => {
    stubServer({
      discover: () =>
        json(200, {
          agents: [
            { providerAgentId: "Fin Bot", name: "Fin" },
            { providerAgentId: "ops" },
            { providerAgentId: "qa", name: "qa" },
          ],
        }),
    });
    renderPage();
    const dialog = await openDiscover();
    await within(dialog).findByRole("checkbox", { name: "Fin" });
    expect(within(dialog).getByText("Fin Bot")).toBeInTheDocument();
    expect(within(dialog).getAllByText("ops")).toHaveLength(1);
    expect(within(dialog).getAllByText("qa")).toHaveLength(1);
  });

  it("다시 열면 discover 를 새로 부른다 — 받기 전엔 지난 목록 대신 「불러오는 중」", async () => {
    const g = gate();
    let n = 0;
    const server = stubServer({
      agents: [dev()],
      discover: async () => {
        if (++n === 2) await g.opened;
        return json(200, { agents: discovered });
      },
    });
    renderPage();
    let dialog = await openDiscover();
    await within(dialog).findByRole("checkbox", { name: "Fin" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    dialog = await openDiscover();
    expect(within(dialog).getByRole("status")).toHaveTextContent("Gateway 에서 불러오는 중…");
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    g.open();
    await within(dialog).findByRole("checkbox", { name: "Fin" });
    expect(server.count("GET", "/api/v1/agents/discover")).toBe(2);
  });

  it("열려 있는 동안 다시 불러와도 고른 항목·편집은 그대로 — 재연결로는 부르지 않고, 오프라인에서 열면 「불러오는 중」", async () => {
    const g = gate();
    let n = 0;
    const server = stubServer({
      agents: [dev()],
      discover: async () => {
        if (++n === 2) await g.opened;
        return json(200, { agents: discovered });
      },
    });
    const qc = renderPage();
    await screen.findByText("@dev");
    onlineManager.setOnline(false);
    const dialog = await openDiscover();
    expect(within(dialog).getByRole("status")).toHaveTextContent("Gateway 에서 불러오는 중…");
    expect(server.count("GET", "/api/v1/agents/discover")).toBe(0);
    onlineManager.setOnline(true);

    await userEvent.click(await within(dialog).findByRole("checkbox", { name: "Fin" }));
    const finHandle = within(dialog).getByRole("textbox", { name: "Fin 핸들" });
    // 재연결 — 다시 부르지 않는다(부르면 편집 중인 목록이 흔들린다)
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await userEvent.clear(finHandle);
    await userEvent.type(finHandle, "fin2");
    expect(server.count("GET", "/api/v1/agents/discover")).toBe(1);

    // 누가 ["agents"] 를 무효화해 discover 가 다시 불려도 목록은 그대로 둔다
    void qc.invalidateQueries({ queryKey: qk.agents });
    await waitFor(() => expect(server.count("GET", "/api/v1/agents/discover")).toBe(2));
    expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "Fin" })).toBeChecked();
    expect(finHandle).toHaveValue("fin2");
    g.open();
    await waitFor(() => expect(qc.isFetching({ queryKey: qk.discover })).toBe(0));
    expect(within(dialog).getByRole("textbox", { name: "Fin 핸들" })).toHaveValue("fin2");
    expect(within(dialog).getByRole("button", { name: "1개 등록" })).toBeEnabled();
  });

  /** ui 대화상자 기본 닫기 버튼의 className — 따로 띄워 읽고 내린다 */
  function defaultCloseClassName() {
    const { unmount } = render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>기준</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const className = within(screen.getByRole("dialog", { name: "기준" })).getByRole("button", {
      name: "닫기",
    }).className;
    if (!className) throw new Error("기준 닫기 버튼이 없다");
    unmount();
    return className;
  }

  it("등록하는 동안엔 닫을 수 없다(닫기 버튼·Esc·바깥 클릭) — 끝나면 실패 항목을 대화상자 안에 보이고 닫을 수 있다", async () => {
    const defaultClose = defaultCloseClassName();
    const g = gate();
    const server = stubServer({
      agents: [dev()],
      discover: () => json(200, { agents: discovered }),
      create: async (body, fallback) => {
        await g.opened;
        return body.handle === "ops"
          ? apiErr(409, "CONFLICT", "handle @ops 는 이미 쓰이고 있다")
          : fallback(body);
      },
    });
    renderPage();
    const dialog = await openDiscover();
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: "Fin" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "ops" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "2개 등록" }));

    const closeButton = within(dialog).getByRole("button", { name: "닫기" });
    // 다른 대화상자와 같은 기본 닫기(X) 모양 — 잠금만 더했다
    expect(closeButton.className).toBe(defaultClose);
    await waitFor(() => expect(closeButton).toBeDisabled());
    await userEvent.keyboard("{Escape}");
    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
    if (!overlay) throw new Error("오버레이가 없다");
    await userEvent.click(overlay);
    expect(screen.getByRole("dialog")).toBe(dialog);

    g.open();
    const opsHandle = within(dialog).getByRole("textbox", { name: "ops 핸들" });
    await waitFor(() => expect(opsHandle).toHaveAccessibleDescription("handle @ops 는 이미 쓰이고 있다"));
    expect(server.bodies("POST")).toHaveLength(2);
    expect(screen.getByText("@fin-bot")).toBeInTheDocument();
    expect(closeButton).toBeEnabled();
    await userEvent.click(closeButton);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it.each([
    [503, "ADAPTER_UNAVAILABLE", "Gateway 에 연결되지 않았습니다"],
    [403, "FORBIDDEN", "Gateway 권한(agents.list)이 없습니다"],
    [504, "TIMEOUT", "Gateway 에서 목록을 가져오지 못했습니다"],
  ])("discover %i(%s) → 「%s」 + 직접 입력 폼 — 토스트·재시도 없음", async (status, code, text) => {
    const server = stubServer({ agents: [dev()], discover: () => apiErr(status, code, "gateway says no") });
    renderPage();
    const dialog = await openDiscover();
    expect(await within(dialog).findByText(text)).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "OpenClaw id" })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "핸들" })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "이름" })).toBeInTheDocument();
    expect(server.count("GET", "/api/v1/agents/discover")).toBe(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("새로 등록할 것이 없으면 그렇게 알리고, 「직접 입력」으로 폼을 연다", async () => {
    stubServer({ agents: [dev()], discover: () => json(200, { agents: [{ providerAgentId: "dev" }] }) });
    renderPage();
    const dialog = await openDiscover();
    expect(await within(dialog).findByText("새로 등록할 에이전트가 없습니다")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "직접 입력" }));
    expect(within(dialog).getByRole("textbox", { name: "OpenClaw id" })).toBeInTheDocument();

    // 닫았다 다시 열면 목록부터
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const reopened = await openDiscover();
    expect(await within(reopened).findByText("새로 등록할 에이전트가 없습니다")).toBeInTheDocument();
  });
});

describe("직접 입력", () => {
  const unavailable = () => apiErr(503, "ADAPTER_UNAVAILABLE", "adapter not configured");

  it("핸들·이름은 OpenClaw id 를 따라 채워지고 손대면 그 값을 쓴다 — 409 면 핸들 칸 아래 서버 message(토스트 없음)", async () => {
    const server = stubServer({
      agents: [dev()],
      discover: unavailable,
      create: (body, fallback) =>
        body.handle === "main-agent"
          ? apiErr(409, "CONFLICT", "handle @main-agent 는 이미 쓰이고 있다")
          : fallback(body),
    });
    renderPage();
    const dialog = await openDiscover();
    const id = await within(dialog).findByRole("textbox", { name: "OpenClaw id" });
    const handle = within(dialog).getByRole("textbox", { name: "핸들" });
    const name = within(dialog).getByRole("textbox", { name: "이름" });
    await userEvent.type(id, "Main Agent");
    expect(handle).toHaveValue("main-agent");
    expect(name).toHaveValue("Main Agent");

    await userEvent.click(within(dialog).getByRole("button", { name: "등록" }));
    await waitFor(() => expect(handle).toHaveAccessibleDescription("handle @main-agent 는 이미 쓰이고 있다"));
    expect(handle).toHaveAttribute("aria-invalid", "true");
    expect(toastError).not.toHaveBeenCalled();

    await userEvent.clear(handle);
    await userEvent.type(handle, "main2");
    expect(within(dialog).queryByText("handle @main-agent 는 이미 쓰이고 있다")).not.toBeInTheDocument();
    await userEvent.type(id, "!");
    expect(handle).toHaveValue("main2");
    expect(name).toHaveValue("Main Agent!");

    await userEvent.click(within(dialog).getByRole("button", { name: "등록" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.bodies("POST")).toEqual([
      { providerAgentId: "Main Agent", handle: "main-agent", name: "Main Agent" },
      { providerAgentId: "Main Agent!", handle: "main2", name: "Main Agent!" },
    ]);
    expect(screen.getByText("@main2")).toBeInTheDocument();
  });

  it("OpenClaw id 칸에 규칙 안내가 있고, 서버가 그 id 를 VALIDATION 으로 거절하면 id 칸 아래에 서버 message(토스트 없음)", async () => {
    const rule =
      "providerAgentId 는 OpenClaw 에이전트 id(영문·숫자로 시작, 영문·숫자·_·-, 64자 이하)여야 한다";
    stubServer({
      agents: [dev()],
      discover: unavailable,
      create: (body, fallback) =>
        body.providerAgentId === "my agent" ? apiErr(400, "VALIDATION", rule) : fallback(body),
    });
    renderPage();
    const dialog = await openDiscover();
    const id = await within(dialog).findByRole("textbox", { name: "OpenClaw id" });
    expect(id).toHaveAccessibleDescription("영문·숫자로 시작, 영문·숫자·_·- (64자 이하)");

    await userEvent.type(id, "my agent");
    await userEvent.click(within(dialog).getByRole("button", { name: "등록" }));
    await waitFor(() => expect(id).toHaveAccessibleDescription(rule));
    expect(id).toHaveAttribute("aria-invalid", "true");
    // 폼 아래 오류로 한 번 더 그리지 않는다
    expect(within(dialog).getAllByText(rule)).toHaveLength(1);
    expect(toastError).not.toHaveBeenCalled();

    // 고치면 지난 서버 오류는 지우고 안내로 돌아간다
    await userEvent.clear(id);
    await userEvent.type(id, "my-agent");
    expect(id).toHaveAccessibleDescription("영문·숫자로 시작, 영문·숫자·_·- (64자 이하)");
  });

  it("이미 등록된 OpenClaw id·규칙 밖 핸들이면 요청하지 않고 폼 안에서 알린다", async () => {
    const server = stubServer({ agents: [dev()], discover: unavailable });
    renderPage();
    const dialog = await openDiscover();
    const id = await within(dialog).findByRole("textbox", { name: "OpenClaw id" });
    const submit = within(dialog).getByRole("button", { name: "등록" });
    await userEvent.type(id, "dev");
    expect(id).toHaveAccessibleDescription("이미 등록된 OpenClaw id 입니다");
    expect(submit).toBeDisabled();

    await userEvent.type(id, "2");
    const handle = within(dialog).getByRole("textbox", { name: "핸들" });
    // 칸 아래 오류 자리는 비어 있는 채로 먼저 있는 polite 라이브 영역 — 오류가 생기면 그 자리에 글이 들어간다
    const live = document.getElementById(`${handle.id}-error`);
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toBeEmptyDOMElement();
    await userEvent.clear(handle);
    await userEvent.type(handle, "Bad Handle");
    expect(handle).toHaveAccessibleDescription("영문 소문자·숫자·_·- 로 2~32자");
    expect(document.getElementById(`${handle.id}-error`)).toBe(live);
    expect(submit).toBeDisabled();
    await userEvent.click(submit);
    expect(server.bodies("POST")).toEqual([]);
  });
});

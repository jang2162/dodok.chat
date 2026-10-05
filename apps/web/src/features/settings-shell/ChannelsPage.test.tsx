import type { Channel } from "@dodok/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ME, channelOf, json, renderRoute, shellGet } from "../../../test/shellApi";

// 「설정 → 채널」 탭(채널 보관 스펙 「웹」 절) — 보관한 채널 목록, admin 이상은 줄마다 「보관 해제」
const OLD = channelOf("old", { name: "old-news", archivedAt: "2027-01-20T00:00:00.000Z" });
const OLDER = channelOf("older", { name: "older-news", archivedAt: "2027-01-10T00:00:00.000Z" });

let role: string;
let archived: Channel[];
let posts: string[];

beforeEach(() => {
  role = "member";
  archived = [OLDER, OLD];
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/auth/me") return json(200, { ...ME, role });
      if (url === "/api/v1/channels?archived=1") return json(200, { channels: archived });
      const m = /^\/api\/v1\/channels\/([^/]+)\/unarchive$/.exec(url);
      if (m?.[1] && init?.method === "POST") {
        posts.push(m[1]);
        const found = archived.find((c) => c.id === m[1]);
        archived = archived.filter((c) => c.id !== m[1]);
        return json(200, { channel: { ...found, archivedAt: null } });
      }
      return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

it("누구나 탭 목록에서 「채널」을 본다", async () => {
  renderRoute("/settings/channels");
  const nav = await screen.findByRole("navigation", { name: "설정" });
  expect(within(nav).getByRole("link", { name: "채널" })).toBeInTheDocument();
});

it("member: 보관한 채널을 최근 보관한 것부터 이름·보관한 날·채널 열기로 — 「보관 해제」는 없다", async () => {
  renderRoute("/settings/channels");
  const list = await screen.findByRole("list", { name: "보관한 채널" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows.map((r) => within(r).getByRole("link").textContent)).toEqual(["#old-news", "#older-news"]);
  expect(within(rows[0] as HTMLElement).getByText(/2027/)).toBeInTheDocument();
  expect(within(rows[0] as HTMLElement).getByRole("link")).toHaveAttribute("href", "/c/old");
  expect(screen.queryByRole("button", { name: /보관 해제/ })).toBeNull();
});

it("admin: 줄마다 「보관 해제」 — 누르면 한 번 보내고 그 줄이 빠진다", async () => {
  role = "admin";
  renderRoute("/settings/channels");
  const button = await screen.findByRole("button", { name: "#old-news 보관 해제" });
  await userEvent.dblClick(button);
  await waitFor(() => expect(screen.queryByRole("link", { name: "#old-news" })).toBeNull());
  expect(posts).toEqual(["old"]);
  expect(screen.getByRole("link", { name: "#older-news" })).toBeInTheDocument();
});

it("보관한 채널이 없으면 「보관된 채널이 없습니다」", async () => {
  archived = [];
  renderRoute("/settings/channels");
  expect(await screen.findByText("보관된 채널이 없습니다")).toBeInTheDocument();
});

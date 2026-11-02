import { type PresenceEntry, WIRE_PROTOCOL } from "@dodok/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { openWire, waitFor, type WireClient } from "./helpers/wire";

// 접속 점의 wire 전달(프로필 스펙 3.3) — 연결 직후 스냅숏, 바뀐 줄만 presence.changed(workspace 룸)

describe("presence over wire", () => {
  let app: App;
  let ownerToken: string;
  let mia: { id: string; token: string };
  const sockets: WireClient[] = [];

  beforeAll(async () => {
    app = await bootTestApp();
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    ownerToken = (await login(app)).token;
    mia = await userWithRole(app, "mia", "member");
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await app.close();
  });

  /** 스냅숏은 connect 와 함께 오므로 듣기를 먼저 단다 */
  async function connect(token: string): Promise<{ socket: WireClient; snapshot: PresenceEntry[] }> {
    const socket = openWire(app, { token, protocol: WIRE_PROTOCOL });
    sockets.push(socket);
    const snap = waitFor(socket, "presence.snapshot");
    return { socket, snapshot: (await snap).entries };
  }

  it("연결하면 그 소켓에 스냅숏(에이전트 줄은 presence.hub 시험이 본다)", async () => {
    const { snapshot } = await connect(ownerToken);
    expect(snapshot).toContainEqual({ kind: "user", id: mia.id, state: "offline" });
  });

  it("presence.update(보임) → 다른 사람에게 online, 숨김 → away", async () => {
    const { socket: watcher } = await connect(ownerToken);
    const { socket: miaSocket } = await connect(mia.token);
    const online = waitFor(watcher, "presence.changed", (p) =>
      p.entries.some((e) => e.id === mia.id && e.state === "online"),
    );
    miaSocket.emit("presence.update", { visible: true });
    await online;
    const away = waitFor(watcher, "presence.changed", (p) =>
      p.entries.some((e) => e.id === mia.id && e.state === "away"),
    );
    miaSocket.emit("presence.update", { visible: false });
    expect((await away).entries).toEqual([{ kind: "user", id: mia.id, state: "away" }]);
  });

  it("[Review Focus 1] 오프라인으로 보이기 — presence.changed·새 스냅숏·people.changed 어디에도 모드·만료가 없다", async () => {
    const { socket: watcher } = await connect(ownerToken);
    const offline = waitFor(watcher, "presence.changed", (p) =>
      p.entries.some((e) => e.id === mia.id && e.state === "offline"),
    );
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const res = await app.fastify.inject({
      method: "PUT",
      url: "/api/v1/me/status",
      headers: { authorization: `Bearer ${mia.token}` },
      payload: { mode: "invisible", modeUntil: until },
    });
    expect(res.statusCode).toBe(200);
    expect((await offline).entries).toEqual([{ kind: "user", id: mia.id, state: "offline" }]);
    const { snapshot } = await connect(ownerToken);
    expect(snapshot.find((e) => e.id === mia.id)).toEqual({ kind: "user", id: mia.id, state: "offline" });
    const people = await app.fastify.inject({
      method: "GET",
      url: "/api/v1/people",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(JSON.stringify(people.json())).not.toMatch(/invisible|statusMode|modeUntil/);
    expect(JSON.stringify(snapshot)).not.toContain(until);
  });
});

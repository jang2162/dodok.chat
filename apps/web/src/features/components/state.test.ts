import { ComponentsV1 } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { iso, msg, uid, USER } from "../../../test/fixtures";
import { itemState, type StateInput } from "./state";

const FUTURE = Date.parse("2999-01-01T00:00:00.000Z");
const CMP = ComponentsV1.parse({
  id: "cmp_1",
  blocks: [{ type: "actions", items: [{ type: "button", id: "ok", label: "확인" }] }],
});

const base: StateInput = {
  message: msg(1, { components: CMP, componentState: { expiresAt: iso(FUTURE), consumed: [] } }),
  connected: true,
  hasSocket: true,
  meId: USER,
  expired: false,
  busy: new Set(),
  allowedUsers: undefined,
  itemId: "ok",
};

describe("itemState", () => {
  it("모두 갖추면 눌린다", () => expect(itemState(base).disabled).toBe(false));
  it("연결이 끊기면 disconnected", () =>
    expect(itemState({ ...base, connected: false }).reason).toBe("disconnected"));
  it("만료되면 expired", () => expect(itemState({ ...base, expired: true }).reason).toBe("expired"));
  it("소비됐으면 consumed", () => {
    const m = msg(1, { components: CMP, componentState: { expiresAt: iso(FUTURE), consumed: ["ok"] } });
    expect(itemState({ ...base, message: m }).reason).toBe("consumed");
  });
  it("reusable 이면 소비돼도 눌린다", () => {
    const m = msg(1, {
      components: { ...CMP, reusable: true },
      componentState: { expiresAt: iso(FUTURE), consumed: ["ok"] },
    });
    expect(itemState({ ...base, message: m }).disabled).toBe(false);
  });
  it("allowedUsers 밖이면 forbidden", () =>
    expect(itemState({ ...base, allowedUsers: [uid(99)] }).reason).toBe("forbidden"));
  it("전송 중이면 busy", () => expect(itemState({ ...base, busy: new Set(["ok"]) }).reason).toBe("busy"));

  it("비활성이면 disabled 도 참이다 — 사유만 있고 눌리는 상태는 없다", () => {
    const s = itemState({ ...base, expired: true });
    expect(s).toEqual({ disabled: true, reason: "expired" });
    expect(itemState(base)).toEqual({ disabled: false });
  });

  it("소켓이 없거나 components.id 가 없으면(서버가 아직 id 를 안 준 카드) disconnected", () => {
    expect(itemState({ ...base, hasSocket: false }).reason).toBe("disconnected");
    const noId = msg(1, {
      components: { ...CMP, id: undefined },
      componentState: { expiresAt: iso(FUTURE), consumed: [] },
    });
    expect(itemState({ ...base, message: noId }).reason).toBe("disconnected");
  });

  it("allowedUsers 안이면 눌리고, 내가 누군지 모르면 forbidden", () => {
    expect(itemState({ ...base, allowedUsers: [USER] }).disabled).toBe(false);
    expect(itemState({ ...base, allowedUsers: [USER], meId: undefined }).reason).toBe("forbidden");
  });

  it("다른 아이템이 소비·전송 중이어도 이 아이템은 눌린다", () => {
    const m = msg(1, { components: CMP, componentState: { expiresAt: iso(FUTURE), consumed: ["other"] } });
    expect(itemState({ ...base, message: m, busy: new Set(["other"]) }).disabled).toBe(false);
  });

  describe("겹치면 먼저 나온 사유 — 연결 → 만료 → 소비 → 권한 → 전송 중", () => {
    const consumed = msg(1, {
      components: CMP,
      componentState: { expiresAt: iso(FUTURE), consumed: ["ok"] },
    });
    const all: StateInput = {
      ...base,
      message: consumed,
      connected: false,
      expired: true,
      allowedUsers: [uid(99)],
      busy: new Set(["ok"]),
    };
    it("다섯이 다 겹치면 disconnected", () => expect(itemState(all).reason).toBe("disconnected"));
    it("연결을 빼면 expired", () => expect(itemState({ ...all, connected: true }).reason).toBe("expired"));
    it("만료까지 빼면 consumed", () =>
      expect(itemState({ ...all, connected: true, expired: false }).reason).toBe("consumed"));
    it("소비까지 빼면 forbidden", () =>
      expect(itemState({ ...all, connected: true, expired: false, message: base.message }).reason).toBe(
        "forbidden",
      ));
    it("권한까지 빼면 busy", () =>
      expect(
        itemState({
          ...all,
          connected: true,
          expired: false,
          message: base.message,
          allowedUsers: undefined,
        }).reason,
      ).toBe("busy"));
  });
});

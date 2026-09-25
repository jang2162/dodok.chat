import type { OpsEvent, OpsEventKind } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { eventOf } from "../../../test/opsServer";
import { eventText, eventTime, formatDowntime } from "./copy";

describe("사건 한 줄 문구 — kind 별 고정 문구", () => {
  it.each([
    ["plugin_down", "플러그인 연결 끊김 (지금도)"],
    ["run_limit", "런 한도 도달"],
    ["ratelimit", "요청 제한 발동"],
    ["bridge_auth_blocked", "브리지 인증 실패가 반복돼 주소를 막음"],
    ["crash_rejection", "처리 안 된 오류"],
    ["crash_exception", "서버가 오류로 종료됨"],
    ["unclean_shutdown", "직전 종료가 비정상"],
    ["disk_low", "디스크 여유 부족"],
  ] as const)("%s → 「%s」", (kind: OpsEventKind, text) => {
    expect(eventText(eventOf(1, { kind, detail: {} }))).toBe(text);
  });

  it("모르는 kind(이 웹보다 새 서버)면 던지지 않고 「알 수 없는 사건 (kind)」 — ×n 은 그대로", () => {
    const future = { ...eventOf(1, { count: 2 }), kind: "future_kind" } as unknown as OpsEvent;
    expect(eventText(future)).toBe("알 수 없는 사건 (future_kind) ×2");
  });

  it("gateway_down 이 열려 있으면 「(지금도)」", () => {
    expect(eventText(eventOf(1, { kind: "gateway_down", detail: { thresholdMs: 60_000 } }))).toBe(
      "Gateway 연결 끊김 (지금도)",
    );
  });

  it("닫힌 끊김은 실제 끊긴 시간 detail.downMs 로 「(n분 동안)」", () => {
    const e = eventOf(1, {
      kind: "gateway_down",
      detail: { thresholdMs: 60_000, downMs: 180_000 },
      resolvedAt: "2026-09-25T01:02:00.000Z",
    });
    expect(eventText(e)).toBe("Gateway 연결 끊김 (3분 동안)");
  });

  it("버전이 바뀜은 from → to", () => {
    const e = eventOf(1, { kind: "gateway_version_changed", detail: { from: "2026.9.4", to: "2026.9.5" } });
    expect(eventText(e)).toBe("Gateway 버전이 바뀜 (2026.9.4 → 2026.9.5)");
  });

  it("검증 안 된 버전은 key 의 버전(gateway:<버전>)", () => {
    const e = eventOf(1, {
      kind: "gateway_version_untested",
      severity: "info",
      key: "gateway:2026.9.5",
      detail: {},
    });
    expect(eventText(e)).toBe("검증 안 된 Gateway 버전 (2026.9.5)");
  });

  it("런 실패는 detail.code — 코드가 없으면 괄호 없이", () => {
    expect(eventText(eventOf(1, { kind: "run_failed", detail: { code: "TIMEOUT" } }))).toBe(
      "런 실패 (TIMEOUT)",
    );
    expect(eventText(eventOf(1, { kind: "run_failed", detail: {} }))).toBe("런 실패");
  });

  it("count 가 1 보다 크면 「×n」, 1 이면 붙이지 않는다", () => {
    expect(eventText(eventOf(1, { kind: "ratelimit", detail: {}, count: 4 }))).toBe("요청 제한 발동 ×4");
    expect(eventText(eventOf(1, { kind: "ratelimit", detail: {}, count: 1 }))).toBe("요청 제한 발동");
  });
});

describe("사건 시각", () => {
  it("끊김은 끊긴 때 = firstAt - detail.thresholdMs (firstAt 은 줄이 열린 때)", () => {
    const e = eventOf(1, {
      kind: "plugin_down",
      detail: { thresholdMs: 60_000 },
      firstAt: "2026-09-25T01:01:00.000Z",
      lastAt: "2026-09-25T01:01:00.000Z",
    });
    expect(eventTime(e)).toBe(Date.parse("2026-09-25T01:00:00.000Z"));
  });

  it("그 밖은 마지막 시각 lastAt", () => {
    const e = eventOf(1, { firstAt: "2026-09-25T01:00:00.000Z", lastAt: "2026-09-25T03:00:00.000Z" });
    expect(eventTime(e)).toBe(Date.parse("2026-09-25T03:00:00.000Z"));
  });
});

describe("끊긴 시간", () => {
  it.each([
    [60_000, "1분"],
    [89_000, "1분"],
    [90_000, "2분"],
    [59 * 60_000, "59분"],
    [60 * 60_000, "1시간"],
    [125 * 60_000, "2시간 5분"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatDowntime(ms)).toBe(text);
  });
});

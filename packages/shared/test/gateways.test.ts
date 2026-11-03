import { describe, expect, it } from "vitest";
import { CreateGatewayBody, DeleteGatewayResult, GatewaySummary, UpdateGatewayBody } from "../src";

const ID = "01a09fc9-d204-7551-89d6-38544d07a101";
const NOW = "2026-10-04T00:00:00Z";

describe("CreateGatewayBody", () => {
  const body = { name: "사무실", url: "wss://gw.example:18789", token: "t" };
  it("ws://·wss:// 주소를 받고 이름 앞뒤 공백을 걷는다", () => {
    expect(CreateGatewayBody.parse({ ...body, name: "  집 " }).name).toBe("집");
    expect(CreateGatewayBody.safeParse({ ...body, url: "ws://127.0.0.1:19001" }).success).toBe(true);
  });
  it("http(s)·주소 아닌 값은 거부한다", () => {
    for (const url of ["http://gw.example", "https://gw.example", "gw.example:18789", ""]) {
      expect(CreateGatewayBody.safeParse({ ...body, url }).success).toBe(false);
    }
  });
  it("사용자 정보(user:pass@)가 든 주소는 거부한다 — 응답·설정 상태에 주소가 그대로 나간다", () => {
    for (const url of [
      "wss://bob:pw@gw.example",
      "wss://bob@gw.example",
      "ws://:pw@127.0.0.1:19001",
      "wss://a%40b@gw.example",
      "WSS://bob:pw@gw.example",
      // WHATWG 파서는 특수 스킴의 : 뒤 슬래시 개수·역슬래시를 너그럽게 받아 모두 wss://bob:pw@gw.example/ 로 읽는다
      "wss:/bob:pw@gw.example",
      "wss:bob:pw@gw.example",
      "wss:\\bob:pw@gw.example",
      "wss:////bob:pw@gw.example",
    ]) {
      expect(CreateGatewayBody.safeParse({ ...body, url }).success, url).toBe(false);
    }
  });
  it("호스트 뒤(경로·쿼리·조각)의 @, IPv6, 대문자 스킴은 받는다", () => {
    for (const url of [
      "wss://gw.example/path@x",
      "wss://gw.example?q=a@b",
      "wss://gw.example#a@b",
      "wss://[::1]:19001",
      "WSS://gw.example:18789",
      // 파서가 \ 에서 호스트를 끊어 호스트 a·경로 /b@gw.example 로 읽는다 — 사용자 정보가 아니다
      "ws://a\\b@gw.example",
    ]) {
      expect(CreateGatewayBody.safeParse({ ...body, url }).success, url).toBe(true);
    }
  });
  it("주소는 입력 그대로 둔다(파서가 정규화한 문자열로 바꾸지 않는다)", () => {
    expect(CreateGatewayBody.parse({ ...body, url: "wss://gw.example:18789" }).url).toBe(
      "wss://gw.example:18789",
    );
  });
  it("이름은 1~32자, 토큰은 비어 있을 수 없다", () => {
    expect(CreateGatewayBody.safeParse({ ...body, name: "x".repeat(32) }).success).toBe(true);
    for (const name of ["x".repeat(33), "   ", ""]) {
      expect(CreateGatewayBody.safeParse({ ...body, name }).success).toBe(false);
    }
    expect(CreateGatewayBody.safeParse({ ...body, token: "" }).success).toBe(false);
    expect(CreateGatewayBody.safeParse({ ...body, token: "   " }).success).toBe(false);
    expect(CreateGatewayBody.parse({ ...body, token: " t " }).token).toBe("t");
  });
});

describe("UpdateGatewayBody", () => {
  it("모든 칸이 선택이고, 빈 토큰은 받는다(바꾸지 않음)", () => {
    expect(UpdateGatewayBody.parse({})).toEqual({});
    expect(UpdateGatewayBody.parse({ token: "" })).toEqual({ token: "" });
    expect(UpdateGatewayBody.parse({ token: "   " })).toEqual({ token: "" });
    expect(UpdateGatewayBody.parse({ enabled: false })).toEqual({ enabled: false });
  });
  it("주소·이름 규칙은 추가와 같다", () => {
    expect(UpdateGatewayBody.safeParse({ url: "http://gw.example" }).success).toBe(false);
    expect(UpdateGatewayBody.safeParse({ url: "wss://bob:pw@gw.example" }).success).toBe(false);
    expect(UpdateGatewayBody.safeParse({ url: "wss:/bob:pw@gw.example" }).success).toBe(false);
    expect(UpdateGatewayBody.safeParse({ name: "" }).success).toBe(false);
  });
});

describe("GatewaySummary", () => {
  const summary = {
    id: ID,
    name: "사무실",
    url: "wss://gw.example",
    enabled: true,
    tokenSet: true,
    ownerUserId: null,
    approved: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
  it("공유 토큰 원문은 싣지 않는다(모르는 키는 걷힌다)", () => {
    expect(GatewaySummary.parse({ ...summary, token: "secret" })).toEqual(summary);
  });
  it("tokenSet 은 늘 true", () => {
    expect(GatewaySummary.safeParse({ ...summary, tokenSet: false }).success).toBe(false);
  });
});

describe("DeleteGatewayResult", () => {
  it("음이 아닌 정수 둘", () => {
    expect(DeleteGatewayResult.parse({ unboundAgents: 2, deletedTokens: 0 })).toEqual({
      unboundAgents: 2,
      deletedTokens: 0,
    });
    expect(DeleteGatewayResult.safeParse({ unboundAgents: -1, deletedTokens: 0 }).success).toBe(false);
  });
});

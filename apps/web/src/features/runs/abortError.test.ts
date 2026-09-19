import { expect, it } from "vitest";
import { WireAckError } from "@/realtime/wire";
import { abortErrorMessage } from "./abortError";

it("run.abort ack 오류 코드별 문구(스펙 5.4·8장)", () => {
  const m = (code: ConstructorParameters<typeof WireAckError>[0]) =>
    abortErrorMessage(new WireAckError(code, "server says"));
  expect(m("NOT_FOUND")).toBe("이미 끝났거나 없는 실행입니다");
  expect(m("FORBIDDEN")).toBe("이 실행을 중지할 권한이 없습니다");
  expect(m("VALIDATION")).toBe("처리할 수 없는 요청입니다");
  expect(m("TIMEOUT")).toBe("서버 응답이 없어 실행을 중지하지 못했습니다");
  expect(m("ADAPTER_UNAVAILABLE")).toBe("Gateway 에 연결되지 않았습니다");
  expect(m("INTERNAL")).toBe("실행을 중지하지 못했습니다 (INTERNAL)");
});

it("wire 오류가 아니면 일반 문구", () => {
  expect(abortErrorMessage(new Error("boom"))).toBe("실행을 중지하지 못했습니다");
  expect(abortErrorMessage("x")).toBe("실행을 중지하지 못했습니다");
});

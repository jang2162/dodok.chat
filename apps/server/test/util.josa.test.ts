import { expect, it } from "vitest";
import { hasFinalConsonant, josa } from "../src/util/josa";

it("핸들의 받침에 따라 조사를 고른다 — 「@dev 이(가)」 처럼 병기하지 않는다", () => {
  expect(josa("@fin", "이", "가")).toBe("이"); // 핀
  expect(josa("@dev", "이", "가")).toBe("가"); // 데브
  expect(josa("@fin", "은", "는")).toBe("은");
  expect(josa("@dev", "을", "를")).toBe("를");
});

it("한글 음절은 종성으로, 숫자는 읽는 소리로, 로마자는 끝소리로 본다", () => {
  expect(hasFinalConsonant("검증 채널")).toBe(true); // 널
  expect(hasFinalConsonant("도구")).toBe(false); // 구
  expect(hasFinalConsonant("agent-1")).toBe(true); // 일
  expect(hasFinalConsonant("agent-2")).toBe(false); // 이
  expect(hasFinalConsonant("tool")).toBe(true); // 툴
  expect(hasFinalConsonant("google")).toBe(true); // 묵음 e — 구글
  expect(hasFinalConsonant("code")).toBe(false); // 코드
  expect(hasFinalConsonant("ops")).toBe(false); // 옵스
});

it("알 수 없는 글자로 끝나면 받침 없는 쪽", () => {
  expect(hasFinalConsonant("")).toBe(false);
  expect(hasFinalConsonant("bot_")).toBe(false);
});

it("여러 핸들을 늘어놓으면 마지막 핸들이 조사를 정한다", () => {
  expect(josa("@dev, @fin", "을", "를")).toBe("을");
  expect(josa("@fin, @dev", "을", "를")).toBe("를");
});

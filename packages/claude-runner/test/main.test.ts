import { describe, expect, it } from "vitest";
import { planCli } from "../src/setup";

// main.ts 의 배선 — main 은 이 계획을 그대로 따른다(usage·help·version·error·token·wizard·load)
const plan = (
  positionals: string[],
  opts: { configExists?: boolean; interactive?: boolean; help?: boolean; version?: boolean } = {},
) =>
  planCli({
    positionals,
    help: opts.help,
    version: opts.version,
    configExists: opts.configExists ?? false,
    interactive: opts.interactive ?? true,
  });

describe("planCli", () => {
  it("설정이 없고 터미널이면 마법사, 있으면(깨졌어도) 그대로 읽는다", () => {
    expect(plan([])).toEqual({ kind: "wizard", confirmOverwrite: false });
    expect(plan([], { configExists: true })).toEqual({ kind: "load" });
    expect(plan([], { configExists: true, interactive: false })).toEqual({ kind: "load" });
  });

  it("터미널이 아니면 마법사 없이 안내를 단 오류", () => {
    expect(plan([], { interactive: false })).toEqual({
      kind: "error",
      message:
        "설정 파일이 없습니다 — --config 경로를 확인하세요\n터미널에서 dodok-runner 를 실행하면 설정을 만듭니다",
    });
    expect(plan(["setup"], { configExists: true, interactive: false })).toEqual({
      kind: "error",
      message: "setup 은 터미널에서 실행하세요",
    });
    expect(plan(["token"], { configExists: true, interactive: false })).toEqual({
      kind: "error",
      message: "token 은 터미널에서 실행하세요",
    });
  });

  it("setup 은 설정이 있어도 마법사(덮기 전에 묻는다), token 은 토큰만", () => {
    expect(plan(["setup"], { configExists: true })).toEqual({ kind: "wizard", confirmOverwrite: true });
    expect(plan(["setup"])).toEqual({ kind: "wizard", confirmOverwrite: true });
    expect(plan(["token"], { configExists: true })).toEqual({ kind: "token" });
    // 설정이 없을 때의 안내는 runTokenCommand 가 한다
    expect(plan(["token"])).toEqual({ kind: "token" });
  });

  it("모르는 하위 명령·인자가 남으면 usage, --help·--version 은 그보다 뒤", () => {
    expect(plan(["start"])).toEqual({ kind: "usage" });
    expect(plan(["setup", "x"])).toEqual({ kind: "usage" });
    expect(plan(["token", "drn_x"])).toEqual({ kind: "usage" });
    expect(plan([], { help: true })).toEqual({ kind: "help" });
    expect(plan(["setup"], { help: true })).toEqual({ kind: "help" });
    expect(plan([], { version: true, interactive: false })).toEqual({ kind: "version" });
  });
});

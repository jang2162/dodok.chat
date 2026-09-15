import { describe, expect, it } from "vitest";
import { ServerBus } from "../src/realtime/bus";

describe("ServerBus", () => {
  it("on 으로 받은 핸들러가 emit 페이로드를 받고, 해제 함수를 부르면 더는 받지 않는다", () => {
    const bus = new ServerBus();
    const got: string[] = [];
    const off = bus.on("system.notice", (p) => got.push(`${p.level}:${p.message}`));
    bus.emit("system.notice", { level: "warn", message: "a" });
    off();
    bus.emit("system.notice", { level: "info", message: "b" });
    expect(got).toEqual(["warn:a"]);
  });
});

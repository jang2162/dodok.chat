import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DodokChannelSection } from "../src/config";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("openclaw.plugin.json", () => {
  it("channelConfigs.dodok.schema 는 config.ts 스키마의 JSON Schema 와 같다 (Gateway 는 매니페스트로 설정을 검증한다)", () => {
    expect(manifest.channelConfigs.dodok.schema).toEqual(
      z.toJSONSchema(DodokChannelSection, { io: "input" }),
    );
  });

  it("id·channels 와 package.json openclaw 블록이 맞물린다", () => {
    expect(manifest.id).toBe("dodok");
    expect(manifest.channels).toEqual(["dodok"]);
    expect(pkg.openclaw.extensions).toEqual(["./dist/index.js"]);
    expect(pkg.openclaw.channel.id).toBe("dodok");
    expect(pkg.openclaw.build.openclawVersion).toBe(pkg.devDependencies.openclaw);
  });

  it("번들 플러그인이라 런타임 dependencies 가 없다 (설치 시 workspace: 의존성을 받으러 가지 않게)", () => {
    expect(pkg.dependencies).toBeUndefined();
  });
});

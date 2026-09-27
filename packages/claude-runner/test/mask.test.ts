import { describe, expect, it } from "vitest";
import { createPathMasker, OUTSIDE_WORKDIR } from "../src/mask";

const ROOT = "/Users/me/proj";
const OUT = OUTSIDE_WORKDIR;

describe("createPathMasker — JSON 이스케이프·URL·콜론 뒤 경로", () => {
  const mask = createPathMasker([ROOT]);

  it("JSON 원문의 \\n·\\t·\\r 바로 뒤 경로도 가린다(리뷰 I1 재현)", () => {
    const raw =
      '{"file_path":"/Users/me/proj/a.md","content":"see\\n/Users/me/proj/b.md\\n/Users/me/.aws/credentials\\t/etc/hosts\\r/opt/x"}';
    const out = mask(raw);
    expect(out).toBe(`{"file_path":"a.md","content":"see\\nb.md\\n${OUT}\\t${OUT}\\r${OUT}"}`);
    expect(out).not.toContain("/Users");
  });

  it("콜론 바로 뒤 경로(ENOENT:/…)는 가리고, URL 의 // 는 그대로", () => {
    expect(mask("ENOENT:/Users/me/x")).toBe(`ENOENT:${OUT}`);
    expect(mask("ENOENT:/Users/me/proj/a.ts")).toBe("ENOENT:a.ts");
    expect(mask("https://example.com/a/b")).toBe("https://example.com/a/b");
  });

  it("file:// URL 의 경로를 가린다", () => {
    expect(mask("file:///Users/me/secret/x.md")).toBe(`file://${OUT}`);
    expect(mask("see file:///Users/me/proj/a.md")).toBe("see file://a.md");
  });

  it("공백이 든 작업 디렉터리는 통째로 상대 경로가 된다", () => {
    const spaced = createPathMasker(["/Users/me/My Project"]);
    expect(spaced("open /Users/me/My Project/notes.md now")).toBe("open notes.md now");
  });
});

describe("createPathMasker.json — 도구 인자(JSON 원문)", () => {
  const mask = createPathMasker([ROOT]);

  it("값 안 문자열을 재귀로 가리고 다시 JSON 으로 — 여러 줄 content·Bash command", () => {
    const args = JSON.stringify({
      file_path: "/Users/me/proj/a.md",
      content: "첫 줄\n/Users/me/proj/b.md\n\t/Users/me/.ssh/id_ed25519",
      edits: [{ old_string: "x\n/opt/secret", new_string: "y" }],
    });
    const out = JSON.parse(mask.json(args)) as Record<string, unknown>;
    expect(out).toEqual({
      file_path: "a.md",
      content: `첫 줄\nb.md\n\t${OUT}`,
      edits: [{ old_string: `x\n${OUT}`, new_string: "y" }],
    });
    const bash = JSON.parse(
      mask.json(JSON.stringify({ command: "cd /Users/me/proj &&\nls /Users/me/Downloads" })),
    ) as { command: string };
    expect(bash.command).toBe(`cd . &&\nls ${OUT}`);
  });

  it("경로 키(file_path·path·notebook_path·cwd)의 값은 공백이 있어도 한 경로로 본다", () => {
    const out = JSON.parse(
      mask.json(JSON.stringify({ file_path: "/Users/me/My Docs/plan.md", path: "/Users/me/proj/sub dir/x" })),
    ) as Record<string, string>;
    expect(out).toEqual({ file_path: OUT, path: "sub dir/x" });
  });

  it("잘린 JSON 은 원문 가림으로 — 이스케이프 뒤 경로도", () => {
    const out = mask.json('{"content":"a\\n/Users/me/.aws/cred');
    expect(out).toBe(`{"content":"a\\n${OUT}`);
  });

  it("값이 작업 디렉터리 자체인 경로 키는 . 으로 — 밖 표지가 아니다", () => {
    expect(JSON.parse(mask.json(JSON.stringify({ cwd: ROOT, path: `${ROOT}/` })))).toEqual({
      cwd: ".",
      path: ".",
    });
  });

  it("JSON 키 안의 경로도 가린다(재리뷰 N2)", () => {
    expect(mask.json('{"files":{"/Users/me/.aws/credentials":"x","/Users/me/proj/a.md":"y"}}')).toBe(
      `{"files":{"${OUT}":"x","a.md":"y"}}`,
    );
  });

  it("경로 키 값이 작업 디렉터리로 시작해도 나머지를 본다 — 줄바꿈·공백 뒤 다른 경로(재리뷰 N3)", () => {
    const out = JSON.parse(
      mask.json(
        JSON.stringify({
          file_path: "/Users/me/proj/a\n/Users/me/.ssh/id",
          path: "/Users/me/proj/a /Users/me/.ssh/id /Users/me/proj/b",
        }),
      ),
    ) as Record<string, string>;
    expect(out).toEqual({ file_path: `a\n${OUT}`, path: `a ${OUT} b` });
  });

  it("JSON 이 아닌 값(숫자·불리언·null)은 그대로", () => {
    expect(JSON.parse(mask.json('{"n":1,"b":true,"z":null}'))).toEqual({ n: 1, b: true, z: null });
  });
});

describe("createPathMasker.value — JSON.stringify 전에 값 가림", () => {
  it("객체 안 문자열을 가린다 — stringify 한 뒤 줄바꿈 이스케이프 뒤 경로가 새지 않는다", () => {
    const mask = createPathMasker([ROOT]);
    const text = JSON.stringify(
      mask.value({ out: "done\n/Users/me/.aws/credentials", at: "/Users/me/proj/x" }),
    );
    expect(text).not.toContain("/Users");
    expect(JSON.parse(text)).toEqual({ out: `done\n${OUT}`, at: "x" });
  });

  it("객체 결과의 키 안 경로도 가린다(재리뷰 N2)", () => {
    const mask = createPathMasker([ROOT]);
    expect(JSON.stringify(mask.value({ "/Users/me/.ssh/id": 1 }))).toBe(`{"${OUT}":1}`);
  });
});

describe("createPathMasker.safeCut — 스트리밍 글은 어디까지 가려 내보내도 되나", () => {
  const mask = createPathMasker([ROOT]);

  it("마지막 공백(줄바꿈 포함)까지 — 그 뒤 꼬리는 경로의 앞부분일 수 있어 쥔다", () => {
    expect(mask.safeCut("see /Users/me/pr")).toBe(4);
    expect(mask.safeCut("줄\n/Users")).toBe(2);
    expect(mask.safeCut("공백없음")).toBe(0);
    expect(mask.safeCut("끝 ")).toBe(2);
  });

  it("공백이 든 작업 디렉터리의 앞부분으로 끝나면 그 앞에서 자른다", () => {
    const spaced = createPathMasker(["/Users/me/My Project"]);
    expect(spaced.safeCut("open /Users/me/My ")).toBe(5);
    expect(spaced.safeCut("open /Users/me/Myth ")).toBe(20);
  });
});

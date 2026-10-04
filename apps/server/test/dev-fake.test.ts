import {
  type Attachment,
  type ClientToServerEvents,
  ComponentsV1,
  type Field,
  type InboundDeliver,
  type Message,
  PushPayload,
  type RunEvent,
  type RunnerApprovalResolve,
  type RunState,
  type ServerToClientEvents,
  WIRE_PROTOCOL,
} from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEV_FAKE_DISK_PATH,
  DEV_FAKE_GATEWAY_PATH,
  DEV_FAKE_LOCAL_TOKEN,
  DEV_FAKE_KEYWORDS,
  DEV_FAKE_MEMBER_DISPLAY_NAME,
  DEV_FAKE_MEMBER_EMAIL,
  DEV_FAKE_MEMBER_HANDLE,
  DEV_FAKE_MEMBER_PASSWORD,
  DEV_FAKE_OPS_EVENT_PATH,
  DEV_FAKE_PLUGIN_CAPABILITIES_PATH,
  DEV_FAKE_PLUGIN_TOKEN_PATH,
  DEV_FAKE_RUNNER_LABEL,
  DEV_FAKE_RUNNER_PATH,
  DEV_FAKE_RUNNER_TOKEN,
  type DevFake,
  devFakeCliOptions,
  fakeAgentScript,
  fakeRunnerScript,
  RUNNER_APPROVAL_COMMAND,
  DEV_FAKE_GATEWAY_ID,
  RUNNER_POST_TEXT,
  startDevFake,
} from "../scripts/dev-fake";
import type { App } from "../src/app";
import { findItem, formatInteractionText } from "../src/modules/components/interact";
import { agents, runnerTokens, runs, users } from "../src/db/schema.sqlite";
import { normalizeEmail } from "../src/modules/members/accept";
import { DISCONNECT_EVENT_MS } from "../src/modules/ops/health";
import type { FakeRunnerRun } from "./fakes/fake-runner";
import type { ScenarioApproval } from "./fakes/scenario";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { makePng } from "./helpers/png";
import { openclawDetail, openclawOf } from "./helpers/openclaw";

type Author = { type: "user" | "agent"; handle: string };

/** 대본이 읽는 필드만 채운다 — 채널 참여자는 owner·dev·fin, self 는 isSelf */
const delivery = (
  text: string,
  author: Author,
  self = "dev",
  agents: string[] = ["dev", "fin"],
  attachments: Array<Partial<Attachment>> = [],
): InboundDeliver =>
  ({
    message: { text, author: { ...author, displayName: author.handle }, attachments },
    context: {
      participants: [
        { type: "user", handle: "owner", displayName: "owner", isSelf: false },
        ...agents.map((h) => ({ type: "agent", handle: h, displayName: h, isSelf: h === self })),
      ],
    },
  }) as unknown as InboundDeliver;

describe("devFakeCliOptions", () => {
  it("진입점이 startDevFake 에 넘길 옵션 — APP_ORIGIN 이 있으면 그 오리진(5173 을 다른 프로젝트가 쓸 때 5180 으로), 없거나 비었으면 http://localhost:5173", () => {
    expect(
      devFakeCliOptions({ APP_ORIGIN: "http://localhost:5180", PORT: "3100" }, [
        "node",
        "dev-fake.ts",
        "--keep",
      ]),
    ).toMatchObject({ appOrigin: "http://localhost:5180", port: 3100, keep: true });
    expect(devFakeCliOptions({}, [])).toMatchObject({
      appOrigin: "http://localhost:5173",
      port: 3000,
      keep: false,
    });
    expect(devFakeCliOptions({ APP_ORIGIN: "", PORT: "" }, []).appOrigin).toBe("http://localhost:5173");
    // 데이터는 저장소 루트 data/ 에 — 워크트리마다 따로
    expect(devFakeCliOptions({}, []).dataDir).toMatch(/[/\\]data$/);
  });

  it("리슨 주소는 DEV_FAKE_HOST(컨테이너의 devfake 타깃은 0.0.0.0), 없거나 비었으면 127.0.0.1", () => {
    expect(devFakeCliOptions({ DEV_FAKE_HOST: "0.0.0.0" }, []).host).toBe("0.0.0.0");
    expect(devFakeCliOptions({}, []).host).toBe("127.0.0.1");
    expect(devFakeCliOptions({ DEV_FAKE_HOST: "" }, []).host).toBe("127.0.0.1");
  });

  it("끊김 사건 임계는 DODOK_DEVFAKE_DISCONNECT_MS(양의 정수 ms), 없거나 비었으면 운영과 같은 60초", () => {
    expect(devFakeCliOptions({ DODOK_DEVFAKE_DISCONNECT_MS: "5000" }, []).disconnectEventMs).toBe(5_000);
    expect(devFakeCliOptions({}, []).disconnectEventMs).toBe(DISCONNECT_EVENT_MS);
    expect(devFakeCliOptions({ DODOK_DEVFAKE_DISCONNECT_MS: "" }, []).disconnectEventMs).toBe(
      DISCONNECT_EVENT_MS,
    );
    for (const bad of ["0", "-1", "1.5", "abc"])
      expect(() => devFakeCliOptions({ DODOK_DEVFAKE_DISCONNECT_MS: bad }, [])).toThrow(
        /DODOK_DEVFAKE_DISCONNECT_MS/,
      );
  });
});

describe("fakeAgentScript", () => {
  const owner: Author = { type: "user", handle: "owner" };

  it("받은 글을 @ 없이 인용해 답하고, 델타를 이어 붙이면 답이 된다", () => {
    const s = fakeAgentScript("dev", delivery("@dev 안녕", owner));
    expect(s.reply).toContain("잘 받았어요");
    expect(s.reply).not.toContain("@dev");
    expect(s.deltas?.length).toBeGreaterThanOrEqual(3);
    expect(s.deltas?.length).toBeLessThanOrEqual(6);
    expect((s.deltas ?? []).join("")).toBe(s.reply);
    expect(s.deltaDelayMs).toBe(150);
    expect(s.fail).toBeUndefined();
    expect(s.drop).toBeUndefined();
    expect(s.tool).toBeUndefined();
  });

  it("다른 에이전트 멘션과 보낸 에이전트를 답에 싣는다(릴레이)", () => {
    expect(fakeAgentScript("dev", delivery("@dev @fin 에게 전해줘", owner)).reply).toContain("@fin");
    expect(
      fakeAgentScript("fin", delivery("잘 받았어요 @fin", { type: "agent", handle: "dev" }, "fin")).reply,
    ).toContain("@dev");
  });

  it("채널 참여 에이전트만 부른다 — 자기·채널 밖 핸들은 싣지 않고, 핸들이 providerAgentId 와 달라도 된다", () => {
    const reply = fakeAgentScript(
      "dev",
      delivery("@devbot @ghost @owner 안녕", owner, "devbot", ["devbot", "fin"]),
    ).reply;
    expect(reply).not.toMatch(/@(devbot|ghost|owner)\b/);
    expect(reply).not.toContain("@fin");
    expect(
      fakeAgentScript("dev", delivery("@devbot @fin 둘 다", owner, "devbot", ["devbot", "fin"])).reply,
    ).toContain("@fin");
  });

  it("긴 글·서로게이트 쌍도 코드 포인트 단위로 자르고 나눈다", () => {
    // u 플래그에서 짝이 맞는 서로게이트는 한 코드 포인트라 \p{Cs} 는 외톨이 서로게이트만 잡는다
    const loneSurrogate = /\p{Cs}/u;
    const s = fakeAgentScript("dev", delivery(`@dev ${"😀".repeat(60)}`, owner));
    expect(s.reply).not.toMatch(loneSurrogate);
    for (const delta of s.deltas ?? []) expect(delta).not.toMatch(loneSurrogate);
  });

  it("승인 → 승인 대본 하나, 승인 둘 → 만료 시각이 다른 둘, 승인 항상 → 버튼 셋", () => {
    const one = fakeAgentScript("dev", delivery("@dev 승인", owner)).approval as ScenarioApproval;
    // TTL 20초는 브라우저 검증이 만료까지 볼 수 있게 줄인 값이다(실물 120초)
    expect(one).toMatchObject({
      title: "claude-cli native tool: Write",
      toolName: "Write",
      allowedDecisions: ["allow-once", "deny"],
      ttlMs: 20_000,
    });
    // 이어갈 모양을 고정하지 않는다 — 허용이면 툴 성공, 거절·만료면 툴 오류
    expect(one.onDecision).toBeUndefined();

    const two = fakeAgentScript("dev", delivery("@dev 승인 둘", owner)).approval as ScenarioApproval[];
    expect(two.map((a) => [a.toolName, a.ttlMs])).toEqual([
      ["Write", 20_000],
      ["Read", 60_000],
    ]);

    const always = fakeAgentScript("dev", delivery("@dev 승인 항상", owner)).approval as ScenarioApproval;
    expect(always.allowedDecisions).toEqual(["allow-once", "allow-always", "deny"]);

    expect(fakeAgentScript("dev", delivery("@dev 안녕", owner)).approval).toBeUndefined();
  });

  it("느리게 → 1.5s 간격, 실패 → fail, 드롭 → drop, 도구 → tool", () => {
    expect(fakeAgentScript("dev", delivery("@dev 느리게", owner)).deltaDelayMs).toBe(1_500);
    expect(fakeAgentScript("dev", delivery("@dev 실패", owner)).fail).toBeDefined();
    expect(fakeAgentScript("dev", delivery("@dev 드롭", owner)).drop).toBe("bot-loop-protection");
    expect(fakeAgentScript("dev", delivery("@dev 도구", owner)).tool?.name).toBe("Read");
  });

  it("오래 → 답 길이와 무관하게 약 15초 동안 흐른다(채널·스레드 버블 둘을 동시에 볼 틈), 「느리게」와 함께 와도 오래가 이긴다", () => {
    for (const text of ["@dev 오래", `@dev 오래 ${"가".repeat(200)}`, "@dev 오래 느리게"]) {
      const s = fakeAgentScript("dev", delivery(text, owner));
      expect(s.deltas?.length, text).toBeGreaterThanOrEqual(10);
      expect((s.deltas ?? []).join("")).toBe(s.reply);
      const total = (s.deltaDelayMs ?? 0) * (s.deltas?.length ?? 0);
      expect(total, text).toBeGreaterThanOrEqual(14_000);
      expect(total, text).toBeLessThanOrEqual(16_000);
    }
    expect(DEV_FAKE_KEYWORDS).toContain("오래");
  });

  it("나 불러 → 부른 사람을 평문 @핸들로 부르는 고정 답(인용·릴레이 꼬리 없음), 에이전트가 보냈으면 채널의 첫 사람", () => {
    const s = fakeAgentScript("dev", delivery("@dev @fin 나 불러", owner));
    // 서버가 채널 참여자로 토큰화해 mentions.users 에 owner 를 넣는다 — 푸시 「멘션」 트리거
    expect(s.reply).toBe("@owner 확인해 주세요");
    expect((s.deltas ?? []).join("")).toBe(s.reply);
    expect(fakeAgentScript("dev", delivery("@dev 나 불러", { type: "user", handle: "mina" })).reply).toBe(
      "@mina 확인해 주세요",
    );
    expect(fakeAgentScript("fin", delivery("나 불러", { type: "agent", handle: "dev" }, "fin")).reply).toBe(
      "@owner 확인해 주세요",
    );
    expect(DEV_FAKE_KEYWORDS).toContain("나 불러");
  });

  describe("첨부 키워드 — 이미지 보여줘·보고서 줘·카드에 이미지·미디어만, 사람 첨부 되말하기", () => {
    const script = (text: string, attachments: Array<Partial<Attachment>> = []) =>
      fakeAgentScript("dev", delivery(text, owner, "dev", ["dev", "fin"], attachments));
    const files = (text: string) =>
      (script(text).attachments ?? []).map((a) => ({ name: a.name, mime: a.mime, magic: magicOf(a.bytes) }));

    it("이미지 보여줘 → 「그래프입니다」 + 480×320 PNG chart.png 한 장(무늬가 있어 그려졌는지 눈으로 안다)", () => {
      const s = script("@dev 이미지 보여줘");
      expect(s.reply).toBe("그래프입니다");
      expect((s.deltas ?? []).join("")).toBe(s.reply);
      expect(files("@dev 이미지 보여줘")).toEqual([{ name: "chart.png", mime: "image/png", magic: "png" }]);
      const png = Buffer.from(s.attachments?.[0]?.bytes ?? []);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([480, 320]);
      expect(s.components).toBeUndefined();
    });

    it("보고서 줘 → 「보고서입니다」 + PDF report.pdf 한 개", () => {
      expect(script("@dev 보고서 줘").reply).toBe("보고서입니다");
      expect(files("@dev 보고서 줘")).toEqual([
        { name: "report.pdf", mime: "application/pdf", magic: "pdf" },
      ]);
    });

    it("미디어만 → 글 없는 답 + chart.png 한 장", () => {
      const s = script("@dev 미디어만");
      expect(s.reply).toBe("");
      expect(s.deltas ?? []).toEqual([]);
      expect(files("@dev 미디어만").map((f) => f.name)).toEqual(["chart.png"]);
    });

    it("카드에 이미지 → 「첨부를 가리킨 안내입니다」 + chart.png·월간 보고서.pdf, components 가 두 첨부를 이름으로 가리키고 없는 이름 하나를 둔다(「카드」 카드가 아니다)", () => {
      const s = script("@dev 카드에 이미지");
      expect(s.reply).toBe("첨부를 가리킨 안내입니다");
      expect(files("@dev 카드에 이미지").map((f) => f.name)).toEqual(["chart.png", "월간 보고서.pdf"]);
      const card = ComponentsV1.parse(s.components);
      // 공백은 SafeUrl(`\S+`)을 못 지나 %20 으로 적는다 — 웹 resolveRef 가 디코드해 이름으로 푼다
      const refOf = (url: string | undefined) => decodeURIComponent(url?.replace(/^artifact:\/\//, "") ?? "");
      const media = card.blocks.flatMap((b) => (b.type === "media" ? b.items.map((i) => refOf(i.url)) : []));
      expect(media).toEqual(["chart.png", "없음.png"]);
      const fileBlocks = card.blocks.flatMap((b) => (b.type === "file" ? [b] : []));
      expect(fileBlocks.map((b) => [refOf(b.url), b.name])).toEqual([["월간 보고서.pdf", "월간 보고서"]]);
      const links = card.blocks.flatMap((b) =>
        b.type === "actions"
          ? b.items.flatMap((i) => (i.type === "button" && i.url ? [refOf(i.url)] : []))
          : [],
      );
      expect(links).toEqual(["월간 보고서.pdf"]);
      // 이 카드의 URL 은 모두 artifact:// — 바깥 네트워크 없이 첨부 해석만 본다
      const names = new Set(s.attachments?.map((a) => a.name));
      expect([...media, ...links].filter((n) => names.has(n))).toEqual(["chart.png", "월간 보고서.pdf"]);
    });

    it("첨부 키워드가 없으면 첨부를 싣지 않고, 「카드」는 그대로 블록 카드다", () => {
      expect(script("@dev 안녕").attachments).toBeUndefined();
      expect(script("@dev 카드").attachments).toBeUndefined();
      expect(script("@dev 카드").reply).toContain("잘 받았어요");
    });

    it("사람 첨부가 있으면 대본 앞에 한 줄 — 받은 첨부 수와 첫 이미지 크기, 이미지가 없으면 「첫 이미지 없음」", () => {
      const pdf: Partial<Attachment> = { kind: "file", name: "a.pdf" };
      const img: Partial<Attachment> = { kind: "image", name: "b.png", width: 640, height: 480 };
      const s = script("@dev 안녕", [pdf, img]);
      expect(s.reply.split("\n")[0]).toBe("받은 첨부 2개, 첫 이미지 640×480");
      expect(s.reply).toContain("잘 받았어요");
      expect((s.deltas ?? []).join("")).toBe(s.reply);
      expect(script("@dev 안녕", [pdf]).reply.split("\n")[0]).toBe("받은 첨부 1개, 첫 이미지 없음");
      // 키워드 대본에도 앞에 붙는다
      expect(script("@dev 이미지 보여줘", [img]).reply).toBe(
        "받은 첨부 1개, 첫 이미지 640×480\n\n그래프입니다",
      );
      // 글 없는 대본(「미디어만」)이면 되말하기 줄만 — 끝에 빈 줄을 남기지 않는다
      expect(script("@dev 미디어만", [img]).reply).toBe("받은 첨부 1개, 첫 이미지 640×480");
      // 첨부가 없으면 붙지 않고, 에이전트가 보낸 첨부는 되말하지 않는다(사람 첨부만)
      expect(script("@dev 안녕").reply).not.toContain("받은 첨부");
      expect(
        fakeAgentScript(
          "fin",
          delivery("그래프입니다", { type: "agent", handle: "dev" }, "fin", ["dev", "fin"], [img]),
        ).reply,
      ).not.toContain("받은 첨부");
    });
  });

  describe("components 키워드 — 폼·폼 둘·고르기·카드·재사용·짧게·카드에 이미지", () => {
    const KEYWORDS = ["폼", "폼 둘", "고르기", "카드", "재사용", "짧게", "카드에 이미지"] as const;
    /** 대본이 낸 components 를 플러그인·서버와 같은 스키마로 파싱한다 — 어기면 여기서 던진다 */
    const cardOf = (text: string) =>
      ComponentsV1.parse(fakeAgentScript("dev", delivery(text, owner)).components);
    const fieldTypes = (text: string) => (cardOf(text).modal?.fields ?? []).map((f) => f.type);
    const actionItems = (text: string) =>
      cardOf(text).blocks.flatMap((b) => (b.type === "actions" ? b.items : []));

    it("키워드마다 ComponentsV1 을 통과하는 components 가 나오고, 키워드가 없으면 싣지 않는다", () => {
      for (const keyword of KEYWORDS) {
        const components = fakeAgentScript("dev", delivery(`@dev ${keyword}`, owner)).components;
        expect(components, keyword).toBeDefined();
        expect(ComponentsV1.safeParse(components).success, keyword).toBe(true);
      }
      expect(fakeAgentScript("dev", delivery("@dev 안녕", owner)).components).toBeUndefined();
      // 카드는 답(정본)에 실린다 — 받은 글을 되받는 모양은 그대로다
      expect(fakeAgentScript("dev", delivery("@dev 카드", owner)).reply).toContain("잘 받았어요");
    });

    it("폼 → 모달 필드 5개, 폼 둘 → 다른 모달 — 둘을 합치면 필드 7종이 다 나온다(모달 필드는 5개까지)", () => {
      expect(fieldTypes("@dev 폼")).toEqual(["text", "textarea", "number", "date", "select"]);
      expect(fieldTypes("@dev 폼 둘")).toEqual(["text", "checkbox", "radio"]);
      const all: Field["type"][] = ["text", "textarea", "number", "date", "select", "checkbox", "radio"];
      expect(new Set([...fieldTypes("@dev 폼"), ...fieldTypes("@dev 폼 둘")])).toEqual(new Set(all));
      // 화면 검사를 눈으로 보려면 필수와 기본값이 둘 다 있어야 한다
      for (const text of ["@dev 폼", "@dev 폼 둘"]) {
        const fields = cardOf(text).modal?.fields ?? [];
        expect(fields.some((f) => f.required)).toBe(true);
        expect(fields.some((f) => !f.required)).toBe(true);
        expect(fields.some((f) => f.default !== undefined)).toBe(true);
      }
      expect(cardOf("@dev 폼").modal?.id).not.toBe(cardOf("@dev 폼 둘").modal?.id);
    });

    it("고르기 → 셀렉트 단일 1개 + 다중(최소 2·최대 3) 1개, 다중은 최대보다 옵션이 많고 스크롤 상자가 넘칠 만큼 많다", () => {
      const selects = actionItems("@dev 고르기").filter((i) => i.type === "select");
      expect(selects.map((s) => [s.multi, s.minValues, s.maxValues])).toEqual([
        [false, undefined, undefined],
        [true, 2, 3],
      ]);
      expect(selects[1]?.options.length).toBeGreaterThan(3);
      // 옵션 6개 초과면 스크롤 상자(최대 224px), 한 줄 25px 꼴(c2-t9 실측 8개 = 200px, 안 넘침) — 12개면 약 300px 로 넉넉히 넘친다
      expect(selects[1]?.options.length).toBeGreaterThanOrEqual(12);
    });

    it("카드 → section·separator·actions(버튼 셋 + artifact 링크 버튼)·media(https + artifact)·file(https + artifact)", () => {
      const { blocks } = cardOf("@dev 카드");
      expect(new Set(blocks.map((b) => b.type))).toEqual(
        new Set(["section", "separator", "actions", "media", "file"]),
      );
      expect(actionItems("@dev 카드").map((i) => i.type)).toEqual(["button", "button", "button", "button"]);
      const scheme = (url: string) => url.slice(0, url.indexOf("://"));
      // `artifact://` 가 링크 버튼·media·file 셋에서 같은 문구인지 한 카드에서 보려면 셋 다 artifact 가 있어야 한다
      const linkUrls = actionItems("@dev 카드").flatMap((i) => (i.type === "button" && i.url ? [i.url] : []));
      expect(linkUrls.map(scheme)).toEqual(["artifact"]);
      const mediaUrls = blocks.flatMap((b) => (b.type === "media" ? b.items.map((i) => i.url) : []));
      expect(mediaUrls.map(scheme)).toEqual(["https", "artifact"]);
      const fileUrls = blocks.flatMap((b) => (b.type === "file" ? [b.url] : []));
      expect(fileUrls.map(scheme)).toEqual(["https", "artifact"]);
      // 브라우저 검증이 오프라인이어도 바깥 네트워크를 타지 않게 — https 는 이 기계만 가리킨다
      for (const url of [...mediaUrls, ...fileUrls].filter((u) => u.startsWith("https://"))) {
        expect(new URL(url).hostname).toBe("localhost");
      }
      // 그림이 안 떠도 대체 글로 확인할 수 있게 모든 그림에 alt 가 있다
      for (const b of blocks) if (b.type === "media") for (const i of b.items) expect(i.alt).toBeTruthy();
    });

    it("재사용 → reusable 버튼 + 모달 카드(결과 줄 상한과 모달 제출 뒤 초점을 한 카드에서 본다)", () => {
      expect(cardOf("@dev 재사용").reusable).toBe(true);
      expect(actionItems("@dev 재사용").every((i) => i.type === "button")).toBe(true);
      expect(actionItems("@dev 재사용").length).toBeGreaterThan(0);
      expect(cardOf("@dev 재사용").modal?.fields.length).toBeGreaterThan(0);
      for (const keyword of KEYWORDS.filter((k) => k !== "재사용")) {
        expect(cardOf(`@dev ${keyword}`).reusable, keyword).toBe(false);
      }
    });

    it("짧게 → TTL 20초 카드(버튼·셀렉트·모달이 함께 잠기는 것을 본다), 다른 키워드와 오면 그 카드의 TTL 만 줄인다", () => {
      const short = cardOf("@dev 짧게");
      // 기본 TTL 30분 대신 만료를 눈으로 볼 수 있게 줄였다(승인 대본의 TTL 을 줄인 것과 같은 까닭)
      expect(short.ttlMs).toBe(20_000);
      expect(new Set(actionItems("@dev 짧게").map((i) => i.type))).toEqual(new Set(["button", "select"]));
      expect(short.modal).toBeDefined();
      expect(cardOf("@dev 카드 짧게")).toEqual({ ...cardOf("@dev 카드"), ttlMs: 20_000 });
      for (const keyword of KEYWORDS.filter((k) => k !== "짧게")) {
        expect(cardOf(`@dev ${keyword}`).ttlMs, keyword).toBe(1_800_000);
      }
    });

    it("카드를 누른 상호작용 글(라벨·옵션·제목이 실린다)에는 키워드가 없어 카드·승인을 다시 내지 않는다", () => {
      for (const keyword of KEYWORDS) {
        const components = { ...cardOf(`@dev ${keyword}`), id: "cmp_x" };
        const items = [
          ...components.blocks.flatMap((b) => (b.type === "actions" ? b.items : [])),
          ...(components.modal ? [components.modal] : []),
        ];
        for (const item of items) {
          const found = findItem(components, item.id);
          if (!found) throw new Error(`${keyword}: ${item.id} 를 못 찾는다`);
          const values =
            found.kind === "select"
              ? { values: found.item.options.map((o) => o.value) }
              : found.kind === "modal"
                ? { fields: Object.fromEntries(found.item.fields.map((f) => [f.id, sampleValue(f)])) }
                : {};
          const text = formatInteractionText({ userHandle: "owner", components, found, values });
          const next = fakeAgentScript("dev", delivery(text, owner));
          expect(next.components, `${keyword} → ${item.id}`).toBeUndefined();
          expect(next.approval, `${keyword} → ${item.id}`).toBeUndefined();
          expect(next.fail ?? next.drop ?? next.tool, `${keyword} → ${item.id}`).toBeUndefined();
          expect(next.attachments, `${keyword} → ${item.id}`).toBeUndefined();
        }
      }
    });
  });

  it("대본이 내는 글·라벨·파일 이름에는 어떤 키워드도 없다 — 다른 에이전트가 받거나 사람이 인용해도 대본이 또 나오지 않는다", () => {
    const img: Partial<Attachment> = { kind: "image", name: "b.png", width: 640, height: 480 };
    const pdf: Partial<Attachment> = { kind: "file", name: "a.pdf" };
    const texts = [...DEV_FAKE_KEYWORDS, "안녕"].flatMap((keyword) =>
      [[], [img], [pdf]].flatMap((attachments) => {
        const s = fakeAgentScript(
          "dev",
          delivery(`@dev ${keyword}`, owner, "dev", ["dev", "fin"], attachments),
        );
        // 기본 대본은 받은 글을 「」 안에 되받는다 — 그 인용은 대본 글이 아니다
        return [
          s.reply.replace(/「[^」]*」/g, "「」"),
          ...(s.attachments ?? []).map((a) => a.name),
          ...stringsIn(s.components),
          ...stringsIn(s.approval),
          ...stringsIn(s.tool),
          ...(s.fail === undefined ? [] : [s.fail]),
        ];
      }),
    );
    // 표가 다 들어왔는지 — 첨부 대본 글·파일 이름과 카드 라벨이 실제로 검사 대상에 있다
    expect(texts).toEqual(
      expect.arrayContaining(["그래프입니다", "보고서입니다", "월간 보고서.pdf", "원본 열기"]),
    );
    for (const text of texts) {
      for (const keyword of DEV_FAKE_KEYWORDS)
        expect(text, `${JSON.stringify(text)} ⊃ ${keyword}`).not.toContain(keyword);
    }
  });
});

type RunnerCall =
  | { kind: "text"; delta: string }
  | { kind: "tool"; name: string; args: unknown }
  | { kind: "approval"; toolName: string; summary: string }
  | { kind: "post"; text?: string; components?: unknown }
  | { kind: "final"; text: string; opts: unknown }
  | { kind: "error"; code: string };

/** 가짜 러너의 런 손잡이를 흉내 낸다 — 대본이 부른 순서를 남기고, 승인은 decision 으로 곧바로 답한다 */
async function runRunnerScript(text: string, decision: RunnerApprovalResolve | null = null) {
  const calls: RunnerCall[] = [];
  const run = {
    start: { deliver: delivery(text, { type: "user", handle: "owner" }, "coder", ["coder", "dev"]) },
    runId: "r1",
    isAborted: false,
    aborted: new Promise<void>(() => {}),
    text: (delta: string) => calls.push({ kind: "text", delta }),
    tool: (name: string, args: unknown) => calls.push({ kind: "tool", name, args }),
    approval: async (input: { toolName: string; summary: string }) => {
      calls.push({ kind: "approval", ...input });
      return decision;
    },
    post: async (input: { text?: string; components?: unknown }) => {
      calls.push({ kind: "post", ...input });
      return { ok: true, messageId: "m1" };
    },
    final: (t: string, opts: unknown) => calls.push({ kind: "final", text: t, opts }),
    error: (code: string) => calls.push({ kind: "error", code }),
  } as unknown as FakeRunnerRun;
  // 델타 사이 쉼(150ms~1.5s)을 가짜 시계로 흘린다
  vi.useFakeTimers();
  try {
    const done = fakeRunnerScript(run);
    await vi.runAllTimersAsync();
    await done;
  } finally {
    vi.useRealTimers();
  }
  const final = calls.find((c) => c.kind === "final");
  const streamed = calls.flatMap((c) => (c.kind === "text" ? [c.delta] : [])).join("");
  return { calls, final, streamed };
}

describe("fakeRunnerScript", () => {
  const allow: RunnerApprovalResolve = { providerApprovalId: "p", decision: "allow-once" };

  it("도구(Read)를 먼저 부르고, 델타를 이어 붙이면 최종 답 — fakeAgentScript 와 같은 답·릴레이 꼬리, api 비용", async () => {
    const { calls, final, streamed } = await runRunnerScript("@coder @dev 안녕");
    expect(calls[0]).toMatchObject({ kind: "tool", name: "Read" });
    expect(final).toMatchObject({
      text: streamed,
      opts: { costKind: "api", usage: { inputTokens: 1_200, outputTokens: 80 }, costUsd: 0.02 },
    });
    expect(streamed).toBe(
      fakeAgentScript(
        "coder",
        delivery("@coder @dev 안녕", { type: "user", handle: "owner" }, "coder", ["coder", "dev"]),
      ).reply,
    );
    expect(streamed).toContain("@dev 이어서 부탁해요");
  });

  it("승인 → Bash 승인 요청(작업 디렉터리 상대 명령만), 허용이면 Bash 도구가 돌고 답 첫 줄이 결과, 거절·만료·중지는 도구 없음", async () => {
    const allowed = await runRunnerScript("@coder 승인", allow);
    expect(allowed.calls.find((c) => c.kind === "approval")).toEqual({
      kind: "approval",
      toolName: "Bash",
      summary: `Bash: ${RUNNER_APPROVAL_COMMAND}`,
    });
    expect(`Bash: ${RUNNER_APPROVAL_COMMAND}`.length).toBeLessThanOrEqual(400);
    expect(allowed.calls.filter((c) => c.kind === "tool").map((c) => c.kind === "tool" && c.name)).toEqual([
      "Read",
      "Bash",
    ]);
    expect(allowed.final && allowed.final.kind === "final" && allowed.final.text).toMatch(
      /^허용받아 실행했습니다\.\n\n/,
    );

    const denied = await runRunnerScript("@coder 승인", { providerApprovalId: "p", decision: "deny" });
    expect(denied.calls.filter((c) => c.kind === "tool")).toHaveLength(1);
    expect(denied.streamed).toMatch(/^거절받아 실행하지 않았습니다\./);
    const expired = await runRunnerScript("@coder 승인", {
      providerApprovalId: "p",
      decision: "deny",
      reason: "expired",
    });
    expect(expired.streamed).toMatch(/^기한이 지나 실행하지 않았습니다\./);
    // 중지(approval 이 null) — 더 보내지 않는다. 끝은 가짜 러너가 aborted 로 낸다
    const stopped = await runRunnerScript("@coder 승인", null);
    expect(stopped.calls.map((c) => c.kind)).toEqual(["tool", "approval"]);
  });

  it("게시 → post 로 고정 글 + ComponentsV1 카드, 구독 → subscription_estimate, 실패 → run.error(최종 답 없음)", async () => {
    const posted = await runRunnerScript("@coder 게시");
    const post = posted.calls.find((c) => c.kind === "post");
    expect(post).toMatchObject({ text: RUNNER_POST_TEXT });
    expect(ComponentsV1.safeParse(post?.kind === "post" && post.components).success).toBe(true);
    expect(posted.streamed).toMatch(/^요약을 채널에 올렸습니다\./);

    const sub = await runRunnerScript("@coder 구독");
    expect(sub.final).toMatchObject({ opts: { costKind: "subscription_estimate" } });

    const failed = await runRunnerScript("@coder 실패");
    expect(failed.calls.map((c) => c.kind)).toEqual(["tool", "error"]);
  });

  it("러너 대본이 내는 글·카드 라벨·승인 요약에는 어떤 키워드도 없다", async () => {
    const texts: string[] = [];
    for (const keyword of [...DEV_FAKE_KEYWORDS, "승인 게시"]) {
      for (const decision of [allow, { providerApprovalId: "p", decision: "deny" as const }]) {
        const { calls } = await runRunnerScript(`@coder ${keyword}`, decision);
        for (const c of calls) {
          // 델타는 인용 「」 을 가르므로 이어 붙인 최종 답으로 본다 — 인용은 대본 글이 아니다
          if (c.kind === "final") texts.push(c.text.replace(/「[^」]*」/g, "「」"));
          if (c.kind === "post") texts.push(...stringsIn(c.text), ...stringsIn(c.components));
          if (c.kind === "approval") texts.push(c.summary);
        }
      }
    }
    expect(texts).toEqual(expect.arrayContaining([RUNNER_POST_TEXT, "더 설명해 주세요"]));
    for (const text of texts)
      for (const keyword of DEV_FAKE_KEYWORDS)
        expect(text, `${JSON.stringify(text)} ⊃ ${keyword}`).not.toContain(keyword);
  });
});

/** 값 안의 문자열 잎을 모두 꺼낸다 */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

/** 첨부 바이트의 매직 — 이름·MIME 만 맞고 바이트가 엉뚱하면 서버 스니핑이 다른 종류로 본다 */
function magicOf(bytes: Uint8Array): "png" | "pdf" | "other" {
  const head = Buffer.from(bytes.subarray(0, 8));
  if (head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  return "other";
}

/** 상호작용 글을 만들 때 필드마다 넣는 값 — 옵션 필드는 라벨이 글에 실리게 옵션 값을 고른다 */
function sampleValue(f: Field): unknown {
  switch (f.type) {
    case "select":
      return f.options.map((o) => o.value);
    case "radio":
      return f.options[0]?.value;
    case "checkbox":
      return true;
    case "number":
      return f.min ?? 1;
    case "date":
      return "2026-10-01";
    default:
      return "메모";
  }
}

type WireSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

describe("startDevFake", () => {
  let dir: string;
  let dev: DevFake;
  let sessionToken: string;
  let cookie: string;
  const sockets: WireSocket[] = [];

  async function api<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${dev.url}/api/v1${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** 없으면 등록한다 — 테스트 순서와 무관하게 */
  async function agentId(handle: "dev" | "fin"): Promise<string> {
    const { agents } = await api<{ agents: Array<{ id: string; handle: string }> }>("GET", "/agents");
    const found = agents.find((a) => a.handle === handle);
    if (found) return found.id;
    const { agent } = await api<{ agent: { id: string } }>("POST", "/agents", {
      providerAgentId: handle,
      handle,
      name: handle,
      gatewayId: DEV_FAKE_GATEWAY_ID,
    });
    return agent.id;
  }

  async function channelWith(name: string, handles: Array<"dev" | "fin">): Promise<string> {
    const { channel } = await api<{ channel: { id: string } }>("POST", "/channels", { name });
    for (const handle of handles) {
      await api("POST", `/channels/${channel.id}/members`, {
        memberType: "agent",
        memberId: await agentId(handle),
      });
    }
    return channel.id;
  }

  async function openWire(channelId: string): Promise<WireSocket> {
    const socket: WireSocket = io(dev.url, {
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      auth: { protocol: WIRE_PROTOCOL, token: sessionToken },
    });
    sockets.push(socket);
    const res = await socket.emitWithAck("channel.subscribe", { channelId });
    if (!res.ok) throw new Error(`channel.subscribe → ${res.error.code}`);
    return socket;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-dev-fake-"));
    dev = await startDevFake({ port: 0, dataDir: dir, logLevel: "warn" });
    // /auth/local 은 5회/분 레이트리밋 — 한 번만 로그인해 두 테스트가 같이 쓴다
    const login = await fetch(`${dev.url}/api/v1/auth/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: DEV_FAKE_LOCAL_TOKEN }),
    });
    expect(login.status).toBe(200);
    sessionToken = ((await login.json()) as { sessionToken: string }).sessionToken;
    cookie = `dodok.session=${sessionToken}`;
  });

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await dev?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("고정 토큰으로 로그인 → discover 에 dev·fin → 등록·채널·멤버 → @dev 에 에이전트 답이 온다", async () => {
    const { agents: found } = await api<{ agents: Array<{ providerAgentId: string }> }>(
      "GET",
      `/agents/discover?gatewayId=${DEV_FAKE_GATEWAY_ID}`,
    );
    expect(found.map((a) => a.providerAgentId).sort()).toEqual(["dev", "fin"]);
    const channelId = await channelWith("t", ["dev"]);
    const devId = await agentId("dev");

    const socket = await openWire(channelId);
    const reply = new Promise<string>((resolve) => {
      socket.on("message.created", ({ message }) => {
        if (message.authorType === "agent") resolve(message.bodyMd);
      });
    });
    const sent = await socket.emitWithAck("message.send", {
      channelId,
      clientMsgId: "c1",
      bodyMd: `<@a:${devId}> 안녕`,
    });
    expect(sent.ok).toBe(true);
    await expect(reply).resolves.toContain("잘 받았어요");
  }, 20_000);

  it("「카드 짧게」 → 플러그인·서버를 지나 블록 다섯 종이 든 카드가 저장되고, 만료는 20초 뒤다", async () => {
    const channelId = await channelWith("cards", ["dev"]);
    const devId = await agentId("dev");
    const socket = await openWire(channelId);
    const card = new Promise<Message>((resolve) => {
      socket.on("message.created", ({ message }) => {
        if (message.authorType === "agent" && message.components) resolve(message);
      });
    });
    const sent = await socket.emitWithAck("message.send", {
      channelId,
      clientMsgId: "c3",
      bodyMd: `<@a:${devId}> 카드 짧게`,
    });
    expect(sent.ok).toBe(true);
    const message = await card;
    expect(message.components?.id).toMatch(/^cmp_/);
    expect(message.components?.ttlMs).toBe(20_000);
    expect(new Set(message.components?.blocks.map((b) => b.type))).toEqual(
      new Set(["section", "separator", "actions", "media", "file"]),
    );
    const ttl = Date.parse(message.componentState?.expiresAt ?? "") - Date.parse(message.createdAt);
    expect(ttl).toBeGreaterThan(19_000);
    expect(ttl).toBeLessThanOrEqual(20_000);
  }, 20_000);

  it("「카드에 이미지」 → 가짜 플러그인이 두 파일을 올리고, 저장된 메시지에 chart.png(480×320)·월간 보고서.pdf 와 카드가 함께 온다", async () => {
    const channelId = await channelWith("media", ["dev"]);
    const devId = await agentId("dev");
    const socket = await openWire(channelId);
    const reply = new Promise<Message>((resolve) => {
      socket.on("message.created", ({ message }) => {
        if (message.authorType === "agent") resolve(message);
      });
    });
    const sent = await socket.emitWithAck("message.send", {
      channelId,
      clientMsgId: "c4",
      bodyMd: `<@a:${devId}> 카드에 이미지`,
    });
    expect(sent.ok).toBe(true);
    const message = await reply;
    expect(message.bodyMd).toBe("첨부를 가리킨 안내입니다");
    expect(message.attachments.map((a) => [a.name, a.kind, a.width, a.height])).toEqual([
      ["chart.png", "image", 480, 320],
      ["월간 보고서.pdf", "file", undefined, undefined],
    ]);
    expect(message.components?.blocks.map((b) => b.type)).toContain("media");
  }, 20_000);

  it("사람이 이미지를 붙여 부르면 답 앞 줄이 받은 첨부 수와 첫 이미지 크기를 되말한다", async () => {
    const channelId = await channelWith("upload", ["dev"]);
    const devId = await agentId("dev");
    const up = await fetch(`${dev.url}/api/v1/attachments?channelId=${channelId}`, {
      method: "POST",
      headers: { cookie, "content-type": "image/png" },
      body: makePng(64, 48),
    });
    expect(up.status).toBe(200);
    const { id } = (await up.json()) as { id: string };
    const socket = await openWire(channelId);
    const reply = new Promise<string>((resolve) => {
      socket.on("message.created", ({ message }) => {
        if (message.authorType === "agent") resolve(message.bodyMd);
      });
    });
    const sent = await socket.emitWithAck("message.send", {
      channelId,
      clientMsgId: "c5",
      bodyMd: `<@a:${devId}> 이거 봐`,
      attachments: [id],
    });
    expect(sent.ok).toBe(true);
    await expect(reply).resolves.toMatch(/^받은 첨부 1개, 첫 이미지 64×48\n/);
  }, 20_000);

  it("@dev @fin 이면 서로 부르다가 릴레이 턴 상한에서 relay_limit 시스템 메시지가 생긴다", async () => {
    const channelId = await channelWith("relay", ["dev", "fin"]);
    // 기본 상한 4 대신 1 로 낮춰 빨리 잰다
    await api("PATCH", `/channels/${channelId}`, { relayPolicy: { maxRelayTurns: 1, allowPairs: "all" } });

    const socket = await openWire(channelId);
    const limit = new Promise<string>((resolve) => {
      socket.on("message.created", ({ message }) => {
        if (message.kind === "system" && message.systemMeta?.kind === "relay_limit") resolve(message.bodyMd);
      });
    });
    const sent = await socket.emitWithAck("message.send", {
      channelId,
      clientMsgId: "c2",
      bodyMd: "@dev @fin 시작",
    });
    expect(sent.ok && sent.data.message.mentions.agents).toHaveLength(2);
    await expect(limit).resolves.toContain("릴레이 한도(1턴)");
  }, 20_000);
});

/** 로그인한 owner 로 REST 를 부른다 — /auth/local 은 5회/분이라 앱마다 한 번만 */
async function loginOwner(url: string): Promise<{ sessionToken: string; ownerId: string; cookie: string }> {
  const res = await fetch(`${url}/api/v1/auth/local`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: DEV_FAKE_LOCAL_TOKEN }),
  });
  expect(res.status).toBe(200);
  const { sessionToken, user } = (await res.json()) as { sessionToken: string; user: { id: string } };
  return { sessionToken, ownerId: user.id, cookie: `dodok.session=${sessionToken}` };
}

async function restAs<T>(
  url: string,
  cookie: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
) {
  const res = await fetch(`${url}/api/v1${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** 닿지 않는 endpoint(push.invalid) — 가짜 발송기라 어차피 나가지 않는다 */
const PUSH_SUB = {
  endpoint: "https://push.invalid/dev-fake-owner",
  keys: {
    p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    auth: "tBHItJI5svbpez7KI4CCXg",
  },
};

describe("startDevFake 푸시 — 「나 불러」", () => {
  let dir: string;
  let dev: DevFake;
  const sent: Array<{ endpoint: string; payload: PushPayload }> = [];
  const sockets: WireSocket[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-dev-fake-push-"));
    dev = await startDevFake({
      port: 0,
      dataDir: dir,
      logLevel: "warn",
      pushSend: async (sub, body) => {
        sent.push({ endpoint: sub.endpoint, payload: PushPayload.parse(JSON.parse(body)) });
        return { statusCode: 201 };
      },
    });
  });

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await dev?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("「나 불러」 → 에이전트 답의 mentions.users 에 owner, 채널을 보고 있지 않은 owner 의 구독으로 멘션 푸시 한 건", async () => {
    const { sessionToken, ownerId, cookie } = await loginOwner(dev.url);
    await restAs(dev.url, cookie, "POST", "/push/subscriptions", PUSH_SUB);
    const { agent } = await restAs<{ agent: { id: string } }>(dev.url, cookie, "POST", "/agents", {
      providerAgentId: "dev",
      handle: "dev",
      name: "dev",
      gatewayId: DEV_FAKE_GATEWAY_ID,
    });
    const { channel } = await restAs<{ channel: { id: string } }>(dev.url, cookie, "POST", "/channels", {
      name: "push",
    });
    await restAs(dev.url, cookie, "POST", `/channels/${channel.id}/members`, {
      memberType: "agent",
      memberId: agent.id,
    });

    // presence 를 알리지 않은 소켓은 「보고 있음」이 아니다 — 푸시가 간다
    const socket: WireSocket = io(dev.url, {
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      auth: { protocol: WIRE_PROTOCOL, token: sessionToken },
    });
    sockets.push(socket);
    const subscribed = await socket.emitWithAck("channel.subscribe", { channelId: channel.id });
    expect(subscribed.ok).toBe(true);
    const reply = new Promise<Message>((resolve) => {
      socket.on("message.created", ({ message }) => {
        if (message.authorType === "agent") resolve(message);
      });
    });
    const sentMsg = await socket.emitWithAck("message.send", {
      channelId: channel.id,
      clientMsgId: "call-me",
      bodyMd: `<@a:${agent.id}> 나 불러`,
    });
    expect(sentMsg.ok).toBe(true);

    const message = await reply;
    expect(message.mentions.users).toEqual([ownerId]);
    expect(message.bodyMd).toBe(`<@u:${ownerId}> 확인해 주세요`);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      endpoint: PUSH_SUB.endpoint,
      payload: {
        kind: "mention",
        channelId: channel.id,
        title: "dodok",
        body: "@dev가 #push에서 불렀습니다",
        url: `/c/${channel.id}`,
        tag: `mention:${channel.id}`,
      },
    });
  }, 20_000);
});

describe("startDevFake VAPID", () => {
  let dir: string;
  const running: DevFake[] = [];
  const noSend: NonNullable<Parameters<typeof startDevFake>[0]>["pushSend"] = async () => ({
    statusCode: 201,
  });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dodok-dev-fake-vapid-"));
  });

  afterAll(async () => {
    for (const dev of running.splice(0)) await dev.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(): Promise<DevFake> {
    const dev = await startDevFake({ port: 0, dataDir: dir, logLevel: "warn", pushSend: noSend });
    running.push(dev);
    return dev;
  }

  it("<dataDir>/vapid.json 은 시작마다 새로 만들지 않는다 — dev-fake.sqlite 는 새로 만들어도 키는 그대로(구독이 무효가 되지 않게)", async () => {
    const vapidPath = join(dir, "vapid.json");
    const first = await boot();
    const saved = readFileSync(vapidPath, "utf8");
    expect(statSync(vapidPath).mode & 0o777).toBe(0o600);
    const a = await loginOwner(first.url);
    await restAs(first.url, a.cookie, "POST", "/channels", { name: "before-restart" });
    const firstKey = await restAs<{ publicKey: string }>(
      first.url,
      a.cookie,
      "GET",
      "/push/vapid-public-key",
    );
    await first.close();
    running.splice(0);

    const second = await boot();
    const b = await loginOwner(second.url);
    // DB 는 새것 — 앞 실행의 채널이 없다
    const { channels } = await restAs<{ channels: Array<{ name: string }> }>(
      second.url,
      b.cookie,
      "GET",
      "/channels",
    );
    expect(channels.map((c) => c.name)).not.toContain("before-restart");
    // 키는 그대로 — 파일 내용도, 브라우저가 구독에 쓰는 공개 키도
    expect(readFileSync(vapidPath, "utf8")).toBe(saved);
    const secondKey = await restAs<{ publicKey: string }>(
      second.url,
      b.cookie,
      "GET",
      "/push/vapid-public-key",
    );
    expect(secondKey.publicKey).toBe(firstKey.publicKey);
    expect(secondKey.publicKey).toBe((JSON.parse(saved) as { publicKey: string }).publicKey);
  }, 30_000);
});

describe("startDevFake host", () => {
  let dir: string;
  const running: DevFake[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dodok-dev-fake-host-"));
  });

  afterAll(async () => {
    for (const dev of running.splice(0)) await dev.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const listenAddress = (dev: DevFake) => (dev.app.fastify.server.address() as AddressInfo).address;

  it("host 를 안 주면 127.0.0.1 에서만 듣는다", async () => {
    const dev = await startDevFake({ port: 0, dataDir: dir, logLevel: "warn" });
    running.push(dev);
    expect(listenAddress(dev)).toBe("127.0.0.1");
  }, 20_000);

  it("host 0.0.0.0 이면 모든 주소에서 듣고, 가짜 플러그인은 그래도 127.0.0.1 로 붙는다(어댑터가 bridge connected 까지 간다)", async () => {
    const dev = await startDevFake({ port: 0, dataDir: dir, logLevel: "warn", host: "0.0.0.0" });
    running.push(dev);
    expect(listenAddress(dev)).toBe("0.0.0.0");
    expect(dev.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${dev.url}/healthz`)).status).toBe(200);
  }, 20_000);
});

describe("startDevFake appOrigin", () => {
  let dir: string;
  let dev: DevFake;
  let sessionToken: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-dev-fake-origin-"));
    dev = await startDevFake({ port: 0, dataDir: dir, logLevel: "warn", appOrigin: "http://localhost:5180" });
    const login = await fetch(`${dev.url}/api/v1/auth/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: DEV_FAKE_LOCAL_TOKEN }),
    });
    expect(login.status).toBe(200);
    sessionToken = ((await login.json()) as { sessionToken: string }).sessionToken;
  });

  afterAll(async () => {
    await dev?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 브라우저처럼 토큰 없이 Origin·세션 쿠키로만 붙는다 */
  const openWithCookie = (origin: string) =>
    new Promise<{ ok: true } | { ok: false; code: string }>((resolve) => {
      const socket: WireSocket = io(dev.url, {
        transports: ["websocket"],
        reconnection: false,
        forceNew: true,
        auth: { protocol: WIRE_PROTOCOL },
        // Node 전송(ws)은 extraHeaders 를 웹소켓 핸드셰이크 헤더로 싣는다
        extraHeaders: { origin, cookie: `dodok.session=${sessionToken}` },
      });
      socket.on("connect", () => {
        socket.close();
        resolve({ ok: true });
      });
      socket.on("connect_error", (err) => {
        socket.close();
        resolve({ ok: false, code: (err as unknown as { data?: { code: string } }).data?.code ?? "?" });
      });
    });

  it("appOrigin 5180 이면 5180 쿠키 핸드셰이크가 붙고 5173 은 UNAUTHORIZED — 5173 이 차 있을 때 웹을 5180 에 띄울 수 있다", async () => {
    await expect(openWithCookie("http://localhost:5180")).resolves.toEqual({ ok: true });
    await expect(openWithCookie("http://localhost:5173")).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
    });
  }, 20_000);
});

describe("startDevFake 가짜 플러그인 토큰 바꾸기 — POST /__devfake/plugin-token", () => {
  let dir: string;
  let dev: DevFake;
  let cookie: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-dev-fake-token-"));
    dev = await startDevFake({ port: 0, dataDir: dir, logLevel: "warn" });
    const login = await fetch(`${dev.url}/api/v1/auth/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: DEV_FAKE_LOCAL_TOKEN }),
    });
    expect(login.status).toBe(200);
    cookie = `dodok.session=${((await login.json()) as { sessionToken: string }).sessionToken}`;
  });

  afterAll(async () => {
    await dev?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const swap = (body: unknown, headers: Record<string, string> = { cookie }) =>
    fetch(`${dev.url}${DEV_FAKE_PLUGIN_TOKEN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  async function issue(label: string): Promise<{ token: string; id: string }> {
    const res = await fetch(`${dev.url}/api/v1/gateways/${DEV_FAKE_GATEWAY_ID}/bridge-tokens`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
    expect(res.status).toBe(201);
    const { token, record } = (await res.json()) as { token: string; record: { id: string } };
    return { token, id: record.id };
  }

  const connectedTokenId = () => openclawDetail(openclawOf(dev.app)).bridge.plugin?.tokenId;

  it("세션이 없으면 401 이고 가짜 플러그인은 그대로 붙어 있다", async () => {
    const before = connectedTokenId();
    expect(before).toBeTruthy();
    const res = await swap({ token: "whatever" }, {});
    expect(res.status).toBe(401);
    expect(connectedTokenId()).toBe(before);
  });

  it("본문에 token 이 없으면 400", async () => {
    const res = await swap({});
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "VALIDATION" });
    expect((await swap({ token: "" })).status).toBe(400);
  });

  it("DB 로 발급한 새 토큰으로 바꾸면 { ok: true } 이고 붙은 플러그인의 tokenId 가 그 행이다", async () => {
    const issued = await issue("rotate");
    const res = await swap({ token: issued.token });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(connectedTokenId()).toBe(issued.id);
  }, 20_000);

  it("폐기한 토큰으로 바꾸면 { ok: false, reason } — 새 토큰으로 다시 바꾸면 돌아온다", async () => {
    const old = await issue("old");
    await expect((await swap({ token: old.token })).json()).resolves.toEqual({ ok: true });
    const revoke = await fetch(`${dev.url}/api/v1/gateways/${DEV_FAKE_GATEWAY_ID}/bridge-tokens/${old.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(revoke.status).toBe(204);

    const res = await swap({ token: old.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("UNAUTHORIZED");
    expect(openclawDetail(openclawOf(dev.app)).bridge.plugin).toBeFalsy();

    const fresh = await issue("fresh");
    await expect((await swap({ token: fresh.token })).json()).resolves.toEqual({ ok: true });
    expect(connectedTokenId()).toBe(fresh.id);
  }, 20_000);

  it("그 밖의 경로는 앱이 그대로 받는다", async () => {
    const res = await fetch(`${dev.url}/api/v1/setup/status`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });
});

describe("startDevFake 운영 훅 — /__devfake/ops/event·gateway·disk", () => {
  const DISCONNECT_MS = 300;
  let dir: string;
  let dev: DevFake;
  let cookie: string;
  let memberAuth: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-dev-fake-ops-"));
    dev = await startDevFake({ port: 0, dataDir: dir, logLevel: "warn", disconnectEventMs: DISCONNECT_MS });
    const login = await fetch(`${dev.url}/api/v1/auth/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: DEV_FAKE_LOCAL_TOKEN }),
    });
    expect(login.status).toBe(200);
    cookie = `dodok.session=${((await login.json()) as { sessionToken: string }).sessionToken}`;
    memberAuth = `Bearer ${(await userWithRole(dev.app, "member1", "member")).token}`;
  });

  afterAll(async () => {
    await dev?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = { cookie, "content-type": "application/json" },
  ) => fetch(`${dev.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  const events = (kind: string) => dev.app.ops.list({ limit: 100 }).events.filter((e) => e.kind === kind);

  describe.each([
    // 빈 토큰(400) — 가드를 지난 호출이 실제로 토큰을 바꿔 가짜 플러그인을 끊지 않게
    [DEV_FAKE_PLUGIN_TOKEN_PATH, { token: "" }],
    [DEV_FAKE_OPS_EVENT_PATH, { kind: "ratelimit", key: "guard", severity: "warn" }],
    [DEV_FAKE_GATEWAY_PATH, { state: "connected" }],
    [DEV_FAKE_DISK_PATH, { reset: true }],
    // 되돌림(true) — 가드를 지난 호출이 옛 플러그인으로 바꿔 두지 않게
    [DEV_FAKE_PLUGIN_CAPABILITIES_PATH, { threads: true }],
    // 이미 붙어 있으면 그대로 — 가드를 지난 호출이 가짜 러너를 끊지 않게
    [DEV_FAKE_RUNNER_PATH, { connected: true }],
  ] as const)("%s 공통 가드", (path, body) => {
    it("세션 없음 401 · member 403 — 앱의 requireOwner 응답 그대로", async () => {
      const anon = await post(path, body, { "content-type": "application/json" });
      expect(anon.status).toBe(401);
      await expect(anon.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
      const member = await post(path, body, {
        authorization: memberAuth,
        "content-type": "application/json",
      });
      expect(member.status).toBe(403);
      await expect(member.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    });

    it("content-type 이 application/json 이 아니면 415 — CORS preflight 없는 단순 요청으로 부를 수 없다", async () => {
      const plain = await post(path, body, { cookie, "content-type": "text/plain" });
      expect(plain.status).toBe(415);
      await expect(plain.json()).resolves.toMatchObject({ code: "VALIDATION" });
      const none = await fetch(`${dev.url}${path}`, { method: "POST", headers: { cookie } });
      expect(none.status).toBe(415);
      // 매개변수가 붙은 JSON 은 받는다
      const charset = await post(path, body, { cookie, "content-type": "application/json; charset=utf-8" });
      expect(charset.status).not.toBe(415);
    }, 20_000);

    it("경로는 정확히 일치해야 한다 — 꼬리·접미·대소문자·GET 은 앱의 404", async () => {
      for (const variant of [`${path}X`, `${path}/`, path.toUpperCase()])
        expect((await post(variant, body)).status).toBe(404);
      expect((await fetch(`${dev.url}${path}`, { headers: { cookie } })).status).toBe(404);
    });
  });

  it("ops/event — app.ops.record 로 남긴다: 사건 목록·unacked 에 곧바로 보이고, 같은 kind·key 는 묶인다", async () => {
    const before = dev.app.ops.unacked();
    const res = await post(DEV_FAKE_OPS_EVENT_PATH, {
      kind: "bridge_auth_blocked",
      key: "ip:127.0.0",
      severity: "error",
      detail: { ipPrefix: "127.0.0", failures: 10 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; event: { id: string; count: number } };
    expect(body).toMatchObject({
      ok: true,
      event: { kind: "bridge_auth_blocked", key: "ip:127.0.0", severity: "error", count: 1 },
    });
    expect(dev.app.ops.unacked().error).toBe(before.error + 1);
    const again = await post(DEV_FAKE_OPS_EVENT_PATH, {
      kind: "bridge_auth_blocked",
      key: "ip:127.0.0",
      severity: "error",
    });
    await expect(again.json()).resolves.toMatchObject({ event: { id: body.event.id, count: 2 } });
    const listed = await fetch(`${dev.url}/api/v1/ops/events`, { headers: { cookie } });
    const { events: rows } = (await listed.json()) as { events: Array<{ id: string; count: number }> };
    expect(rows).toContainEqual(expect.objectContaining({ id: body.event.id, count: 2 }));
  });

  it("ops/event — 모르는 kind·severity·빈 key·중첩 detail 은 400(VALIDATION), 사건을 남기지 않는다", async () => {
    const count = () => dev.app.ops.list({ limit: 100 }).events.length;
    const before = count();
    for (const bad of [
      { kind: "nope", key: "k", severity: "warn" },
      { kind: "ratelimit", key: "k", severity: "fatal" },
      { kind: "ratelimit", key: "", severity: "warn" },
      { kind: "ratelimit", key: "k", severity: "warn", detail: { nested: { a: 1 } } },
      { kind: "ratelimit", key: "x".repeat(201), severity: "warn" },
    ]) {
      const res = await post(DEV_FAKE_OPS_EVENT_PATH, bad);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code: "VALIDATION" });
    }
    expect(count()).toBe(before);
  });

  it("disk — 값을 주면 곧바로 다시 재 error 면 disk_low(error)·업로드 507, reset 이면 실제 statfs 로 돌아간다", async () => {
    const MIB = 1024 * 1024;
    const res = await post(DEV_FAKE_DISK_PATH, { freeBytes: 100 * MIB, totalBytes: 10_000 * MIB });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      disk: { level: "error", freeBytes: 100 * MIB, totalBytes: 10_000 * MIB },
    });
    expect(dev.app.disk().level).toBe("error");
    expect(events("disk_low")).toEqual([
      expect.objectContaining({ key: "data", severity: "error", detail: { freeBytes: 100 * MIB } }),
    ]);
    const upload = await fetch(`${dev.url}/api/v1/attachments`, {
      method: "POST",
      headers: { cookie, "content-type": "image/png", "x-dodok-filename": "a.png" },
      body: new Uint8Array(makePng(4, 4, [0, 0, 0])),
    });
    expect(upload.status).toBe(507);

    const reset = await post(DEV_FAKE_DISK_PATH, { reset: true });
    expect(reset.status).toBe(200);
    const { disk } = (await reset.json()) as { disk: { level: string; freeBytes?: number } };
    expect(disk.freeBytes).not.toBe(100 * MIB);
    expect(dev.app.disk()).toEqual(disk);
  });

  it("disk — 음수·소수·free > total·total 0·reset 과 값 섞기는 400, 디스크 상태는 그대로", async () => {
    const before = dev.app.disk();
    for (const bad of [
      { freeBytes: -1, totalBytes: 10 },
      { freeBytes: 1.5, totalBytes: 10 },
      { freeBytes: 11, totalBytes: 10 },
      { freeBytes: 0, totalBytes: 0 },
      { freeBytes: 1 },
      { reset: false },
      { reset: true, freeBytes: 1, totalBytes: 10 },
    ]) {
      const res = await post(DEV_FAKE_DISK_PATH, bad);
      expect(res.status).toBe(400);
    }
    expect(dev.app.disk()).toEqual(before);
  });

  it("gateway down → 어댑터 status 가 connected 가 아니고 임계 뒤 gateway_down 이 열린다 → connected 면 다시 붙고 사건이 닫힌다", async () => {
    const down = await post(DEV_FAKE_GATEWAY_PATH, { state: "down" });
    expect(down.status).toBe(200);
    const downBody = (await down.json()) as { ok: boolean; status: { gateway: string; bridge: string } };
    expect(downBody.ok).toBe(true);
    expect(downBody.status.gateway).not.toBe("connected");
    expect(downBody.status.bridge).toBe("connected"); // 플러그인은 그대로
    await vi.waitFor(() => expect(events("gateway_down")).toHaveLength(1), { timeout: DISCONNECT_MS * 10 });
    expect(events("gateway_down")[0]?.resolvedAt).toBeUndefined();

    const up = await post(DEV_FAKE_GATEWAY_PATH, { state: "connected" });
    expect(up.status).toBe(200);
    await expect(up.json()).resolves.toMatchObject({ ok: true, status: { gateway: "connected" } });
    expect(events("gateway_down")[0]?.resolvedAt).toBeDefined();
  }, 20_000);

  it("gateway — 오래 끊겨 있었어도 connected 는 몇 초 안에 붙는다(dev:fake 는 재접속 백오프 상한을 줄인다)", async () => {
    await post(DEV_FAKE_GATEWAY_PATH, { state: "down" });
    // 운영 백오프(1s 부터 두 배, ±20%)면 8초 끊긴 뒤 다음 시도는 11초 이후 — 줄인 상한이면 1초 남짓
    await new Promise((r) => setTimeout(r, 8_000));
    const started = Date.now();
    const up = await post(DEV_FAKE_GATEWAY_PATH, { state: "connected" });
    await expect(up.json()).resolves.toMatchObject({ ok: true, status: { gateway: "connected" } });
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 20_000);

  it("gateway — state 가 down·connected 가 아니면 400", async () => {
    expect((await post(DEV_FAKE_GATEWAY_PATH, { state: "up" })).status).toBe(400);
    expect((await post(DEV_FAKE_GATEWAY_PATH, {})).status).toBe(400);
  });
});

describe("startDevFake 스레드 — 스레드 답·스레드 릴레이·동시 스트리밍·옛 플러그인 훅", () => {
  let dir: string;
  let dev: DevFake;
  let cookie: string;
  let sessionToken: string;
  const sockets: WireSocket[] = [];
  const agentIds: Partial<Record<"dev" | "fin", string>> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-dev-fake-threads-"));
    dev = await startDevFake({ port: 0, dataDir: dir, logLevel: "warn" });
    ({ sessionToken, cookie } = await loginOwner(dev.url));
    for (const handle of ["dev", "fin"] as const) {
      const { agent } = await restAs<{ agent: { id: string } }>(dev.url, cookie, "POST", "/agents", {
        providerAgentId: handle,
        handle,
        name: handle,
        gatewayId: DEV_FAKE_GATEWAY_ID,
      });
      agentIds[handle] = agent.id;
    }
  });

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await dev?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const idOf = (handle: "dev" | "fin") => agentIds[handle] ?? "";

  /** 채널을 만들고 에이전트를 넣은 뒤 구독한 wire — 받은 메시지·런 상태·런 이벤트를 도착 순서대로 모은다 */
  async function channelWire(name: string, handles: Array<"dev" | "fin">) {
    const { channel } = await restAs<{ channel: { id: string } }>(dev.url, cookie, "POST", "/channels", {
      name,
    });
    for (const handle of handles) {
      await restAs(dev.url, cookie, "POST", `/channels/${channel.id}/members`, {
        memberType: "agent",
        memberId: idOf(handle),
      });
    }
    const socket: WireSocket = io(dev.url, {
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      auth: { protocol: WIRE_PROTOCOL, token: sessionToken },
    });
    sockets.push(socket);
    const created: Message[] = [];
    const states: RunState[] = [];
    const events: RunEvent[] = [];
    socket.on("message.created", ({ message }) => created.push(message));
    socket.on("run.state", ({ run }) => states.push(run));
    socket.on("run.event", ({ event }) => events.push(event));
    const res = await socket.emitWithAck("channel.subscribe", { channelId: channel.id });
    if (!res.ok) throw new Error(`channel.subscribe → ${res.error.code}`);
    let n = 0;
    const send = async (bodyMd: string, threadRootId?: string): Promise<Message> => {
      const sent = await socket.emitWithAck("message.send", {
        channelId: channel.id,
        clientMsgId: `${name}-${n++}`,
        bodyMd,
        ...(threadRootId === undefined ? {} : { threadRootId }),
      });
      if (!sent.ok) throw new Error(`message.send → ${sent.error.code}`);
      return sent.data.message;
    };
    /** 그 에이전트·그 스레드(없으면 채널)의 런 id, 처음 본 순서 */
    const runIds = (handle: "dev" | "fin", threadRootId?: string) => [
      ...new Set(
        states.filter((s) => s.agentId === idOf(handle) && s.threadRootId === threadRootId).map((s) => s.id),
      ),
    ];
    const terminal = (runId: string) =>
      states.find((s) => s.id === runId && ["done", "error", "aborted"].includes(s.status));
    return { channelId: channel.id, created, states, events, send, runIds, terminal };
  }

  it("스레드에서 @dev → 답이 그 스레드에 저장되고, 그 런은 threadRootId 를 싣고 델타를 흘린다", async () => {
    const w = await channelWire("thread-reply", ["dev"]);
    const root = await w.send("루트 질문");
    await w.send(`<@a:${idOf("dev")}> 스레드에서 봐줘`, root.id);
    const answer = await vi.waitFor(
      () => {
        const found = w.created.find((m) => m.authorType === "agent");
        if (!found) throw new Error("에이전트 답 없음");
        return found;
      },
      { timeout: 15_000 },
    );
    expect(answer.threadRootId).toBe(root.id);
    expect(answer.bodyMd).toContain("잘 받았어요");
    const [runId] = w.runIds("dev", root.id);
    expect(runId).toBeDefined();
    await vi.waitFor(() => expect(w.terminal(runId ?? "")?.status).toBe("done"), { timeout: 15_000 });
    const deltas = w.events.filter((e) => e.runId === runId && e.type === "TEXT_MESSAGE_CONTENT");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(w.runIds("dev")).toEqual([]); // 채널 런은 없다
  }, 20_000);

  it("스레드에서 @dev @fin → 서로 부르는 릴레이가 같은 스레드에서 돌고, 한도 알림(relay_limit)도 그 스레드에", async () => {
    const w = await channelWire("thread-relay", ["dev", "fin"]);
    await restAs(dev.url, cookie, "PATCH", `/channels/${w.channelId}`, {
      relayPolicy: { maxRelayTurns: 1, allowPairs: "all" },
    });
    const root = await w.send("릴레이 루트");
    await w.send(`<@a:${idOf("dev")}> <@a:${idOf("fin")}> 시작`, root.id);
    const limit = await vi.waitFor(
      () => {
        const found = w.created.find((m) => m.kind === "system" && m.systemMeta?.kind === "relay_limit");
        if (!found) throw new Error("relay_limit 없음");
        return found;
      },
      { timeout: 15_000 },
    );
    expect(limit.threadRootId).toBe(root.id);
    const agentReplies = w.created.filter((m) => m.authorType === "agent");
    expect(agentReplies.length).toBeGreaterThanOrEqual(2);
    expect(agentReplies.every((m) => m.threadRootId === root.id)).toBe(true);
    expect(new Set(agentReplies.map((m) => m.authorId))).toEqual(new Set([idOf("dev"), idOf("fin")]));
    expect([...w.runIds("dev"), ...w.runIds("fin")]).toEqual([]); // 채널 최상위 런 없음
  }, 20_000);

  it("「오래」를 채널과 스레드에 연달아 부르면 두 런이 동시에 스트리밍한다 — 채널 런이 끝나기 전에 스레드 런의 델타가 온다", async () => {
    const w = await channelWire("thread-both", ["dev"]);
    const root = await w.send("동시 루트");
    await w.send(`<@a:${idOf("dev")}> 오래`);
    await w.send(`<@a:${idOf("dev")}> 오래`, root.id);
    const [channelRun] = await vi.waitFor(
      () => {
        const ids = w.runIds("dev");
        if (ids.length === 0) throw new Error("채널 런 없음");
        return ids;
      },
      { timeout: 5_000 },
    );
    const [threadRun] = await vi.waitFor(
      () => {
        const ids = w.runIds("dev", root.id);
        if (ids.length === 0) throw new Error("스레드 런 없음");
        return ids;
      },
      { timeout: 5_000 },
    );
    const deltasOf = (runId: string | undefined) =>
      w.events.filter((e) => e.runId === runId && e.type === "TEXT_MESSAGE_CONTENT");
    await vi.waitFor(
      () => {
        expect(deltasOf(threadRun).length).toBeGreaterThanOrEqual(1);
        expect(deltasOf(channelRun).length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 5_000 },
    );
    // 둘 다 델타를 흘리는 중이고, 5초 뒤에도 어느 쪽도 끝나지 않았다 — 브라우저에서 두 버블을 함께 볼 틈
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(w.terminal(channelRun ?? "")).toBeUndefined();
    expect(w.terminal(threadRun ?? "")).toBeUndefined();
    expect(deltasOf(threadRun).length).toBeGreaterThanOrEqual(2);
    await vi.waitFor(
      () => {
        expect(w.terminal(channelRun ?? "")?.status).toBe("done");
        expect(w.terminal(threadRun ?? "")?.status).toBe("done");
      },
      { timeout: 25_000 },
    );
  }, 40_000);

  describe("POST /__devfake/plugin-capabilities — 옛 플러그인 흉내", () => {
    const setCaps = (body: unknown) =>
      fetch(`${dev.url}${DEV_FAKE_PLUGIN_CAPABILITIES_PATH}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    it("threads 가 boolean 이 아니거나 모르는 키가 있으면 400, 플러그인은 그대로", async () => {
      for (const body of [{}, { threads: "no" }, { threads: false, extra: 1 }]) {
        const res = await setCaps(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ code: "VALIDATION" });
      }
      expect(openclawOf(dev.app).supports("dev", DEV_FAKE_GATEWAY_ID, "threads")).toBe(true);
    });

    it("false → threads 없는 hello 로 다시 붙어 스레드 멘션은 PLUGIN_OUTDATED 카드(채널 멘션은 그대로) → true 로 되돌리고 「다시 실행」하면 스레드에서 답한다", async () => {
      const off = await setCaps({ threads: false });
      expect(off.status).toBe(200);
      const offBody = (await off.json()) as { ok: boolean; capabilities: string[] };
      expect(offBody.ok).toBe(true);
      expect(offBody.capabilities).not.toContain("threads");
      expect(offBody.capabilities).toContain("agents.list");
      expect(openclawOf(dev.app).supports("dev", DEV_FAKE_GATEWAY_ID, "threads")).toBe(false);

      const w = await channelWire("thread-outdated", ["dev"]);
      const root = await w.send("옛 플러그인 루트");
      await w.send(`<@a:${idOf("dev")}> 스레드`, root.id);
      const card = await vi.waitFor(
        () => {
          const found = w.created.find((m) => m.systemMeta?.kind === "run_error");
          if (!found) throw new Error("run_error 카드 없음");
          return found;
        },
        { timeout: 15_000 },
      );
      expect(card.threadRootId).toBe(root.id);
      const [failed] = w.runIds("dev", root.id);
      await vi.waitFor(() =>
        expect(w.states.find((s) => s.id === failed && s.status === "error")?.error?.code).toBe(
          "PLUGIN_OUTDATED",
        ),
      );
      await w.send(`<@a:${idOf("dev")}> 채널`);
      await vi.waitFor(
        () => expect(w.created.find((m) => m.authorType === "agent" && !m.threadRootId)).toBeDefined(),
        { timeout: 15_000 },
      );

      const on = await setCaps({ threads: true });
      expect(on.status).toBe(200);
      expect(((await on.json()) as { capabilities: string[] }).capabilities).toContain("threads");
      expect(openclawOf(dev.app).supports("dev", DEV_FAKE_GATEWAY_ID, "threads")).toBe(true);
      const socket = sockets.at(-1);
      const retried = await socket?.emitWithAck("component.interact", {
        messageId: card.id,
        componentId: card.components?.id ?? "",
        itemId: "retry_run",
        values: {},
      });
      expect(retried?.ok).toBe(true);
      await vi.waitFor(
        () =>
          expect(
            w.created.find((m) => m.authorType === "agent" && m.threadRootId === root.id)?.bodyMd,
          ).toContain("잘 받았어요"),
        { timeout: 15_000 },
      );
    }, 40_000);
  });
});

describe("startDevFake 종료 표지 — 운영 화면 「직전 종료」", () => {
  let dir: string;
  beforeAll(() => void (dir = mkdtempSync(join(tmpdir(), "dodok-dev-fake-runstate-"))));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function previousClean(dev: DevFake): Promise<unknown> {
    const login = await fetch(`${dev.url}/api/v1/auth/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: DEV_FAKE_LOCAL_TOKEN }),
    });
    const { sessionToken } = (await login.json()) as { sessionToken: string };
    const res = await fetch(`${dev.url}/api/v1/ops/status`, {
      headers: { cookie: `dodok.session=${sessionToken}` },
    });
    return ((await res.json()) as { server: { previousClean: unknown } }).server.previousClean;
  }

  it("처음은 null, 닫고 다시 띄우면 true — 표지는 dataDir 의 dev-fake 전용 자리(운영 서버의 run-state.json 을 건드리지 않는다)", async () => {
    const first = await startDevFake({ port: 0, dataDir: dir, logLevel: "warn" });
    try {
      expect(await previousClean(first)).toBeNull();
      expect(existsSync(join(dir, "run-state.json"))).toBe(false);
    } finally {
      await first.close();
    }
    const second = await startDevFake({ port: 0, dataDir: dir, logLevel: "warn" });
    try {
      expect(await previousClean(second)).toBe(true);
    } finally {
      await second.close();
    }
  }, 30_000);
});

describe("startDevFake 고정 member 계정 — mia", () => {
  let dir: string;
  let dev: DevFake;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-dev-fake-member-"));
    dev = await startDevFake({ port: 0, dataDir: dir, logLevel: "warn" });
  });

  afterAll(async () => {
    await dev?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const memberLogin = () =>
    fetch(`${dev.url}/api/v1/auth/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: DEV_FAKE_MEMBER_EMAIL, password: DEV_FAKE_MEMBER_PASSWORD }),
    });

  it("고정 이메일·비밀번호로 로그인하면 핸들 mia·표시 이름 미아, /auth/me 의 role 은 member", async () => {
    const res = await memberLogin();
    expect(res.status).toBe(200);
    const { sessionToken, user } = (await res.json()) as {
      sessionToken: string;
      user: { handle: string; displayName: string };
    };
    expect(user.handle).toBe(DEV_FAKE_MEMBER_HANDLE);
    expect(user.displayName).toBe(DEV_FAKE_MEMBER_DISPLAY_NAME);
    const me = await fetch(`${dev.url}/api/v1/auth/me`, {
      headers: { cookie: `dodok.session=${sessionToken}` },
    });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({ role: "member" });
  });

  it("--keep 두 번째 시작에서 중복 없이 그대로 — 같은 사용자 id, 로그인도 그대로 된다", async () => {
    const owner1 = await loginOwner(dev.url);
    const before = await restAs<{ members: Array<{ handle: string; id: string }> }>(
      dev.url,
      owner1.cookie,
      "GET",
      "/members",
    );
    const miaBefore = before.members.filter((m) => m.handle === DEV_FAKE_MEMBER_HANDLE);
    expect(miaBefore).toHaveLength(1);

    await dev.close();
    dev = await startDevFake({ port: 0, dataDir: dir, keep: true, logLevel: "warn" });

    expect((await memberLogin()).status).toBe(200);
    const owner2 = await loginOwner(dev.url);
    const after = await restAs<{ members: Array<{ handle: string; id: string }> }>(
      dev.url,
      owner2.cookie,
      "GET",
      "/members",
    );
    const miaAfter = after.members.filter((m) => m.handle === DEV_FAKE_MEMBER_HANDLE);
    expect(miaAfter).toHaveLength(1);
    expect(miaAfter[0]?.id).toBe(miaBefore[0]?.id);
  }, 20_000);
});

describe("startDevFake 가짜 Claude 러너 — 고정 러너 토큰·coder·/__devfake/runner", () => {
  let dir: string;
  let dev: DevFake;
  let owner: { sessionToken: string; cookie: string };
  const sockets: WireSocket[] = [];
  const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-dev-fake-runner-"));
    dev = await startDevFake({ port: 0, dataDir: dir, logLevel: "warn" });
    owner = await loginOwner(dev.url);
  });

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await dev?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const rest = <T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown) =>
    restAs<T>(dev.url, owner.cookie, method, path, body);
  const hook = async (body: unknown) => {
    const res = await fetch(`${dev.url}${DEV_FAKE_RUNNER_PATH}`, {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const runnersConnected = () => {
    const status = dev.app.registry.forProvider("claude")?.status();
    return status?.provider === "claude" ? status.runners.connected : -1;
  };

  /** coder 가 멤버인 채널을 만들고 wire 로 구독한다 — 받은 이벤트를 모은다 */
  async function coderChannel(name: string) {
    const { agents: list } = await rest<{ agents: Array<{ id: string; providerAgentId: string }> }>(
      "GET",
      "/agents",
    );
    const coderId = list.find((a) => a.providerAgentId === "coder")?.id ?? "";
    const { channel } = await rest<{ channel: { id: string } }>("POST", "/channels", { name });
    await rest("POST", `/channels/${channel.id}/members`, { memberType: "agent", memberId: coderId });
    const socket: WireSocket = io(dev.url, {
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      auth: { protocol: WIRE_PROTOCOL, token: owner.sessionToken },
    });
    sockets.push(socket);
    const created: Message[] = [];
    socket.on("message.created", ({ message }) => created.push(message));
    const res = await socket.emitWithAck("channel.subscribe", { channelId: channel.id });
    if (!res.ok) throw new Error(`channel.subscribe → ${res.error.code}`);
    const send = (bodyMd: string) =>
      socket.emitWithAck("message.send", { channelId: channel.id, clientMsgId: bodyMd, bodyMd });
    return { channelId: channel.id, coderId, socket, created, send };
  }

  it("시작하면 고정 러너 토큰(라벨 dev-fake) 행으로 가짜 러너가 붙어 있고, coder 는 claude 에이전트로 등록돼 discover 에 hint 와 함께 보인다", async () => {
    const row = dev.app.db
      .select()
      .from(runnerTokens)
      .where(eq(runnerTokens.hash, sha256(DEV_FAKE_RUNNER_TOKEN)))
      .get();
    expect(row).toMatchObject({ label: DEV_FAKE_RUNNER_LABEL, revokedAt: null });
    const { tokens } = await rest<{ tokens: Array<{ id: string; connected: boolean }> }>(
      "GET",
      "/setup/runner-tokens",
    );
    expect(tokens).toEqual([expect.objectContaining({ id: row?.id, connected: true })]);
    const { agents: list } = await rest<{ agents: Array<{ provider: string; providerAgentId: string }> }>(
      "GET",
      "/agents",
    );
    expect(list).toEqual([
      expect.objectContaining({ provider: "claude", providerAgentId: "coder", handle: "coder" }),
    ]);
    const { agents: found } = await rest<{ agents: unknown[] }>("GET", "/agents/discover?provider=claude");
    expect(found).toEqual([{ providerAgentId: "coder", name: "Coder", hint: "dev-fake · dodok · sonnet" }]);
  });

  it("@coder 「승인 게시」 → 승인 카드를 허용하면 post 카드 메시지와 최종 답이 오고, 런 usage 는 api 비용이다", async () => {
    const ch = await coderChannel("runner-approve");
    const requested = new Promise<string>((resolve) =>
      ch.socket.on("approval.requested", ({ approval }) => resolve(approval.id)),
    );
    expect((await ch.send(`<@a:${ch.coderId}> 승인 게시`)).ok).toBe(true);
    const approvalId = await requested;
    const decided = await ch.socket.emitWithAck("approval.resolve", { approvalId, decision: "allow-once" });
    expect(decided.ok).toBe(true);
    await vi.waitFor(
      () => {
        const agentMessages = ch.created.filter((m) => m.authorType === "agent");
        expect(agentMessages.map((m) => m.bodyMd)).toEqual([
          RUNNER_POST_TEXT,
          expect.stringMatching(/^허용받아 실행했습니다\.\n\n요약을 채널에 올렸습니다\.\n\n/),
        ]);
        expect(agentMessages[0]?.components?.blocks).toHaveLength(2);
      },
      { timeout: 10_000 },
    );
    const final = ch.created.find((m) => m.authorType === "agent" && m.bodyMd.startsWith("허용받아"));
    const stored = dev.app.db
      .select()
      .from(runs)
      .where(eq(runs.id, final?.runId ?? ""))
      .get();
    expect(stored?.usage).toMatchObject({ costUsd: 0.02, costKind: "api" });
  }, 20_000);

  it("runner 훅 — false 면 끊기고 멘션은 run_error 카드, 틀린 token 이면 ok:false, true 면 다시 붙어 답한다", async () => {
    const ch = await coderChannel("runner-hook");
    expect(await hook({ connected: "yes" })).toMatchObject({ status: 400 });
    const off = await hook({ connected: false });
    expect(off).toMatchObject({ status: 200, body: { ok: true } });
    expect(runnersConnected()).toBe(0);

    expect((await ch.send(`<@a:${ch.coderId}> 안녕`)).ok).toBe(true);
    await vi.waitFor(() => expect(ch.created.some((m) => m.systemMeta?.kind === "run_error")).toBe(true), {
      timeout: 10_000,
    });

    const wrong = await hook({ connected: true, token: "nope" });
    expect(wrong).toMatchObject({ status: 200, body: { ok: false } });
    expect(runnersConnected()).toBe(0);

    const on = await hook({ connected: true, token: DEV_FAKE_RUNNER_TOKEN });
    expect(on).toMatchObject({ status: 200, body: { ok: true } });
    expect(runnersConnected()).toBe(1);
    expect((await ch.send(`<@a:${ch.coderId}> 다시`)).ok).toBe(true);
    await vi.waitFor(
      () =>
        expect(ch.created.some((m) => m.authorType === "agent" && m.bodyMd.includes("잘 받았어요"))).toBe(
          true,
        ),
      { timeout: 10_000 },
    );
  }, 30_000);
});

describe("운영 createApp 에는 dev:fake 경로가 없다", () => {
  let app: App;
  let headers: { authorization: string };
  beforeAll(async () => {
    app = await bootTestApp();
    // 훅은 HTTP 서버의 request 리스너 층에 있다 — inject 는 그 층을 지나지 않으므로 실제로 듣고 fetch 로 부른다
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    // /api/v1/auth/local 은 5회/분 — 경로마다 로그인하지 않고 한 번만
    ({ headers } = await login(app));
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each([
    [DEV_FAKE_PLUGIN_TOKEN_PATH, { token: "x" }],
    [DEV_FAKE_OPS_EVENT_PATH, { kind: "ratelimit", key: "k", severity: "warn" }],
    [DEV_FAKE_GATEWAY_PATH, { state: "down" }],
    [DEV_FAKE_DISK_PATH, { reset: true }],
    [DEV_FAKE_PLUGIN_CAPABILITIES_PATH, { threads: false }],
    [DEV_FAKE_RUNNER_PATH, { connected: false }],
  ])("POST %s → 404 (실제 fetch, owner 세션)", async (path, body) => {
    const res = await fetch(`${app.url}${path}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(404);
  });

  it("dev:fake 고정 member 계정도 없다 — 그 이메일의 users 행이 없다", () => {
    const email = normalizeEmail(DEV_FAKE_MEMBER_EMAIL);
    const row = app.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.workspaceId, app.workspaceId), eq(users.email, email)))
      .get();
    expect(row).toBeUndefined();
  });

  it("dev:fake 고정 러너 토큰·coder 에이전트도 없다", () => {
    const hash = createHash("sha256").update(DEV_FAKE_RUNNER_TOKEN).digest("hex");
    expect(app.db.select().from(runnerTokens).where(eq(runnerTokens.hash, hash)).get()).toBeUndefined();
    expect(app.db.select().from(agents).where(eq(agents.providerAgentId, "coder")).get()).toBeUndefined();
  });
});

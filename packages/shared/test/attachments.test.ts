import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_LIMITS,
  artifactUrl,
  isImageMime,
  MessageSend,
  OutboundMessage,
  parseArtifactUrl,
  displayAttachmentName,
  sanitizeAttachmentName,
} from "../src";

const ID = "01a0cc16-22ee-7018-826c-e4783d25fa14";

describe("첨부 계약", () => {
  it("상한 값", () => {
    expect(ATTACHMENT_LIMITS.userImageMaxBytes).toBe(5 * 1024 * 1024);
    expect(ATTACHMENT_LIMITS.userFileMaxBytes).toBe(20 * 1024 * 1024);
    expect(ATTACHMENT_LIMITS.agentFileMaxBytes).toBe(20 * 1024 * 1024);
    expect(ATTACHMENT_LIMITS.perMessage).toBe(10);
  });

  it("이미지 MIME 은 넷뿐이고 SVG 는 아니다", () => {
    for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp"]) expect(isImageMime(m)).toBe(true);
    for (const m of ["image/svg+xml", "image/bmp", "text/html", "IMAGE/PNG", ""])
      expect(isImageMime(m)).toBe(false);
  });

  it("이름에서 경로 구분자·제어 문자를 빼고, 비면 file", () => {
    expect(sanitizeAttachmentName("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeAttachmentName("a\\b/c.png")).toBe("abc.png");
    expect(sanitizeAttachmentName("보고서\r\n최종.pdf")).toBe("보고서최종.pdf");
    expect(sanitizeAttachmentName("  ...숨김.txt ")).toBe("숨김.txt");
    expect(sanitizeAttachmentName("///")).toBe("file");
    expect(sanitizeAttachmentName("가".repeat(300))).toHaveLength(255);
    expect(sanitizeAttachmentName('보고서 "최종" 😀.pdf')).toBe('보고서 "최종" 😀.pdf');
  });

  it("양방향 제어 문자를 뺀다 — RLO 로 확장자를 뒤집어 보이게 하는 위장(invoice<U+202E>fdp.exe 가 invoiceexe.pdf 로 보임)", () => {
    expect(sanitizeAttachmentName("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
    const bidi = [
      "\u202A",
      "\u202B",
      "\u202C",
      "\u202D",
      "\u202E",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
      "\u200E",
      "\u200F",
      "\u061C",
    ];
    for (const c of bidi)
      expect(sanitizeAttachmentName(`a${c}b.txt`), c.codePointAt(0)?.toString(16)).toBe("ab.txt");
    expect(sanitizeAttachmentName(bidi.join(""))).toBe("file");
    // 방향 제어가 아닌 글자 결합·이음 문자는 그대로 — 이모지 ZWJ 열·아랍어 이름이 깨지지 않게
    expect(sanitizeAttachmentName("👩\u200D💻.png")).toBe("👩\u200D💻.png");
    expect(sanitizeAttachmentName("تقرير.pdf")).toBe("تقرير.pdf");
  });

  it("표시 이름은 양방향 제어 문자만 뺀다 — 다듬기와 같은 집합, 나머지 글자·공백·점은 그대로", () => {
    expect(displayAttachmentName("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
    for (const c of [
      "\u202A",
      "\u202B",
      "\u202C",
      "\u202D",
      "\u202E",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
      "\u200E",
      "\u200F",
      "\u061C",
    ]) {
      expect(displayAttachmentName(`a${c}b.txt`), c.codePointAt(0)?.toString(16)).toBe("ab.txt");
      expect(displayAttachmentName(`a${c}b.txt`)).toBe(sanitizeAttachmentName(`a${c}b.txt`));
    }
    expect(displayAttachmentName("\u202E\u2066")).toBe("file");
    expect(displayAttachmentName(" .숨김/a.txt")).toBe(" .숨김/a.txt");
    expect(displayAttachmentName("👩\u200D💻.png")).toBe("👩\u200D💻.png");
  });

  it("artifact URL 왕복", () => {
    expect(artifactUrl(ID)).toBe(`artifact://${ID}`);
    expect(parseArtifactUrl(`artifact://${ID}`)).toBe(ID);
    expect(parseArtifactUrl("artifact://report.pdf")).toBeNull(); // id 가 아니면 null — 이름 해석은 웹 몫
    expect(parseArtifactUrl(`https://x/${ID}`)).toBeNull();
    expect(parseArtifactUrl(` artifact://${ID}`)).toBeNull();
    // 끝 앵커 — 꼬리가 붙으면 그 id 로 해석하지 않는다
    expect(parseArtifactUrl(`artifact://${ID}x`)).toBeNull();
    expect(parseArtifactUrl(`artifact://${ID}/y`)).toBeNull();
  });

  it("MessageSend: 본문이 비면 첨부가 있어야 한다", () => {
    const base = { channelId: ID, clientMsgId: "c1", conversationId: ID };
    expect(MessageSend.safeParse({ ...base, bodyMd: "안녕" }).success).toBe(true);
    expect(MessageSend.safeParse({ ...base, bodyMd: "", attachments: [ID] }).success).toBe(true);
    expect(MessageSend.safeParse({ ...base, bodyMd: "  \n", attachments: [ID] }).success).toBe(true);
    expect(MessageSend.safeParse({ ...base, bodyMd: "" }).success).toBe(false);
    expect(MessageSend.safeParse({ ...base, bodyMd: " ", attachments: [] }).success).toBe(false);
    expect(MessageSend.safeParse({ ...base, bodyMd: "x", attachments: Array(11).fill(ID) }).success).toBe(
      false,
    );
  });

  it("OutboundMessage 는 attachmentIds 를 받고 옛 attachments 는 버린다", () => {
    const m = OutboundMessage.parse({
      outboundId: "o1",
      conversationId: ID,
      agentId: "dev",
      sessionKey: `agent:dev:dodok:channel:${ID}`,
      text: "",
      attachments: [{ id: ID }],
      ts: "2026-09-23T00:00:00.000Z",
    });
    expect(m.attachmentIds).toEqual([]);
    expect("attachments" in m).toBe(false);
  });

  it("OutboundMessage.attachmentIds 는 10개까지", () => {
    const base = {
      outboundId: "o1",
      conversationId: ID,
      agentId: "dev",
      sessionKey: `agent:dev:dodok:channel:${ID}`,
      text: "",
      ts: "2026-09-23T00:00:00.000Z",
    };
    expect(OutboundMessage.safeParse({ ...base, attachmentIds: Array(10).fill(ID) }).success).toBe(true);
    expect(OutboundMessage.safeParse({ ...base, attachmentIds: Array(11).fill(ID) }).success).toBe(false);
  });
});

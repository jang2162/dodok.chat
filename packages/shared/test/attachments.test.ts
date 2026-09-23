import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_LIMITS,
  artifactUrl,
  isImageMime,
  MessageSend,
  OutboundMessage,
  parseArtifactUrl,
  sanitizeAttachmentName,
} from "../src";

const ID = "01a0cc16-22ee-7018-826c-e4783d25fa14";

describe("첨부 계약", () => {
  it("상한 값", () => {
    expect(ATTACHMENT_LIMITS.userImageMaxBytes).toBe(5 * 1024 * 1024);
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

  it("artifact URL 왕복", () => {
    expect(artifactUrl(ID)).toBe(`artifact://${ID}`);
    expect(parseArtifactUrl(`artifact://${ID}`)).toBe(ID);
    expect(parseArtifactUrl("artifact://report.pdf")).toBeNull(); // id 가 아니면 null — 이름 해석은 웹 몫
    expect(parseArtifactUrl(`https://x/${ID}`)).toBeNull();
    expect(parseArtifactUrl(` artifact://${ID}`)).toBeNull();
  });

  it("MessageSend: 본문이 비면 첨부가 있어야 한다", () => {
    const base = { channelId: ID, clientMsgId: "c1" };
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
      channelId: ID,
      agentId: "dev",
      sessionKey: `agent:dev:dodok:channel:${ID}`,
      text: "",
      attachments: [{ id: ID }],
      ts: "2026-09-23T00:00:00.000Z",
    });
    expect(m.attachmentIds).toEqual([]);
    expect("attachments" in m).toBe(false);
  });
});

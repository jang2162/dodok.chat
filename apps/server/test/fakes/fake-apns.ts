/**
 * 가짜 APNs — 자체 서명 인증서로 http2 서버를 임의 포트에 연다. 인증서·키는 실행 중에 만든다(저장소에 두지 않는다).
 * 인증서는 openssl CLI 로 만든다: Node 에는 X.509 인증서를 만드는 API 가 없다
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createSecureServer, type Http2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ApnsRequest = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /** 요청이 들어온 연결 번호(0부터) — GOAWAY 뒤 새 연결을 가른다 */
  connection: number;
};
export type ApnsReply = { status: number; reason?: string };

export type FakeApns = {
  /** 호스트:포트 — apnsTransport 의 host, 앱의 APNS_HOST */
  host: string;
  ca: Buffer;
  /** CA(= 서버 인증서) PEM 파일 경로 — 앱의 APNS_CA_PATH */
  caPath: string;
  requests: ApnsRequest[];
  /** 지금까지 받은 연결 수 */
  connections(): number;
  /** 다음 요청부터의 응답을 정한다(기본 200) */
  reply(fn: (req: ApnsRequest) => ApnsReply): void;
  /** 열린 연결 전부에 GOAWAY 를 보낸다 — 서버 쪽에서 끊긴 것을 흉내 낸다 */
  goaway(): void;
  close(): Promise<void>;
};

export async function startFakeApns(): Promise<FakeApns> {
  const dir = mkdtempSync(join(tmpdir(), "dodok-fake-apns-"));
  const keyPath = join(dir, "key.pem");
  const caPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      caPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const ca = readFileSync(caPath);
  const requests: ApnsRequest[] = [];
  const sessions = new Set<Http2Session>();
  let connectionCount = 0;
  let responder: (req: ApnsRequest) => ApnsReply = () => ({ status: 200 });

  const server = createSecureServer({ key: readFileSync(keyPath), cert: ca });
  const numbers = new WeakMap<Http2Session, number>();
  server.on("session", (session) => {
    sessions.add(session);
    numbers.set(session, connectionCount++);
    session.on("close", () => sessions.delete(session));
    session.on("error", () => undefined);
  });
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const req: ApnsRequest = {
        path: String(headers[":path"]),
        headers,
        body: raw === "" ? undefined : JSON.parse(raw),
        connection: numbers.get(stream.session as Http2Session) ?? -1,
      };
      requests.push(req);
      const { status, reason } = responder(req);
      stream.respond({ ":status": status, "content-type": "application/json" });
      stream.end(reason === undefined ? "" : JSON.stringify({ reason }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    host: `127.0.0.1:${port}`,
    ca,
    caPath,
    requests,
    connections: () => connectionCount,
    reply(fn) {
      responder = fn;
    },
    goaway() {
      for (const s of sessions) s.goaway();
    },
    async close() {
      for (const s of sessions) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

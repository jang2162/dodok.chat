import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushPayload } from "@dodok/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FcmCredentials, loadFcmCredentials } from "../src/modules/push/fcm-credentials";
import { PUSH_SEND_TIMEOUT_MS, PUSH_TTL_SECONDS, pushTopic } from "../src/modules/push/service";
import { FCM_TOKEN_TTL_MS, fcmTransport } from "../src/modules/push/transports/fcm";
import type { DeviceTarget } from "../src/modules/push/transports/types";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CREDS: FcmCredentials = {
  projectId: "dodok-test",
  clientEmail: "sa@dodok-test.iam.gserviceaccount.com",
  privateKey,
  tokenUri: "https://oauth.invalid/token",
};
const TARGET: DeviceTarget = {
  kind: "device",
  id: "d1",
  platform: "android",
  token: "tok-android-1",
  appId: "chat.dodok",
};
const PAYLOAD: PushPayload = {
  kind: "mention",
  channelId: "019a0000-0000-7000-8000-000000000001",
  title: "dodok",
  body: "@dev가 #relay에서 불렀습니다",
  url: "/c/019a0000-0000-7000-8000-000000000001",
  tag: "mention:019a0000-0000-7000-8000-000000000001",
};
const NORMAL = { payload: PAYLOAD, urgency: "normal" as const };

type Call = { url: string; init: RequestInit };
type Reply = { status: number; body?: unknown } | Error;

/** URL 이 tokenUri 면 token 큐, 아니면 send 큐에서 하나씩 꺼내 답하는 가짜 fetch */
function fakeFetch(replies: { token?: Reply[]; send?: Reply[] }) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const queue = u === CREDS.tokenUri ? replies.token : replies.send;
    const r = queue?.shift() ?? { status: 500 };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  return {
    f,
    calls,
    tokenCalls: () => calls.filter((c) => c.url === CREDS.tokenUri),
    sendCalls: () => calls.filter((c) => c.url !== CREDS.tokenUri),
  };
}
const TOKEN_OK: Reply = { status: 200, body: { access_token: "access-1", expires_in: 3599 } };
const OK: Reply = { status: 200, body: { name: "projects/x/messages/1" } };

describe("fcmTransport — 토큰 교환", () => {
  it("token_uri 로 jwt-bearer + RS256 JWT(iss·scope·aud·exp)를 보내고, 서명이 공개 키로 검증된다", async () => {
    const fx = fakeFetch({ token: [TOKEN_OK], send: [OK] });
    const t = fcmTransport({ credentials: CREDS, fetch: fx.f, now: () => 1_700_000_000_000 });
    expect(await t.send(TARGET, NORMAL)).toBe("ok");
    const [call] = fx.tokenCalls();
    expect(call?.init.method).toBe("POST");
    const form = new URLSearchParams(String(call?.init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, s] = (form.get("assertion") ?? "").split(".");
    expect(JSON.parse(Buffer.from(h ?? "", "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c ?? "", "base64url").toString())).toEqual({
      iss: CREDS.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: CREDS.tokenUri,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const ok = createVerify("RSA-SHA256")
      .update(`${h}.${c}`)
      .verify(publicKey, Buffer.from(s ?? "", "base64url"));
    expect(ok).toBe(true);
  });

  it("55분 안의 발송은 같은 토큰을 쓰고, 55분이 지나면 다시 교환한다", async () => {
    let t0 = 1_000_000;
    const fx = fakeFetch({
      token: [TOKEN_OK, { status: 200, body: { access_token: "access-2" } }],
      send: [OK, OK, OK],
    });
    const t = fcmTransport({ credentials: CREDS, fetch: fx.f, now: () => t0 });
    await t.send(TARGET, NORMAL);
    t0 += FCM_TOKEN_TTL_MS - 1;
    await t.send(TARGET, NORMAL);
    expect(fx.tokenCalls()).toHaveLength(1);
    t0 += 2;
    await t.send(TARGET, NORMAL);
    expect(fx.tokenCalls()).toHaveLength(2);
    const auth = (c: Call) => (c.init.headers as Record<string, string>).authorization;
    expect(fx.sendCalls().map(auth)).toEqual(["Bearer access-1", "Bearer access-1", "Bearer access-2"]);
  });

  it("[Review Focus 4] 동시에 다섯 발송이 와도 토큰 교환은 한 번이다", async () => {
    const fx = fakeFetch({ token: [TOKEN_OK], send: [OK, OK, OK, OK, OK] });
    const t = fcmTransport({ credentials: CREDS, fetch: fx.f });
    const results = await Promise.all(Array.from({ length: 5 }, () => t.send(TARGET, NORMAL)));
    expect(results).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(fx.tokenCalls()).toHaveLength(1);
    expect(fx.sendCalls()).toHaveLength(5);
  });

  it("[Review Focus 4] 교환이 500·네트워크 오류면 그 발송은 retry 이고, 실패를 캐시하지 않아 다음 발송이 다시 교환한다", async () => {
    const fx = fakeFetch({ token: [{ status: 500 }, new Error("ECONNRESET"), TOKEN_OK], send: [OK] });
    const t = fcmTransport({ credentials: CREDS, fetch: fx.f });
    expect(await t.send(TARGET, NORMAL)).toBe("retry");
    expect(await t.send(TARGET, NORMAL)).toBe("retry");
    expect(await t.send(TARGET, NORMAL)).toBe("ok");
    expect(fx.tokenCalls()).toHaveLength(3);
    expect(fx.sendCalls()).toHaveLength(1); // 교환이 실패한 발송은 FCM 으로 나가지 않는다
  });

  it("[Review Focus 4] 동시 발송 다섯이 실패한 교환 하나를 함께 받아 모두 retry 이고, 이어서 오는 발송은 새 교환을 낸다", async () => {
    const fx = fakeFetch({ token: [{ status: 503 }, TOKEN_OK], send: [OK] });
    const t = fcmTransport({ credentials: CREDS, fetch: fx.f });
    const results = await Promise.all(Array.from({ length: 5 }, () => t.send(TARGET, NORMAL)));
    expect(results).toEqual(["retry", "retry", "retry", "retry", "retry"]);
    expect(fx.tokenCalls()).toHaveLength(1);
    expect(await t.send(TARGET, NORMAL)).toBe("ok");
    expect(fx.tokenCalls()).toHaveLength(2);
  });

  it("키를 거부하는 교환 응답(400 invalid_grant)은 credentials 이고 캐시되지 않는다", async () => {
    const fx = fakeFetch({
      token: [{ status: 400, body: { error: "invalid_grant" } }, TOKEN_OK],
      send: [OK],
    });
    const warns: unknown[] = [];
    const t = fcmTransport({
      credentials: CREDS,
      fetch: fx.f,
      logger: { warn: (o: unknown) => warns.push(o) } as never,
    });
    expect(await t.send(TARGET, NORMAL)).toBe("credentials");
    expect(warns).toEqual([{ transport: "fcm", statusCode: 400, reason: "invalid_grant" }]);
    expect(await t.send(TARGET, NORMAL)).toBe("ok");
  });
});

describe("fcmTransport — 발송", () => {
  it("v1 messages:send 로 스펙 꼴 본문을 보낸다(data 값은 모두 문자열, approval 은 HIGH)", async () => {
    const fx = fakeFetch({ token: [TOKEN_OK], send: [OK, OK] });
    const t = fcmTransport({ credentials: CREDS, host: "http://fcm.invalid", fetch: fx.f });
    await t.send(TARGET, NORMAL);
    await t.send(TARGET, { payload: { ...PAYLOAD, kind: "approval", tag: "approval:x" }, urgency: "high" });
    const [normal, high] = fx.sendCalls();
    expect(normal?.url).toBe("http://fcm.invalid/v1/projects/dodok-test/messages:send");
    expect((normal?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer access-1",
    );
    expect(JSON.parse(String(normal?.init.body))).toEqual({
      message: {
        token: "tok-android-1",
        notification: { title: "dodok", body: PAYLOAD.body },
        data: { url: PAYLOAD.url, kind: "mention", channelId: PAYLOAD.channelId },
        android: { priority: "NORMAL", collapse_key: pushTopic(PAYLOAD.tag), ttl: `${PUSH_TTL_SECONDS}s` },
      },
    });
    const sent = JSON.parse(String(high?.init.body)) as {
      message: { android: { priority: string }; data: Record<string, unknown> };
    };
    expect(sent.message.android.priority).toBe("HIGH");
    expect(Object.values(sent.message.data).every((v) => typeof v === "string")).toBe(true);
  });

  it.each([
    ["200", { status: 200 }, "ok"],
    ["404", { status: 404, body: { error: { status: "NOT_FOUND" } } }, "gone"],
    [
      "400 UNREGISTERED",
      {
        status: 400,
        body: { error: { status: "INVALID_ARGUMENT", details: [{ errorCode: "UNREGISTERED" }] } },
      },
      "gone",
    ],
    ["401", { status: 401, body: { error: { status: "UNAUTHENTICATED" } } }, "credentials"],
    ["403", { status: 403, body: { error: { status: "PERMISSION_DENIED" } } }, "credentials"],
    ["400 INVALID_ARGUMENT", { status: 400, body: { error: { status: "INVALID_ARGUMENT" } } }, "rejected"],
    ["429", { status: 429 }, "retry"],
    ["503", { status: 503 }, "retry"],
  ] as const)("결과 표: %s → %s", async (_name, reply, expected) => {
    const fx = fakeFetch({ token: [TOKEN_OK], send: [reply] });
    expect(await fcmTransport({ credentials: CREDS, fetch: fx.f }).send(TARGET, NORMAL)).toBe(expected);
  });

  it("401 이면 캐시한 토큰을 버려 다음 발송이 새로 교환한다", async () => {
    const fx = fakeFetch({ token: [TOKEN_OK, TOKEN_OK], send: [{ status: 401 }, OK] });
    const t = fcmTransport({ credentials: CREDS, fetch: fx.f });
    expect(await t.send(TARGET, NORMAL)).toBe("credentials");
    expect(await t.send(TARGET, NORMAL)).toBe("ok");
    expect(fx.tokenCalls()).toHaveLength(2);
  });

  it("거부 사유를 warn 으로 남기되 statusCode 와 고정 reason 만 싣는다(토큰·페이로드·임의 문자열 없음)", async () => {
    const fx = fakeFetch({
      token: [TOKEN_OK],
      send: [
        { status: 400, body: { error: { status: "INVALID_ARGUMENT", message: "tok-android-1 is bad" } } },
        { status: 400, body: { error: { status: "bad reason with tok-android-1" } } },
      ],
    });
    const warns: unknown[] = [];
    const t = fcmTransport({
      credentials: CREDS,
      fetch: fx.f,
      logger: { warn: (o: unknown) => warns.push(o) } as never,
    });
    await t.send(TARGET, NORMAL);
    await t.send(TARGET, NORMAL);
    expect(warns).toEqual([
      { transport: "fcm", statusCode: 400, reason: "INVALID_ARGUMENT" },
      { transport: "fcm", statusCode: 400, reason: "unknown" },
    ]);
    expect(JSON.stringify(warns)).not.toContain("tok-android-1");
  });

  it("네트워크 오류는 던진다(디스패처가 warn) — iOS·웹 대상은 거절한다", async () => {
    const fx = fakeFetch({ token: [TOKEN_OK], send: [new Error("ECONNRESET")] });
    const t = fcmTransport({ credentials: CREDS, fetch: fx.f });
    await expect(t.send(TARGET, NORMAL)).rejects.toThrow("ECONNRESET");
    await expect(t.send({ ...TARGET, platform: "ios" }, NORMAL)).rejects.toThrow(/android/);
  });
});

describe("fcmTransport — 토큰 교환 결과 표·만료·제한 시간", () => {
  const exchangeResult = async (status: number) => {
    const fx = fakeFetch({ token: [{ status, body: { error: "x" } }] });
    const warns: unknown[] = [];
    const t = fcmTransport({
      credentials: CREDS,
      fetch: fx.f,
      logger: { warn: (o: unknown) => warns.push(o) } as never,
    });
    return { result: await t.send(TARGET, NORMAL), fx };
  };

  it.each([401, 403])("교환 %i 는 자격 증명 문제다 — credentials, 발송은 나가지 않는다", async (status) => {
    const { result, fx } = await exchangeResult(status);
    expect(result).toBe("credentials");
    expect(fx.sendCalls()).toHaveLength(0);
  });

  it("교환 429 는 retry 다 — 레이트리밋 한 번이 자격 증명 사건이 되지 않는다", async () => {
    expect((await exchangeResult(429)).result).toBe("retry");
  });

  it("expires_in 이 55분보다 짧으면 (expires_in − 60초)만 재사용하고 그 뒤 다시 교환한다", async () => {
    let t0 = 1_000_000;
    const fx = fakeFetch({
      token: [
        { status: 200, body: { access_token: "short", expires_in: 600 } },
        { status: 200, body: { access_token: "fresh", expires_in: 600 } },
      ],
      send: [OK, OK, OK],
    });
    const t = fcmTransport({ credentials: CREDS, fetch: fx.f, now: () => t0 });
    await t.send(TARGET, NORMAL);
    t0 += 540_000 - 1;
    await t.send(TARGET, NORMAL);
    expect(fx.tokenCalls()).toHaveLength(1);
    t0 += 2;
    await t.send(TARGET, NORMAL);
    expect(fx.tokenCalls()).toHaveLength(2);
  });

  it("응답 없는 토큰 엔드포인트는 제한 시간에 끊겨 retry 이고, 다음 발송은 새 교환을 낸다", async () => {
    // 진짜 10초를 기다리지 않게 AbortSignal.timeout 만 짧은 것으로 바꾸고, 쓰인 제한값은 단언한다
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort());
    try {
      let tokenCalls = 0;
      const hang = (init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const sig = init?.signal;
          if (sig === undefined || sig === null) return; // 신호가 없으면 영영 매달린다
          const fail = () => reject(new Error("aborted"));
          if (sig.aborted) fail();
          else sig.addEventListener("abort", fail);
        });
      const f = (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === CREDS.tokenUri) {
          tokenCalls += 1;
          if (tokenCalls === 1) return hang(init);
          return new Response(JSON.stringify({ access_token: "a", expires_in: 3599 }));
        }
        return new Response("{}");
      }) as typeof fetch;
      const t = fcmTransport({ credentials: CREDS, fetch: f });
      expect(await t.send(TARGET, NORMAL)).toBe("retry");
      expect(timeoutSpy).toHaveBeenCalledWith(PUSH_SEND_TIMEOUT_MS);
      expect(await t.send(TARGET, NORMAL)).toBe("ok");
      expect(tokenCalls).toBe(2);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("응답 없는 발송 엔드포인트는 제한 시간에 끊겨 던진다", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort());
    try {
      const f = (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === CREDS.tokenUri)
          return new Response(JSON.stringify({ access_token: "a", expires_in: 3599 }));
        return new Promise<Response>((_, reject) => {
          const sig = init?.signal;
          if (sig === undefined || sig === null) return;
          const fail = () => reject(new Error("aborted"));
          if (sig.aborted) fail();
          else sig.addEventListener("abort", fail);
        });
      }) as typeof fetch;
      const t = fcmTransport({ credentials: CREDS, fetch: f });
      await expect(t.send(TARGET, NORMAL)).rejects.toThrow("aborted");
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe("loadFcmCredentials", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "fcm-"));
    dirs.push(d);
    return d;
  };
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const account = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      project_id: "p1",
      client_email: "secret-sa@p1.iam.gserviceaccount.com",
      private_key: pem,
      token_uri: "https://oauth.invalid/token",
      ...over,
    });

  it("DATA_DIR/fcm/service-account.json 으로 켜진다", () => {
    const dir = tmp();
    mkdirSync(join(dir, "fcm"));
    writeFileSync(join(dir, "fcm", "service-account.json"), account());
    const c = loadFcmCredentials({ dataDir: dir });
    expect(c).toMatchObject({
      projectId: "p1",
      clientEmail: "secret-sa@p1.iam.gserviceaccount.com",
      tokenUri: "https://oauth.invalid/token",
    });
  });

  it("환경 변수 경로가 파일보다 우선한다", () => {
    const dir = tmp();
    mkdirSync(join(dir, "fcm"));
    writeFileSync(join(dir, "fcm", "service-account.json"), account({ project_id: "from-data" }));
    const other = join(dir, "other.json");
    writeFileSync(other, account({ project_id: "from-env" }));
    expect(loadFcmCredentials({ dataDir: dir, path: other })).toMatchObject({ projectId: "from-env" });
  });

  it("token_uri 가 없으면 Google 기본 엔드포인트", () => {
    const dir = tmp();
    const f = join(dir, "sa.json");
    writeFileSync(f, JSON.stringify({ project_id: "p", client_email: "e@x", private_key: pem }));
    expect(loadFcmCredentials({ dataDir: dir, path: f })).toMatchObject({
      tokenUri: "https://oauth2.googleapis.com/token",
    });
  });

  it("파일 없음 → no service account · 필드 빠짐·깨진 JSON·깨진 키·RSA 아닌 키 → invalid service account", () => {
    const dir = tmp();
    expect(loadFcmCredentials({ dataDir: dir })).toEqual({ off: "no service account" });
    const bad = (name: string, text: string) => {
      const f = join(dir, name);
      writeFileSync(f, text);
      return loadFcmCredentials({ dataDir: dir, path: f });
    };
    expect(bad("missing.json", JSON.stringify({ project_id: "p", private_key: pem }))).toEqual({
      off: "invalid service account",
    });
    expect(bad("broken.json", "{nope")).toEqual({ off: "invalid service account" });
    expect(
      bad("key.json", account({ private_key: "-----BEGIN PRIVATE KEY-----\nxx\n-----END PRIVATE KEY-----" })),
    ).toEqual({
      off: "invalid service account",
    });
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(bad("ec.json", account({ private_key: ec }))).toEqual({ off: "invalid service account" });
  });

  it("거부 사유에 이메일·키 원문이 없다", () => {
    const dir = tmp();
    const f = join(dir, "sa.json");
    writeFileSync(f, account({ private_key: "garbage" }));
    const r = JSON.stringify(loadFcmCredentials({ dataDir: dir, path: f }));
    expect(r).not.toContain("secret-sa");
    expect(r).not.toContain("garbage");
  });
});

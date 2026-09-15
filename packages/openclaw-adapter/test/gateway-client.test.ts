import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HelloOk } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 실제 Gateway 없이 connectGateway 가 라이브러리에 넘기는 옵션과 종료 콜백 전달만 잰다.
type ClientOptions = {
  caps?: string[];
  scopes?: string[];
  onHelloOk?: (hello: HelloOk) => void;
  onClose?: (code: number, reason: string, info?: { phase: "pre-hello" | "post-hello" }) => void;
};
const created = vi.hoisted(() => [] as Array<{ opts: ClientOptions; stopAndWait: ReturnType<typeof vi.fn> }>);

vi.mock("@openclaw/gateway-client", () => ({
  GatewayClient: class {
    readonly opts: ClientOptions;
    readonly stopAndWait = vi.fn(async () => undefined);
    constructor(opts: ClientOptions) {
      this.opts = opts;
      created.push(this);
    }
    start() {
      queueMicrotask(() => this.opts.onHelloOk?.({ type: "hello-ok" } as unknown as HelloOk));
    }
  },
}));

const { connectGateway } = await import("../src/gateway/client");

let dir: string;

beforeEach(() => {
  created.length = 0;
  dir = mkdtempSync(join(tmpdir(), "dodok-gw-client-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function lastClient() {
  const client = created.at(-1);
  if (!client) throw new Error("GatewayClient 가 만들어지지 않았다");
  return client;
}

describe("connectGateway 옵션", () => {
  it("scopes 기본값은 read·write·approvals·admin, caps 기본값은 tool-events·approvals·session-scoped-events", async () => {
    await connectGateway({ url: "ws://127.0.0.1:1", deviceIdentityPath: join(dir, "device.json") });

    expect(lastClient().opts.scopes).toEqual([
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.admin",
    ]);
    expect(lastClient().opts.caps).toEqual(["tool-events", "approvals", "session-scoped-events"]);
  });

  it("onClose 는 hello 뒤 끊김(post-hello)만 전달하고, 우리가 stop 한 뒤에는 부르지 않는다", async () => {
    const onClose = vi.fn();
    const connection = await connectGateway({
      url: "ws://127.0.0.1:1",
      deviceIdentityPath: join(dir, "device.json"),
      onClose,
    });
    const { opts } = lastClient();

    opts.onClose?.(1006, "", { phase: "pre-hello" });
    expect(onClose).not.toHaveBeenCalled();

    opts.onClose?.(1012, "service restart", { phase: "post-hello" });
    expect(onClose).toHaveBeenCalledWith({ code: 1012, reason: "service restart" });

    await connection.stop();
    opts.onClose?.(1000, "", { phase: "post-hello" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lastClient().stopAndWait).toHaveBeenCalled();
  });
});

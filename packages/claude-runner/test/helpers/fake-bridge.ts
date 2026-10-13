import type {
  Attachment,
  RunnerApprovalRequested,
  RunnerControlCall,
  RunnerOutboundAck,
  RunnerOutboundPost,
} from "@dodok/shared";
import type { ApprovalOutcome } from "../../src/approvals";
import type { ControlCallOutcome } from "../../src/control-tools";
import type { RunBridge } from "../../src/run";

/** 러너 연결 대신 런이 서버와 주고받는 것을 적어 두는 가짜 — 결정은 decide 로 돌려준다 */
export type FakeBridge = RunBridge & {
  posts: RunnerOutboundPost[];
  controls: RunnerControlCall[];
  requested: RunnerApprovalRequested[];
  withdrawn: string[];
  downloads: string[];
  /** 그 승인을 기다리기 시작할 때까지 기다렸다가 결정을 돌려준다 */
  decide(providerApprovalId: string, outcome: ApprovalOutcome): Promise<void>;
};

export function createFakeBridge(
  opts: {
    ack?: RunnerOutboundAck;
    images?: Record<string, Buffer>;
    upload?: (name: string) => Attachment;
    control?: (call: RunnerControlCall) => ControlCallOutcome;
  } = {},
): FakeBridge {
  const posts: RunnerOutboundPost[] = [];
  const controls: RunnerControlCall[] = [];
  const requested: RunnerApprovalRequested[] = [];
  const withdrawn: string[] = [];
  const downloads: string[] = [];
  const waiting = new Map<string, (o: ApprovalOutcome) => void>();
  return {
    posts,
    controls,
    requested,
    withdrawn,
    downloads,
    http: {
      upload: async ({ name }) => {
        if (!opts.upload) throw new Error("fake: upload not scripted");
        return opts.upload(name);
      },
      download: async (id) => {
        downloads.push(id);
        const bytes = opts.images?.[id];
        if (!bytes) throw new Error("fake: 404");
        return { bytes, mime: "application/octet-stream" };
      },
    },
    post: async (m) => {
      posts.push(m);
      return opts.ack ?? { ok: true, messageId: "0192f000-0000-7000-8000-0000000000aa" };
    },
    control: async (c) => {
      controls.push(c);
      return opts.control?.(c) ?? { ok: true, data: null };
    },
    requestApproval: (r) => void requested.push(r),
    withdrawApproval: (id) => void withdrawn.push(id),
    waitDecision: (id, signal) =>
      new Promise<ApprovalOutcome>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        waiting.set(id, resolve);
      }),
    async decide(id, outcome) {
      const deadline = Date.now() + 2000;
      while (!waiting.has(id)) {
        if (Date.now() > deadline) throw new Error(`fake: approval ${id} never waited`);
        await new Promise((r) => setTimeout(r, 2));
      }
      waiting.get(id)!(outcome);
    },
  };
}

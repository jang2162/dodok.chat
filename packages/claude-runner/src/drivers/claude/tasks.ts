import type { BackgroundTask } from "@dodok/shared";
import type { PathMasker } from "../../mask";
import { elide } from "./approvals";
import type { SdkMessage } from "./sdk";

// SDK 작업 메시지 → 백그라운드 작업 목록(백그라운드 작업 스펙 5.4, ADR 0007 5.11). 세션 프로세스 하나에 하나.
// - 목록의 정본은 background_tasks_changed(바꿔 끼우는 값)다. 전경 Bash 도 task_started·task_notification 을 내지만 changed 에는
//   들지 않는다 — started 만으로는 목록에 넣지 않는다(ADR 5.11 함정 「전경 Bash 도 작업 메시지를 낸다」)
// - changed 는 started 보다 먼저 오기도 한다(시나리오 1 — 같은 ms) — 메타는 둘 중 먼저 온 쪽으로 만들고 started 가 채운다
// - ambient 는 활동이 아니라 빼고, 알림도 내지 않는다

const DESCRIPTION_MAX = 200;
const SUMMARY_MAX = 300;
const SUBAGENT_TYPE_MAX = 64;
const TOOL_NAME_MAX = 128;

export type TaskNotice = {
  taskId: string;
  status: "completed" | "failed" | "stopped";
  kind: BackgroundTask["kind"];
  originRunId: string;
};

export type TaskTracker = {
  /** changed — list() 가 바뀌었다(tasks.update 를 보낼 까닭). notifications — 백그라운드 작업의 끝 알림 */
  apply(m: SdkMessage): { changed: boolean; notifications: TaskNotice[] };
  list(): BackgroundTask[];
  has(taskId: string): boolean;
  size(): number;
  reset(): void;
};

type Meta = {
  kind: BackgroundTask["kind"];
  description: string;
  subagentType?: string;
  summary?: string;
  lastToolName?: string;
  startedAt: string;
  originRunId: string;
  backgrounded: boolean;
};

// SDK 메시지 유니온은 크고 판본마다 필드가 는다 — 쓰는 필드만 느슨하게 읽는다
type Loose = {
  type?: string;
  subtype?: string;
  task_id?: string;
  task_type?: string;
  description?: string;
  subagent_type?: string;
  is_backgrounded?: boolean;
  ambient?: boolean;
  summary?: string;
  last_tool_name?: string;
  status?: string;
  patch?: { is_backgrounded?: boolean; description?: string };
  tasks?: Array<{ task_id?: string; task_type?: string; description?: string; ambient?: boolean }>;
};

export const taskKind = (taskType: string | undefined): BackgroundTask["kind"] =>
  taskType === "local_bash" ? "shell" : taskType === "local_agent" ? "subagent" : "other";

export function createTaskTracker(o: {
  now: () => number;
  mask: PathMasker;
  currentRunId: () => string | undefined;
}): TaskTracker {
  const meta = new Map<string, Meta>();
  const ambient = new Set<string>();
  // 화면에 보일 작업 id — 넣은 차례
  let live: string[] = [];
  // 런이 끝난 뒤 처음 보는 작업은 마지막으로 돌던 런의 것으로 본다(그 런의 턴이 띄웠다)
  let lastRunId: string | undefined;

  const runNow = (): string | undefined => {
    const id = o.currentRunId();
    if (id !== undefined) lastRunId = id;
    return id ?? lastRunId;
  };
  const text = (s: string, max: number) => elide(o.mask(s), max);

  function ensure(taskId: string, taskType: string | undefined, description: string): Meta | undefined {
    const known = meta.get(taskId);
    if (known) return known;
    const originRunId = runNow();
    if (originRunId === undefined) return undefined; // 어느 런에도 붙일 수 없다 — 카드가 없으니 보이지 않는다
    const m: Meta = {
      kind: taskKind(taskType),
      description: text(description, DESCRIPTION_MAX),
      startedAt: new Date(o.now()).toISOString(),
      originRunId,
      backgrounded: false,
    };
    meta.set(taskId, m);
    return m;
  }

  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);

  function apply(m: SdkMessage): { changed: boolean; notifications: TaskNotice[] } {
    const x = m as unknown as Loose;
    const none = { changed: false, notifications: [] };
    if (x.type !== "system") return none;
    // 런이 도는 동안 본 런 id 를 기억한다 — 작업 메시지가 아니어도
    runNow();
    const id = x.task_id;
    switch (x.subtype) {
      case "background_tasks_changed": {
        const next: string[] = [];
        for (const t of x.tasks ?? []) {
          if (!t.task_id) continue;
          if (t.ambient) {
            ambient.add(t.task_id);
            continue;
          }
          const mm = ensure(t.task_id, t.task_type, t.description ?? "");
          if (!mm) continue;
          mm.backgrounded = true;
          next.push(t.task_id);
        }
        const changed = !same(live, next);
        live = next;
        return { changed, notifications: [] };
      }
      case "task_started": {
        if (!id) return none;
        if (x.ambient) {
          ambient.add(id);
          return none;
        }
        const known = meta.get(id);
        const mm = known ?? ensure(id, x.task_type, x.description ?? "");
        if (!mm) return none;
        // changed 가 먼저 왔으면 그 자리의 글을 started 의 것으로 바꾼다 — 종류·설명은 started 가 정본이다
        if (known) {
          mm.kind = taskKind(x.task_type);
          if (x.description) mm.description = text(x.description, DESCRIPTION_MAX);
        }
        if (x.subagent_type) mm.subagentType = elide(x.subagent_type, SUBAGENT_TYPE_MAX);
        if (x.is_backgrounded) mm.backgrounded = true;
        return { changed: known !== undefined && live.includes(id), notifications: [] };
      }
      case "task_progress": {
        const mm = id ? meta.get(id) : undefined;
        if (!mm) return none;
        if (x.summary) mm.summary = text(x.summary, SUMMARY_MAX);
        if (x.last_tool_name) mm.lastToolName = elide(x.last_tool_name, TOOL_NAME_MAX);
        return { changed: live.includes(id!), notifications: [] };
      }
      case "task_updated": {
        const mm = id ? meta.get(id) : undefined;
        if (!mm || !id) return none;
        if (x.patch?.description) mm.description = text(x.patch.description, DESCRIPTION_MAX);
        // 전경에서 백그라운드로 옮겨 간 작업 — changed 가 곧 따라오겠지만 그 전에도 보인다
        if (x.patch?.is_backgrounded && !live.includes(id)) {
          mm.backgrounded = true;
          live = [...live, id];
          return { changed: true, notifications: [] };
        }
        return { changed: live.includes(id) && x.patch?.description !== undefined, notifications: [] };
      }
      case "task_notification": {
        if (!id || x.ambient || ambient.has(id)) return none;
        const mm = meta.get(id);
        // 전경 작업의 끝은 그 턴 안의 일이다 — 추가 응답을 열 까닭이 아니다
        if (!mm || !mm.backgrounded) {
          meta.delete(id);
          return none;
        }
        const status = x.status === "failed" || x.status === "stopped" ? x.status : "completed";
        const was = live.length;
        live = live.filter((t) => t !== id);
        meta.delete(id);
        return {
          changed: live.length !== was,
          notifications: [{ taskId: id, status, kind: mm.kind, originRunId: mm.originRunId }],
        };
      }
      default:
        return none;
    }
  }

  return {
    apply,
    list: () =>
      live.flatMap((id) => {
        const mm = meta.get(id);
        if (!mm) return [];
        return [
          {
            taskId: id,
            kind: mm.kind,
            description: mm.description,
            ...(mm.subagentType ? { subagentType: mm.subagentType } : {}),
            ...(mm.summary ? { summary: mm.summary } : {}),
            ...(mm.lastToolName ? { lastToolName: mm.lastToolName } : {}),
            startedAt: mm.startedAt,
            originRunId: mm.originRunId,
          },
        ];
      }),
    has: (taskId) => live.includes(taskId),
    size: () => live.length,
    reset: () => {
      meta.clear();
      ambient.clear();
      live = [];
      lastRunId = undefined;
    },
  };
}

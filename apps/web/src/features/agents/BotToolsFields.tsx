import {
  appMcpBlockText,
  appMcpCeilingOf,
  appMcpCeilingText,
  appMcpVerdict,
  isStdioServer,
  MCP_SECRET_MASK,
  type McpAutoAllow,
  type McpAutoAllowMap,
  type McpServers,
  McpServersPaste,
  RUNNER_BOT_MCP_UPDATE_MESSAGE,
  type RunnerBotDefinition,
  type RunnerSummary,
} from "@dodok/shared";
import { useId, useState } from "react";
import { Checkbox } from "@/ui/checkbox";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Textarea } from "@/ui/textarea";

// 봇의 「도구」(러너 봇 2부 스펙 T1·T3·T4·T7·T15) — `.mcp.json` 붙여넣기(통째로든 mcpServers 값만이든), 서버마다 「쓸 수 있음 / 이 러너가
// 막음 — 사유」(러너 hello 의 appMcp 천장 + shared appMcpVerdict — 러너가 런 때 하는 판정과 같다), 서버마다 「묻지 않음」, 내장 도구
// 「이 러너 설정 제어」. 헤더·env 값은 서버가 ••••로 돌려준다 — 그 자리를 그대로 두면 저장 때 원래 값이 남는다

export type BotTools = Required<Pick<RunnerBotDefinition, "mcpServers" | "mcpAutoAllow" | "builtinTools">>;
export const EMPTY_BOT_TOOLS: BotTools = { mcpServers: {}, mcpAutoAllow: {}, builtinTools: [] };

export const BOT_TOOLS_SECRET_HINT = `헤더·env 값은 ${MCP_SECRET_MASK} 로 보입니다 — 그대로 두면 원래 값이 남습니다`;
export const RUNNER_CONTROL_LABEL = "이 러너 설정 제어";
export const RUNNER_CONTROL_HINT =
  "이 봇이 대화로 이 러너의 프로젝트·에이전트·세션 시작값·업데이트를 다룹니다(바꾸기는 시킨 사람의 확인 카드). 러너 머신의 config.json 은 바꾸지 못합니다";
export const MCP_JSON_INVALID = "JSON 을 읽을 수 없습니다";

/** 봇 정의에서 도구 세 칸을 꺼낸다 — 없는 것은 빈 값 */
export function botToolsOf(def: RunnerBotDefinition | undefined): BotTools {
  return {
    mcpServers: def?.mcpServers ?? {},
    mcpAutoAllow: def?.mcpAutoAllow ?? {},
    builtinTools: def?.builtinTools ?? [],
  };
}

const serversText = (servers: McpServers) =>
  Object.keys(servers).length === 0 ? "" : JSON.stringify({ mcpServers: servers }, null, 2);

/** 붙여 넣은 글 — 빈 글은 서버 없음. 틀리면 첫 문제 한 줄 */
export function parseMcpText(
  text: string,
): { ok: true; servers: McpServers } | { ok: false; message: string } {
  if (text.trim() === "") return { ok: true, servers: {} };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: MCP_JSON_INVALID };
  }
  const parsed = McpServersPaste.safeParse(json);
  if (parsed.success) return { ok: true, servers: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.join(".") ?? "";
  return { ok: false, message: `${where === "" ? "" : `${where}: `}${issue?.message ?? MCP_JSON_INVALID}` };
}

type AutoMode = McpAutoAllow["mode"];

/** 「이 도구만」에 이름이 하나 이상인가 — 빈 목록은 서버가 받지 않는다(tools.min(1)) */
const toolsFilled = (autoAllow: McpAutoAllowMap) =>
  Object.values(autoAllow).every((a) => a.mode !== "tools" || a.tools.length > 0);
const AUTO_LABEL: Record<AutoMode, string> = {
  none: "묻기(기본)",
  all: "전부 묻지 않음",
  tools: "이 도구만 묻지 않음",
};

export function BotToolsFields({
  value,
  onChange,
  onValidity,
  runner,
  disabled,
}: {
  value: BotTools;
  onChange: (next: BotTools) => void;
  /** 붙여 넣은 글을 읽을 수 있는가 — 틀리면 부르는 쪽이 저장을 잠근다 */
  onValidity: (valid: boolean) => void;
  /** 이 봇의 러너 — 끊겼으면 허용 표시를 하지 않는다 */
  runner: RunnerSummary | undefined;
  disabled: boolean;
}) {
  const ids = useId();
  const [text, setText] = useState(() => serversText(value.mcpServers));
  const [problem, setProblem] = useState<string>();
  // 도구 이름 목록 칸의 글 — 쉼표로 나눈다
  const [toolText, setToolText] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(value.mcpAutoAllow).map(([name, a]) => [
        name,
        a.mode === "tools" ? a.tools.join(", ") : "",
      ]),
    ),
  );
  const live = runner?.connected === true;
  const caps = runner?.capabilities ?? [];
  const ceiling = appMcpCeilingOf(runner?.programs.find((p) => p.program === "claude"));
  const noBotMcp = live && !caps.includes("botMcp");
  const noRunnerControl = live && !caps.includes("runnerControl");
  const names = Object.keys(value.mcpServers);

  function edit(next: string) {
    setText(next);
    const parsed = parseMcpText(next);
    if (!parsed.ok) {
      setProblem(parsed.message);
      onValidity(false);
      return;
    }
    setProblem(undefined);
    // 없어진 서버의 자동 허용은 걷는다
    const autoAllow: McpAutoAllowMap = Object.fromEntries(
      Object.entries(value.mcpAutoAllow).filter(([name]) => name in parsed.servers),
    );
    // 남은 서버에 빈 「이 도구만」이 있으면 잠금을 그대로 둔다(setAuto 와 같은 판정 — JSON 편집이 풀지 않게)
    onValidity(toolsFilled(autoAllow));
    onChange({ ...value, mcpServers: parsed.servers, mcpAutoAllow: autoAllow });
  }

  function setAuto(name: string, mode: AutoMode, listText = toolText[name] ?? "") {
    const tools = listText
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    const next: McpAutoAllowMap = { ...value.mcpAutoAllow };
    if (mode === "none") delete next[name];
    else if (mode === "all") next[name] = { mode: "all" };
    else if (tools.length > 0) next[name] = { mode: "tools", tools };
    else next[name] = { mode: "tools", tools: [] };
    onChange({ ...value, mcpAutoAllow: next });
    // 빈 도구 목록은 서버가 받지 않는다 — 고를 때까지 저장을 잠근다
    onValidity(problem === undefined && toolsFilled(next));
  }

  return (
    // min-w-0 — fieldset 의 기본 min-width(min-content)가 긴 JSON 줄로 대화상자를 가로로 넓히지 않게
    <fieldset className="flex min-w-0 flex-col gap-3" disabled={disabled} aria-label="도구">
      <legend className="text-sm font-medium">도구</legend>
      {noBotMcp && (
        <p role="note" className="text-xs text-muted-foreground">
          {RUNNER_BOT_MCP_UPDATE_MESSAGE}
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${ids}-mcp`}>MCP 서버(.mcp.json)</Label>
        <Textarea
          id={`${ids}-mcp`}
          value={text}
          rows={6}
          spellCheck={false}
          // field-sizing: fixed — 내용 크기 맞춤이면 긴 JSON 한 줄의 폭이 대화상자 폭을 밀어낸다(390px 에서 실측)
          className="field-sizing-fixed min-w-0 font-mono text-xs"
          placeholder={'{ "mcpServers": { "github": { "type": "http", "url": "https://…" } } }'}
          aria-describedby={`${ids}-mcp-hint${problem ? ` ${ids}-mcp-error` : ""}`}
          aria-invalid={problem !== undefined}
          onChange={(e) => edit(e.target.value)}
        />
        <p id={`${ids}-mcp-hint`} className="text-xs text-muted-foreground">
          .mcp.json 을 통째로 붙여 넣어도 됩니다. {BOT_TOOLS_SECRET_HINT}
        </p>
        {problem && (
          <p id={`${ids}-mcp-error`} role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        )}
      </div>
      {names.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="MCP 서버">
          {names.map((name) => {
            const server = value.mcpServers[name]!;
            const auto = value.mcpAutoAllow[name];
            const mode: AutoMode = auto?.mode ?? "none";
            const verdict = live ? appMcpVerdict(ceiling, name, server, auto) : undefined;
            const kind = isStdioServer(server) ? "stdio" : server.type;
            return (
              <li key={name} className="flex flex-col gap-1.5 rounded-md border p-2">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                  <span className="min-w-0 text-sm font-medium break-all">
                    {name} <span className="text-xs font-normal text-muted-foreground">({kind})</span>
                  </span>
                  <span
                    className={
                      verdict?.ok === false
                        ? "min-w-0 text-xs break-words text-destructive"
                        : "min-w-0 text-xs break-words text-muted-foreground"
                    }
                    data-testid={`mcp-verdict-${name}`}
                  >
                    {verdict === undefined
                      ? "러너가 붙으면 판정합니다"
                      : !verdict.ok
                        ? `이 러너가 막음 — ${appMcpBlockText(verdict.reason, verdict.detail)}`
                        : verdict.outsideCeiling.length > 0
                          ? `쓸 수 있음 · 이 러너가 막음 — ${appMcpCeilingText(verdict.outsideCeiling)}`
                          : "쓸 수 있음"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor={`${ids}-auto-${name}`} className="text-xs font-normal">
                    묻지 않음
                  </Label>
                  <select
                    id={`${ids}-auto-${name}`}
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                    value={mode}
                    onChange={(e) => setAuto(name, e.target.value as AutoMode)}
                  >
                    {(Object.keys(AUTO_LABEL) as AutoMode[]).map((m) => (
                      <option key={m} value={m}>
                        {AUTO_LABEL[m]}
                      </option>
                    ))}
                  </select>
                  {mode === "tools" && (
                    <Input
                      aria-label={`${name} 묻지 않을 도구(쉼표로)`}
                      className="h-8 min-w-0 flex-1 text-xs"
                      value={toolText[name] ?? ""}
                      placeholder="search_issues, get_issue"
                      onChange={(e) => {
                        setToolText((t) => ({ ...t, [name]: e.target.value }));
                        setAuto(name, "tools", e.target.value);
                      }}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-start gap-2">
        <Checkbox
          id={`${ids}-runner-control`}
          checked={value.builtinTools.includes("runnerControl")}
          disabled={disabled || (noRunnerControl && !value.builtinTools.includes("runnerControl"))}
          aria-describedby={`${ids}-runner-control-hint`}
          onCheckedChange={(on) =>
            onChange({
              ...value,
              builtinTools:
                on === true ? ["runnerControl"] : value.builtinTools.filter((t) => t !== "runnerControl"),
            })
          }
        />
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={`${ids}-runner-control`} className="font-normal">
            {RUNNER_CONTROL_LABEL}
          </Label>
          <p id={`${ids}-runner-control-hint`} className="text-xs text-muted-foreground">
            {noRunnerControl ? RUNNER_BOT_MCP_UPDATE_MESSAGE : RUNNER_CONTROL_HINT}
          </p>
        </div>
      </div>
    </fieldset>
  );
}

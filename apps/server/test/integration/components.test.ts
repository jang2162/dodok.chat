/**
 * components v1 계획 시나리오 10 — 실제 서버(실제 OpenClawAdapter) + 가짜 Gateway + 가짜 플러그인 + wire 클라이언트.
 *
 * 에이전트가 낸 카드가 **플러그인 검증(coerceComponents) → 브리지 → 서버 저장(id·componentState 부여) → wire** 를 지나고,
 * 사람이 `component.interact` 로 누른 것이 **검사·저장·소비 → message.updated(상호작용 기록) → 그 에이전트의 다음 런**
 * 으로 이어지는 전 구간을 잰다(설계 4.4·7.2). 기다림은 wire 이벤트(`WireLog.until`)로 한다.
 */
import { INTERACTIONS_MAX, type Message, type Result } from "@dodok/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScenario, type Scenario, type ScenarioScript } from "../fakes/scenario";
import { bootLiveApp, type LiveApp } from "../helpers/live-app";
import {
  getRunRest,
  openChannelWire,
  type RelayChannel,
  rest,
  sendMessage,
  setupRelayChannel,
  subscribe,
  type WireLog,
} from "../helpers/scenario-steps";
import { connectWire, type WireClient } from "../helpers/wire";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 20_000 });

const RELAY_POLICY = { maxRelayTurns: 2, allowPairs: "all" as const };
/** 로컬 로그인 owner 의 핸들(auth.test 가 잰다) — 상호작용 글의 `user=@…` */
const OWNER_HANDLE = "owner";
/**
 * 에이전트가 대본에 채워 보내는 components.id — 일부러 서버가 낼 법한 모양(`cmp_<uuid>`)이다. 그래서 「그대로 유지」는
 * `not.toBe` 만, 에이전트 값을 재료로 쓴 「부분 유지」(접두사·꼬리를 붙임)는 모양 단언만 잡는다
 */
const AGENT_COMPONENT_ID = "cmp_01a0c2a8-8b53-719b-a49b-3aba4cd93eca";
/** 서버가 저장 시 부여하는 모양 `cmp_<uuid>` — 계약은 uuid 판을 정하지 않으므로 버전·variant 자리는 보지 않는다 */
const SERVER_COMPONENT_ID_RE = /^cmp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type CardComponents = NonNullable<ScenarioScript["components"]>;

/** 카드의 서버 부여 id — 없으면 카드가 아니다 */
function componentIdOf(card: Message): string {
  const id = card.components?.id;
  if (id === undefined) throw new Error(`메시지 ${card.id} 에 components.id 가 없다`);
  return id;
}

function interactionIdOf(res: Result<{ interactionId: string }>): string {
  if (!res.ok) throw new Error(`component.interact 실패: ${res.error.code} ${res.error.message}`);
  return res.data.interactionId;
}

describe("통합 시나리오 10 — components 상호작용이 그 에이전트의 다음 런으로", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  /**
   * dev 한 명짜리 채널 + 구독한 소켓 + 대본(첫 턴은 카드, 그 뒤 턴은 「받았어요 <턴>」) → `@dev` 로 카드를 받는다.
   * 카드 뒤 턴의 답에 순번을 박아 두면 「n 번째 상호작용 런이 끝났다」를 wire 로 기다릴 수 있다.
   */
  async function startCard(components: CardComponents) {
    live = await bootLiveApp();
    const setup = await setupRelayChannel(live, RELAY_POLICY);
    const log = await openChannelWire(live, setup.channel.id, sockets);
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: {
        dev: ({ index }) =>
          index === 0 ? { reply: "골라 주세요", components } : { reply: `받았어요 ${index}` },
      },
    });
    const asked = await sendMessage(log.socket, setup.channel.id, "@dev 물어봐줘");
    const card = await log.until(
      () => log.created.find((m) => m.authorType === "agent" && m.components !== undefined),
      "카드가 실린 에이전트 메시지",
    );
    return { setup, log, scenario, card, ownerId: asked.authorId };
  }

  function press(socket: WireClient, card: Message, itemId: string, values: Record<string, unknown> = {}) {
    return socket.emitWithAck("component.interact", {
      messageId: card.id,
      componentId: componentIdOf(card),
      itemId,
      values,
    });
  }

  /** 카드 뒤 n 번째 턴(상호작용 런)의 정본 */
  const replyOf = (log: WireLog, index: number) =>
    log.until(
      () => log.created.find((m) => m.authorType === "agent" && m.bodyMd === `받았어요 ${index}`),
      `상호작용 런 ${index} 의 정본`,
    );

  /** 그 카드에 대해 받은 message.updated, 도착 순서 */
  const updatesOf = (log: WireLog, card: Message) => log.updated.filter((m) => m.id === card.id);

  /** 새 탭 — 상호작용이 **끝난 뒤** 연 새 소켓의 구독 ack 에서 그 카드를 꺼낸다(이 소켓은 message.updated 를 한 번도 받지 않았다) */
  async function cardInFreshSubscribe(setup: RelayChannel, card: Message): Promise<Message | undefined> {
    const fresh = await connectWire(live.app, live.auth.token);
    sockets.push(fresh);
    const page = await subscribe(fresh, setup.channel.id);
    return page.messages.find((m) => m.id === card.id);
  }

  function expectNoScenarioErrors(scenario: Scenario) {
    expect(scenario.errors).toEqual([]);
  }

  it("시나리오 10a — 에이전트가 셀렉트를 낸 뒤 사람이 고르면 그 에이전트의 다음 런이 고른 값을 받는다", async () => {
    const { setup, log, scenario, card, ownerId } = await startCard({
      // 모델은 id 를 채워 보낼 수 있고 플러그인 스키마는 그것을 통과시킨다 — 서버가 덮어써야 한다
      id: AGENT_COMPONENT_ID,
      blocks: [
        {
          type: "actions",
          items: [
            {
              type: "select",
              id: "lunch",
              placeholder: "점심 메뉴",
              options: [
                { value: "kimchi", label: "김치찌개" },
                { value: "ramen", label: "라멘" },
              ],
            },
          ],
        },
      ],
    });

    // 플러그인이 기본값을 채우고(1회용·30분·단일), 서버가 id·componentState 를 붙여 저장했다. 아직 결과 줄은 없다
    expect(card.components?.id, "에이전트가 보낸 components.id 는 서버가 덮어쓴다").not.toBe(
      AGENT_COMPONENT_ID,
    );
    expect(card.components).toMatchObject({
      id: expect.stringMatching(SERVER_COMPONENT_ID_RE),
      reusable: false,
      ttlMs: 1_800_000,
      blocks: [{ type: "actions", items: [{ type: "select", id: "lunch", multi: false }] }],
    });
    expect(card.componentState?.consumed).toEqual([]);
    expect(Date.parse(card.componentState?.expiresAt ?? "")).toBeGreaterThan(Date.now() + 1_700_000);
    expect(card.interactions).toEqual([]);

    const interactionId = interactionIdOf(await press(log.socket, card, "lunch", { values: ["ramen"] }));

    // 같은 소켓에는 결과 줄이 실린 message.updated 가 오고, 1회용이라 그 아이템은 소비됐다
    const updated = await log.until(() => updatesOf(log, card).at(0), "카드 message.updated");
    expect(updated.componentState?.consumed).toEqual(["lunch"]);
    expect(updated.interactions).toEqual([
      {
        id: interactionId,
        componentId: componentIdOf(card),
        userId: ownerId,
        itemId: "lunch",
        values: { values: ["ramen"] },
        createdAt: expect.any(String),
      },
    ]);

    // 그 에이전트(카드를 낸 dev)의 다음 런이 interaction 으로 시작돼 고른 값을 받았다
    const reply = await replyOf(log, 1);
    const run = await getRunRest(live, reply.runId ?? "");
    expect(run).toMatchObject({ agentId: setup.dev.id, triggerKind: "interaction" });
    const turn = scenario.turns[1];
    expect(turn?.agentId).toBe("dev");
    expect(turn?.delivery).toMatchObject({
      kind: "interaction",
      runId: run.id,
      message: { id: card.id, author: { type: "user", handle: OWNER_HANDLE } },
    });
    expect(turn?.delivery.message.text).toBe(
      `[dodok interaction] user=@${OWNER_HANDLE} kind=select component=${componentIdOf(card)} item=lunch values=["ramen"]\n` +
        `@${OWNER_HANDLE} 님이 "점심 메뉴"에서 라멘을 골랐습니다.`,
    );
    expect(scenario.turns).toHaveLength(2);
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 10b — 모달 제출이 다음 런으로 간다(필수 칸을 비운 제출은 서버가 막고, 모달은 소비되지 않는다)", async () => {
    const { log, scenario, card, ownerId } = await startCard({
      blocks: [{ type: "section", text: "**휴가 신청**을 받습니다." }],
      modal: {
        id: "leave",
        title: "휴가 신청",
        triggerLabel: "신청서 열기",
        fields: [
          { type: "text", id: "reason", label: "사유", required: true },
          { type: "number", id: "days", label: "일수", min: 1, max: 10 },
          { type: "date", id: "start", label: "시작일" },
          { type: "checkbox", id: "urgent", label: "급함" },
          {
            type: "radio",
            id: "kind",
            label: "종류",
            options: [
              { value: "annual", label: "연차" },
              { value: "sick", label: "병가" },
            ],
          },
        ],
      },
    });
    expect(card.components?.modal).toMatchObject({ id: "leave", triggerLabel: "신청서 열기" });

    // 필수 칸을 비우면 서버가 VALIDATION 으로 막는다 — 저장·소비·런 없음
    const rejected = await press(log.socket, card, "leave", { fields: { days: 3 } });
    expect(rejected).toMatchObject({ ok: false, error: { code: "VALIDATION" } });

    const fields = { reason: "가족 여행", days: 3, start: "2026-10-01", urgent: true, kind: "annual" };
    const interactionId = interactionIdOf(await press(log.socket, card, "leave", { fields }));

    const updated = await log.until(() => updatesOf(log, card).at(0), "카드 message.updated");
    expect(updated.componentState?.consumed).toEqual(["leave"]);
    expect(updated.interactions).toEqual([
      expect.objectContaining({ id: interactionId, userId: ownerId, itemId: "leave", values: { fields } }),
    ]);

    await replyOf(log, 1);
    // 막힌 제출이 런이 됐다면 FIFO 라 그것이 1 번째 턴이었을 것이다 — 두 번째 턴은 통과한 제출이다
    expect(scenario.turns).toHaveLength(2);
    expect(scenario.turns[1]?.delivery.kind).toBe("interaction");
    expect(scenario.turns[1]?.delivery.message.text.split("\n")).toEqual([
      `[dodok interaction] user=@${OWNER_HANDLE} kind=modal component=${componentIdOf(card)} item=leave`,
      `@${OWNER_HANDLE} 님이 "휴가 신청" 양식을 제출했습니다.`,
      "- 사유: 가족 여행",
      "- 일수: 3",
      "- 시작일: 2026-10-01",
      "- 급함: 예",
      "- 종류: 연차",
    ]);
    expect(updatesOf(log, card)).toHaveLength(1);
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 10c — 결과 줄이 새 구독 ack 에 실려 온다(message.updated·REST 재조회와 같은 값)", async () => {
    const { setup, log, scenario, card, ownerId } = await startCard({
      blocks: [
        {
          type: "actions",
          items: [
            { type: "button", id: "yes", label: "좋아요", style: "primary" },
            { type: "button", id: "no", label: "다음에" },
          ],
        },
      ],
    });
    const interactionId = interactionIdOf(await press(log.socket, card, "yes"));
    await replyOf(log, 1);

    const expected = [
      {
        id: interactionId,
        componentId: componentIdOf(card),
        userId: ownerId,
        itemId: "yes",
        values: {},
        createdAt: expect.any(String),
      },
    ];
    // ① 새 탭 — 상호작용 뒤에 연 새 소켓. 이 소켓은 message.updated 를 받은 적이 없으니 결과 줄은 ack 에서만 온다
    const fresh = await cardInFreshSubscribe(setup, card);
    expect(fresh?.interactions).toEqual(expected);
    expect(fresh?.componentState?.consumed).toEqual(["yes"]);
    // ② 누른 자리의 message.updated
    expect(updatesOf(log, card).at(-1)?.interactions).toEqual(expected);
    // ③ REST 히스토리 재조회(새로고침)
    const history = await rest<{ messages: Message[] }>(
      live,
      "GET",
      `/channels/${setup.channel.id}/messages`,
    );
    expect(history.status).toBe(200);
    expect(history.body.messages.find((m) => m.id === card.id)?.interactions).toEqual(expected);
    // 카드가 아닌 메시지(사람 글·상호작용 런의 답)는 빈 기록을 싣는다
    for (const m of history.body.messages.filter((m) => m.id !== card.id)) expect(m.interactions).toEqual([]);
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 10d — reusable 카드를 두 번 눌러도 둘 다 전달되고 결과 줄이 2건", async () => {
    const { setup, log, scenario, card } = await startCard({
      reusable: true,
      blocks: [{ type: "actions", items: [{ type: "button", id: "again", label: "한 번 더" }] }],
    });
    const first = interactionIdOf(await press(log.socket, card, "again"));
    const second = interactionIdOf(await press(log.socket, card, "again"));
    await replyOf(log, 1);
    await replyOf(log, 2);

    // 누를 때마다 방송된다 — 결과 줄이 1건 → 2건으로 늘고, 재사용이라 소비는 비어 있다
    const updates = updatesOf(log, card);
    expect(updates.map((m) => m.interactions.map((i) => i.id))).toEqual([[first], [first, second]]);
    for (const m of updates) expect(m.componentState?.consumed).toEqual([]);

    // 두 번 다 그 에이전트의 상호작용 런으로 갔다
    const turns = scenario.turns.slice(1);
    expect(turns.map((t) => [t.agentId, t.delivery.kind])).toEqual([
      ["dev", "interaction"],
      ["dev", "interaction"],
    ]);
    for (const t of turns) expect(t.delivery.message.text).toContain(`item=again`);
    for (const t of turns) {
      expect(await getRunRest(live, t.delivery.runId)).toMatchObject({
        agentId: setup.dev.id,
        triggerKind: "interaction",
      });
    }
    expectNoScenarioErrors(scenario);
  });

  it(`시나리오 10e — 21건을 넘기면 최신 ${INTERACTIONS_MAX}건만 실린다(가장 오래된 1건이 잘린다)`, async () => {
    const { setup, log, scenario, card } = await startCard({
      reusable: true,
      blocks: [{ type: "actions", items: [{ type: "button", id: "tap", label: "눌러요" }] }],
    });
    const ids: string[] = [];
    for (let i = 0; i < INTERACTIONS_MAX + 1; i++) {
      ids.push(interactionIdOf(await press(log.socket, card, "tap")));
    }
    const newest = ids.slice(1);
    /** 어느 쪽이 잘렸는지 id 로 먼저 말하게 한다 — 전체 비교만으로는 「20개 ≠ 20개」라고만 나온다 */
    const expectNewest = (shown: string[] | undefined, where: string) => {
      expect(shown, `${where}: 가장 새 것(21번째)이 실린다`).toContain(ids.at(-1));
      expect(shown, `${where}: 가장 오래된 것(1번째)이 잘린다`).not.toContain(ids[0]);
      expect(shown, `${where}: 최신 ${INTERACTIONS_MAX}건, 오래된 것부터`).toEqual(newest);
    };

    const last = await log.until(
      () => updatesOf(log, card).length === ids.length && updatesOf(log, card).at(-1),
      `카드 message.updated ${ids.length}건`,
    );
    expectNewest(
      last.interactions.map((i) => i.id),
      "message.updated",
    );
    const times = last.interactions.map((i) => Date.parse(i.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const fresh = await cardInFreshSubscribe(setup, card);
    expectNewest(
      fresh?.interactions.map((i) => i.id),
      "새 구독 ack",
    );

    // 잘린 것은 화면의 결과 줄뿐이다 — 에이전트에게는 21건이 다 갔다
    await replyOf(log, ids.length);
    expect(scenario.turns.filter((t) => t.delivery.kind === "interaction")).toHaveLength(ids.length);
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 10f — 같은 아이템을 동시에 두 번 눌러도 한 번만 통과한다(두 탭)", async () => {
    const { setup, log, scenario, card } = await startCard({
      blocks: [
        { type: "actions", items: [{ type: "button", id: "claim", label: "제가 할게요", style: "success" }] },
      ],
    });
    const other = await openChannelWire(live, setup.channel.id, sockets);

    const results = await Promise.all([press(log.socket, card, "claim"), press(other.socket, card, "claim")]);
    const passed = results.filter((r) => r.ok);
    expect(passed).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, error: expect.objectContaining({ code: "CONSUMED" }) },
    ]);

    await replyOf(log, 1);
    // 런은 카드 런과 상호작용 런 둘뿐 — enqueue 는 ack 전에 run.state 를 내므로 여기까지 오면 더 없다
    const devRuns = new Set(log.states.filter((s) => s.agentId === setup.dev.id).map((s) => s.id));
    expect(devRuns.size).toBe(2);
    expect(scenario.turns).toHaveLength(2);
    const updates = updatesOf(log, card);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.interactions.map((i) => i.id)).toEqual([interactionIdOf(passed[0] ?? results[0])]);
    expect(updates[0]?.componentState?.consumed).toEqual(["claim"]);
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 10g — 스키마를 어긴 components 는 플러그인이 거절한다(하네스가 검증을 건너뛰지 않는다)", async () => {
    live = await bootLiveApp();
    const setup = await setupRelayChannel(live, RELAY_POLICY);
    const log = await openChannelWire(live, setup.channel.id, sockets);
    const buttons = ["a", "b", "c", "d", "e", "f"].map((id) => ({ type: "button" as const, id, label: id }));
    // 액션 로우 버튼은 5개까지(components v1 제약) — 6개면 플러그인 coerceComponents 가 보내기 전에 거절한다
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: {
        dev: () => ({ reply: "버튼 여섯", components: { blocks: [{ type: "actions", items: buttons }] } }),
      },
    });
    await sendMessage(log.socket, setup.channel.id, "@dev 버튼 여섯");
    await log.until(
      () => log.states.find((s) => s.agentId === setup.dev.id && s.status !== "queued"),
      "dev 런 시작",
    );
    await scenario.idle();

    // 서버 브리지의 VALIDATION 이 아니라 플러그인 자신의 거절 문구다 — 브리지까지 가지도 않았다
    expect(scenario.errors).toHaveLength(1);
    expect(String(scenario.errors[0])).toMatch(/components: v1 스키마 위반 — blocks\.0\.items/);
    expect(log.created.filter((m) => m.authorType === "agent")).toEqual([]);
  });
});

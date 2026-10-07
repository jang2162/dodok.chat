import { describe, expect, it } from "vitest";
import {
  AutomationCreated,
  AutomationSchedule,
  AutomationSummary,
  CreateAutomationBody,
  Message,
  OPS_DEFAULT_TIME_ZONE,
  OpsSettings,
  OpsSettingsPatch,
  UpdateAutomationBody,
} from "../src";

const ID = "01a09fc9-d204-7551-89d6-38544d07a101";
const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const NOW = "2026-10-07T00:00:00Z";

const schedule = { kind: "schedule", name: "아침 점검", channelId: CH, bodyMd: "@dev 점검해 줘" };
const webhook = { kind: "webhook", name: "배포 알림", channelId: CH, bodyMd: "@dev 배포 결과를 봐 줘" };
const daily = { repeat: "daily", time: "09:00" };

describe("AutomationSchedule", () => {
  it("반복 네 가지를 받는다 — weekly 의 0 은 일요일", () => {
    expect(AutomationSchedule.safeParse(daily).success).toBe(true);
    expect(AutomationSchedule.safeParse({ repeat: "weekdays", time: "23:59" }).success).toBe(true);
    expect(AutomationSchedule.safeParse({ repeat: "weekly", weekday: 0, time: "00:00" }).success).toBe(true);
    expect(AutomationSchedule.safeParse({ repeat: "weekly", weekday: 6, time: "12:30" }).success).toBe(true);
    expect(AutomationSchedule.safeParse({ repeat: "hourly", minute: 59 }).success).toBe(true);
  });

  it("시각은 HH:MM 두 자리씩 — 24:00·9:00·09:60 거절", () => {
    for (const time of ["24:00", "9:00", "09:60", "09:0", "0900", ""]) {
      expect(AutomationSchedule.safeParse({ repeat: "daily", time }).success).toBe(false);
    }
  });

  it("weekly 에 weekday 가 없거나 범위 밖이면 거절", () => {
    expect(AutomationSchedule.safeParse({ repeat: "weekly", time: "09:00" }).success).toBe(false);
    expect(AutomationSchedule.safeParse({ repeat: "weekly", weekday: 7, time: "09:00" }).success).toBe(false);
    expect(AutomationSchedule.safeParse({ repeat: "weekly", weekday: 1.5, time: "09:00" }).success).toBe(
      false,
    );
  });

  it("hourly 는 minute 만 — time 만 있으면 거절, 60분 거절", () => {
    expect(AutomationSchedule.safeParse({ repeat: "hourly", time: "09:15" }).success).toBe(false);
    expect(AutomationSchedule.safeParse({ repeat: "hourly", minute: 60 }).success).toBe(false);
  });

  it("모르는 반복은 거절", () => {
    expect(AutomationSchedule.safeParse({ repeat: "monthly", time: "09:00" }).success).toBe(false);
  });
});

describe("CreateAutomationBody", () => {
  it("예약은 schedule 이 있어야 하고 enabled 기본값은 true", () => {
    const parsed = CreateAutomationBody.parse({ ...schedule, schedule: daily });
    expect(parsed.enabled).toBe(true);
    expect(CreateAutomationBody.safeParse(schedule).success).toBe(false);
  });

  it("웹훅은 schedule 없이 받는다", () => {
    expect(CreateAutomationBody.parse(webhook)).toMatchObject({ kind: "webhook", enabled: true });
  });

  it("이름은 앞뒤 공백을 걷고 1~40자 — 0자·공백만·41자 거절", () => {
    expect(CreateAutomationBody.parse({ ...webhook, name: "  배포  " }).name).toBe("배포");
    expect(CreateAutomationBody.safeParse({ ...webhook, name: "" }).success).toBe(false);
    expect(CreateAutomationBody.safeParse({ ...webhook, name: "   " }).success).toBe(false);
    expect(CreateAutomationBody.safeParse({ ...webhook, name: "가".repeat(40) }).success).toBe(true);
    expect(CreateAutomationBody.safeParse({ ...webhook, name: "가".repeat(41) }).success).toBe(false);
  });

  it("문구는 1~4,000자 — 빈 문구·공백만·4,001자 거절", () => {
    expect(CreateAutomationBody.safeParse({ ...webhook, bodyMd: "x".repeat(4000) }).success).toBe(true);
    expect(CreateAutomationBody.safeParse({ ...webhook, bodyMd: "x".repeat(4001) }).success).toBe(false);
    expect(CreateAutomationBody.safeParse({ ...webhook, bodyMd: "" }).success).toBe(false);
    expect(CreateAutomationBody.safeParse({ ...webhook, bodyMd: " \n " }).success).toBe(false);
  });

  it("모르는 종류는 거절", () => {
    expect(CreateAutomationBody.safeParse({ ...webhook, kind: "reaction" }).success).toBe(false);
  });
});

describe("UpdateAutomationBody", () => {
  it("모든 칸이 선택 — 빈 본문도 모양으로는 받는다", () => {
    expect(UpdateAutomationBody.safeParse({}).success).toBe(true);
    expect(UpdateAutomationBody.safeParse({ enabled: false, schedule: daily }).success).toBe(true);
  });

  it("준 칸은 만들기와 같은 범위로 본다", () => {
    expect(UpdateAutomationBody.safeParse({ name: "가".repeat(41) }).success).toBe(false);
    expect(UpdateAutomationBody.safeParse({ bodyMd: "x".repeat(4001) }).success).toBe(false);
    expect(UpdateAutomationBody.safeParse({ schedule: { repeat: "daily", time: "24:00" } }).success).toBe(
      false,
    );
  });
});

describe("AutomationSummary·AutomationCreated", () => {
  const summary = {
    id: ID,
    name: "배포 알림",
    channelId: CH,
    kind: "webhook",
    bodyMd: "@dev 봐 줘",
    enabled: true,
    tokenPrefix: "abc123",
    lastRunAt: NOW,
    lastStatus: "ok",
    warnings: [{ kind: "agent_not_in_channel", handle: "dev" }, { kind: "channel_archived" }],
  };

  it("목록 한 줄을 받는다 — 토큰 원문 칸이 없다", () => {
    const parsed = AutomationSummary.parse({ ...summary, token: "whk_secret" });
    expect(parsed).not.toHaveProperty("token");
  });

  it("모르는 경고·결과를 거절한다", () => {
    expect(AutomationSummary.safeParse({ ...summary, warnings: [{ kind: "nope" }] }).success).toBe(false);
    expect(AutomationSummary.safeParse({ ...summary, lastStatus: "running" }).success).toBe(false);
  });

  it("만들기 응답의 webhookUrl 은 주소여야 한다", () => {
    const automation = summary;
    expect(AutomationCreated.safeParse({ automation }).success).toBe(true);
    expect(
      AutomationCreated.safeParse({ automation, webhookUrl: "https://chat.example.com/hooks/whk_x" }).success,
    ).toBe(true);
    expect(AutomationCreated.safeParse({ automation, webhookUrl: "not a url" }).success).toBe(false);
  });
});

describe("Message.authorType", () => {
  it("automation 작성자를 받는다 — authorId 는 자동화 id", () => {
    const message = {
      id: ID,
      channelId: CH,
      seq: 1,
      kind: "normal",
      authorType: "automation",
      authorId: ID,
      bodyMd: "점검해 줘",
      mentions: { users: [], agents: [] },
      createdAt: NOW,
    };
    expect(Message.parse(message).authorType).toBe("automation");
  });
});

describe("워크스페이스 시간대", () => {
  it("기본 시간대는 Asia/Seoul", () => {
    expect(OPS_DEFAULT_TIME_ZONE).toBe("Asia/Seoul");
  });

  it("OpsSettings 는 한도와 시간대를 함께 싣는다", () => {
    expect(OpsSettings.safeParse({ dailyRunLimit: null, timeZone: "Asia/Seoul" }).success).toBe(true);
    expect(OpsSettings.safeParse({ dailyRunLimit: 300 }).success).toBe(false);
  });

  it("OpsSettingsPatch 는 한도와 함께 시간대를 받는다", () => {
    expect(OpsSettingsPatch.safeParse({ dailyRunLimit: 7 }).success).toBe(true);
    expect(OpsSettingsPatch.safeParse({ dailyRunLimit: null, timeZone: "America/New_York" }).success).toBe(
      true,
    );
  });

  it("OpsSettingsPatch 의 빈 시간대는 거절 — 있는 이름인지는 서버가 가른다", () => {
    expect(OpsSettingsPatch.safeParse({ dailyRunLimit: 7, timeZone: "" }).success).toBe(false);
    expect(OpsSettingsPatch.safeParse({ dailyRunLimit: 7, timeZone: "x".repeat(65) }).success).toBe(false);
  });
});

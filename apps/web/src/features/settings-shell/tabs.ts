import { type TeamRole, roleAtLeast } from "@dodok/shared";
import {
  ActivityIcon,
  BellIcon,
  BotIcon,
  CableIcon,
  HashIcon,
  type LucideIcon,
  ServerIcon,
  UserIcon,
  UsersIcon,
  ZapIcon,
} from "lucide-react";

export type SettingsTab = {
  path: string;
  label: string;
  icon: LucideIcon;
  /** 탭 목록에 보이는가 — 숨김은 편의다. 직접 주소로 오면 페이지가 「권한이 없습니다」를 그리고 서버가 막는다 */
  visible: (role: TeamRole | undefined) => boolean;
};

/**
 * `/settings` 의 탭(설정 통합 스펙 「주소와 탭」 절 표) — 순서가 곧 탭 목록 순서다. 자동화·멤버·러너·운영은 admin 이상(팀 스펙 「역할과 권한」 표),
 * 연결은 owner 만(설정 마법사 스펙 「결정」 — setup 은 owner 만). 역할을 모르는 옛 me 는 member 와 같이 본다
 */
export const SETTINGS_TABS = [
  { path: "/settings/account", label: "내 계정", icon: UserIcon, visible: () => true },
  { path: "/settings/notifications", label: "알림", icon: BellIcon, visible: () => true },
  { path: "/settings/agents", label: "에이전트", icon: BotIcon, visible: () => true },
  // 보관한 채널 목록 — 읽기는 누구나, 「보관 해제」만 admin 이상(채널 보관 스펙 「웹」 절)
  { path: "/settings/channels", label: "채널", icon: HashIcon, visible: () => true },
  // 예약·웹훅으로 채널에 게시(자동화 스펙 「웹」 장) — 런 비용을 만드는 설정이라 admin 이상
  {
    path: "/settings/automations",
    label: "자동화",
    icon: ZapIcon,
    visible: (r) => roleAtLeast(r, "admin"),
  },
  { path: "/settings/members", label: "멤버", icon: UsersIcon, visible: (r) => roleAtLeast(r, "admin") },
  // 러너·프로젝트 보기·고치기(러너 일반화 스펙 6장) — 러너 토큰 발급·폐기는 owner 의 「연결」에 남는다
  {
    path: "/settings/runners",
    label: "러너",
    icon: ServerIcon,
    visible: (r) => roleAtLeast(r, "admin"),
  },
  { path: "/settings/connection", label: "연결", icon: CableIcon, visible: (r) => r === "owner" },
  {
    path: "/settings/operations",
    label: "운영",
    icon: ActivityIcon,
    visible: (r) => roleAtLeast(r, "admin"),
  },
] as const satisfies readonly SettingsTab[];

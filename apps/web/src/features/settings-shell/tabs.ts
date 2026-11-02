import { type TeamRole, roleAtLeast } from "@dodok/shared";
import {
  ActivityIcon,
  BellIcon,
  CableIcon,
  HashIcon,
  type LucideIcon,
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
 * `/settings` 의 탭(연결 탭 통합 스펙 3.1 표) — 순서가 곧 탭 목록 순서다. 자동화·멤버·운영은 admin 이상(팀 스펙 「역할과 권한」 표).
 * 역할을 모르는 옛 me 는 member 와 같이 본다
 */
export const SETTINGS_TABS = [
  { path: "/settings/account", label: "내 계정", icon: UserIcon, visible: () => true },
  { path: "/settings/notifications", label: "알림", icon: BellIcon, visible: () => true },
  // 연결·러너·에이전트를 한 탭에(연결 탭 통합 스펙 3.1) — 누구나 본다. 무엇을 고칠 수 있는지는 상세가 역할대로 가른다
  { path: "/settings/connection", label: "연결", icon: CableIcon, visible: () => true },
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
  {
    path: "/settings/operations",
    label: "운영",
    icon: ActivityIcon,
    visible: (r) => roleAtLeast(r, "admin"),
  },
] as const satisfies readonly SettingsTab[];

import { Link } from "@tanstack/react-router";
import { useRole } from "@/api/queries";
import { cn } from "@/lib/utils";
import { useMarkSettingsFocus } from "./focus";
import { OpsBadge } from "./OpsBadge";
import { SETTINGS_TABS } from "./tabs";

const TAB_LINK =
  "flex items-center gap-2 rounded-md px-2 text-sm text-foreground/80 outline-none hover:not-aria-[current=page]:bg-accent hover:not-aria-[current=page]:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-accent-foreground";

/**
 * 설정 탭 목록 — 넓은 화면은 레이아웃 왼쪽 칸, 좁은 화면은 `/settings` 페이지 자체(`large` — 손가락으로 누르는 줄 높이).
 * 지금 탭은 라우터 Link 가 `aria-current="page"` 를 단다. 보이는 탭은 역할대로(`SETTINGS_TABS`)
 */
export function SettingsNav({ large = false }: { large?: boolean }) {
  const role = useRole();
  const markFocus = useMarkSettingsFocus();
  return (
    <nav aria-label="설정">
      <ul className={cn("flex flex-col", large ? "gap-1" : "gap-0.5")}>
        {SETTINGS_TABS.filter((tab) => tab.visible(role)).map(({ path, label, icon: Icon }) => (
          <li key={path}>
            <Link
              to={path}
              onClick={() => markFocus(path)}
              className={cn(TAB_LINK, large ? "h-11 px-3 text-base" : "py-1.5")}
            >
              <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
              {label}
              {path === "/settings/operations" && <OpsBadge />}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

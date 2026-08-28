"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  MessageSquareText,
  PenTool,
  ChevronLeft,
  ChevronRight,
  Telescope,
  Database,
  Layers,
  Boxes,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { LogoIcon } from "@/components/logo-icon";

/** 主导航组：核心业务 + 智能中枢（深度研究）；报告/看板/日报已统一为洞察画布 */
const NAV_ITEMS = [
  { href: "/", label: "工作台", icon: LayoutDashboard },
  { href: "/ask", label: "任务问答", icon: MessageSquareText },
  { href: "/research", label: "深度研究", icon: Telescope },
  { href: "/insights", label: "洞察画布", icon: PenTool },
] as const;

/** 数据与算子管理组：平台能力配置 */
const ADMIN_ITEMS = [
  { href: "/datasources", label: "数据源管理", icon: Database },
  { href: "/semantic", label: "语义层", icon: Layers },
  { href: "/operators", label: "算子中心", icon: Boxes },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "fixed left-0 top-0 z-40 flex h-screen flex-col border-r transition-all duration-300",
        collapsed ? "w-[68px]" : "w-[238px]",
      )}
      style={{
        borderColor: "var(--line)",
        background: "var(--ink)",
        color: "#fffefa",
      }}
    >
      {/* 品牌区 */}
      <div className="flex h-16 items-center gap-3 px-4">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          style={{ background: "var(--purple)", color: "#fff" }}
        >
          <LogoIcon size={22} />
        </div>
        {!collapsed && (
          <span className="text-sm font-semibold tracking-tight">归因模块</span>
        )}
      </div>

      {/* 主导航 */}
      <nav className="mt-2 flex-1 space-y-4 overflow-y-auto px-3" aria-label="主导航">
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            const Icon = item.icon;

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-[9px] px-3 py-2.5 text-sm transition-all duration-200",
                    "hover:translate-x-[3px] hover:bg-white/10",
                    isActive && "bg-white/15 font-medium",
                    !isActive && "text-white/70",
                  )}
                  style={isActive ? { boxShadow: "inset 3px 0 var(--warning-pale)" } : undefined}
                  title={collapsed ? item.label : undefined}
                >
                  <Icon size={19} className="shrink-0" />
                  {!collapsed && <span>{item.label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>

        {/* 数据与算子管理 */}
        <div>
          {!collapsed && (
            <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-white/35">
              数据与算子
            </p>
          )}
          <ul className="space-y-1">
            {ADMIN_ITEMS.map((item) => {
              const isActive = pathname.startsWith(item.href);
              const Icon = item.icon;

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 rounded-[9px] px-3 py-2 text-[13px] transition-all duration-200",
                      "hover:translate-x-[3px] hover:bg-white/10",
                      isActive && "bg-white/15 font-medium",
                      !isActive && "text-white/60",
                    )}
                    style={isActive ? { boxShadow: "inset 3px 0 var(--warning-pale)" } : undefined}
                    title={collapsed ? item.label : undefined}
                  >
                    <Icon size={17} className="shrink-0" />
                    {!collapsed && <span>{item.label}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>

      {/* 折叠按钮 */}
      <div className="border-t border-white/10 px-3 py-3">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex w-full items-center gap-2 rounded-[9px] px-3 py-2 text-xs text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"
          aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          {!collapsed && <span>收起侧边栏</span>}
        </button>
      </div>
    </aside>
  );
}

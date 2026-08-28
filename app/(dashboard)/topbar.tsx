"use client";

import { Bell, Search, User } from "lucide-react";

export function Topbar() {
  return (
    <header
      className="sticky top-0 z-30 flex h-16 items-center justify-between border-b px-6 backdrop-blur-md"
      style={{
        borderColor: "var(--line)",
        background: "color-mix(in oklch, var(--paper) 85%, transparent)",
      }}
    >
      {/* 搜索区 */}
      <div className="flex items-center gap-3">
        <div
          className="flex items-center gap-2 rounded-[10px] border px-3 py-2 text-sm"
          style={{
            borderColor: "var(--line)",
            background: "var(--surface)",
            color: "var(--muted)",
            minWidth: 280,
          }}
        >
          <Search size={16} />
          <input
            type="text"
            placeholder="搜索指标、报告、问答..."
            className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--muted)]"
          />
        </div>
      </div>

      {/* 右侧操作区 */}
      <div className="flex items-center gap-4">
        <button
          className="relative rounded-full p-2 transition-colors hover:bg-black/5"
          aria-label="通知"
        >
          <Bell size={18} style={{ color: "var(--muted)" }} />
          <span
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full"
            style={{ background: "var(--danger)" }}
          />
        </button>
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium"
          style={{ background: "var(--purple-pale)", color: "var(--purple)" }}
        >
          <User size={16} />
        </div>
      </div>
    </header>
  );
}

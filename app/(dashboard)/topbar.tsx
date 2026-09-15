"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, LogOut, Search, User } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";

interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

export function Topbar() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 拉取当前登录身份（未登录时 apiFetch 已统一 401 → 跳登录，此处无需处理）
  useEffect(() => {
    let cancelled = false;
    apiFetch<SessionUser>("/api/auth/session").then((json) => {
      if (!cancelled && json.ok) setUser(json.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 点击面板外关闭下拉
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  const handleLogout = async () => {
    // 撤销本地会话后，整页跳 identity 登出（无 identity 时回登录页）
    const json = await apiFetch<{ logoutUrl: string | null }>("/api/auth/logout", { method: "POST" });
    const logoutUrl = json.ok ? json.data.logoutUrl : null;
    window.location.assign(logoutUrl ?? "/login");
  };

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

        {/* 用户区：头像 + 下拉（身份来自 /api/auth/session） */}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            className="flex items-center gap-2 rounded-full p-0.5 pr-2 transition-colors hover:bg-black/5"
            aria-label="用户菜单"
          >
            <span
              className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium"
              style={{ background: "var(--purple-pale)", color: "var(--purple)" }}
            >
              {user ? user.name.slice(0, 1) : <User size={16} />}
            </span>
            {user && (
              <span className="max-w-24 truncate text-sm" style={{ color: "var(--ink)" }}>
                {user.name}
              </span>
            )}
          </button>

          {menuOpen && user && (
            <div
              className="absolute right-0 top-full mt-2 w-56 rounded-[10px] border p-1.5"
              style={{
                borderColor: "var(--line)",
                background: "var(--surface)",
                boxShadow: "0 8px 32px rgb(28 18 48 / 12%)",
              }}
            >
              <div className="px-2.5 py-2">
                <div className="text-sm font-medium" style={{ color: "var(--ink)" }}>
                  {user.name}
                </div>
                {user.email && (
                  <div className="mt-0.5 truncate text-xs" style={{ color: "var(--muted)" }}>
                    {user.email}
                  </div>
                )}
                <div className="mt-0.5 text-xs" style={{ color: "var(--muted)" }}>
                  角色：{user.role}
                </div>
              </div>
              <div className="my-1 border-t" style={{ borderColor: "var(--line)" }} />
              <button
                type="button"
                onClick={handleLogout}
                className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-sm transition-colors hover:bg-black/5"
                style={{ color: "var(--danger)" }}
              >
                <LogOut size={15} />
                退出登录
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

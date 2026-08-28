"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogIn } from "lucide-react";
import { LogoIcon } from "@/components/logo-icon";

export function LoginClient() {
  const router = useRouter();
  const [email, setEmail] = useState("dev@example.com");
  const [password, setPassword] = useState("dev-password");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError("");

    // 开发阶段：模拟登录（后续接入 next-auth / 企业 SSO）
    // 任意输入均跳转到工作台
    setTimeout(() => {
      router.push("/");
    }, 500);
  };

  return (
    <div
      className="flex min-h-screen items-center justify-center"
      style={{ background: "var(--paper)" }}
    >
      <div className="w-full max-w-[400px] px-4">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl"
            style={{ background: "var(--purple)", color: "#fff" }}
          >
            <LogoIcon size={34} />
          </div>
          <h1
            className="mt-4 text-2xl font-semibold tracking-tight"
            style={{ color: "var(--ink)" }}
          >
            归因模块
          </h1>
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            数据驱动的智能决策引擎
          </p>
        </div>

        {/* 登录表单 */}
        <form
          onSubmit={handleLogin}
          className="rounded-[var(--radius-sm)] border p-7"
          style={{
            borderColor: "var(--line)",
            background: "var(--surface)",
            boxShadow: "0 8px 32px rgb(28 18 48 / 8%)",
          }}
        >
          <h2 className="text-base font-semibold" style={{ color: "var(--ink)" }}>
            登录
          </h2>
          <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
            开发阶段：任意邮箱密码即可登录
          </p>

          <div className="mt-5 space-y-4">
            <div>
              <label className="block text-xs font-medium" style={{ color: "var(--ink-soft)" }}>
                邮箱
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1.5 w-full rounded-[8px] border px-3 py-2.5 text-sm outline-none transition-colors focus:border-[var(--purple)]"
                style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--paper)" }}
                placeholder="your@email.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium" style={{ color: "var(--ink-soft)" }}>
                密码
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5 w-full rounded-[8px] border px-3 py-2.5 text-sm outline-none transition-colors focus:border-[var(--purple)]"
                style={{ borderColor: "var(--line)", color: "var(--ink)", background: "var(--paper)" }}
                placeholder="••••••••"
              />
            </div>
          </div>

          {error && (
            <div
              className="mt-4 rounded-[8px] px-3 py-2 text-xs"
              role="alert"
              style={{ background: "var(--danger-pale)", color: "var(--danger)" }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-[8px] py-2.5 text-sm font-medium text-white transition-all hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40 disabled:transform-none"
            style={{ background: "var(--purple)" }}
          >
            <LogIn size={16} />
            {loading ? "登录中..." : "登录"}
          </button>

          <p className="mt-4 text-center text-xs" style={{ color: "var(--muted)" }}>
            后续版本将接入企业 SSO / OAuth2.1
          </p>
        </form>
      </div>
    </div>
  );
}

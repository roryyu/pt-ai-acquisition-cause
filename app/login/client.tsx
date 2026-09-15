"use client";

import { useEffect, useState } from "react";
import { LogIn } from "lucide-react";
import { LogoIcon } from "@/components/logo-icon";

/**
 * 登录页（BFF 模式的「大厅」）：
 * 不收集账密——点击按钮整页跳转 /api/auth/login，由 identity（Keycloak/模拟器）
 * 渲染真正的登录页；本页负责入口按钮、错误展示与登出后的落地。
 */

/** 回调/发起失败的错误码 → 用户可读文案 */
const ERROR_MESSAGES: Record<string, string> = {
  account_not_provisioned: "该账号尚未在 Access 平台开通，请联系管理员",
  account_disabled: "账号已停用，请联系管理员",
  account_not_active: "账号当前不可用，请联系管理员",
  entry_entitlement_required: "账号未获得归因模块的访问权限，请联系管理员",
  access_unavailable: "无法连接 Access 服务，请确认其已启动后重试",
  discovery_unreachable: "无法连接统一认证服务（Identity），请确认其已启动后重试",
  discovery_failed: "统一认证服务配置异常（discovery 失败）",
  discovery_invalid: "统一认证服务配置异常（缺少端点）",
  token_unreachable: "无法连接统一认证服务的 token 端点",
  token_exchange_failed: "登录凭据兑换失败，请重新登录",
  id_token_invalid: "身份令牌校验失败，请重新登录",
  nonce_mismatch: "登录状态校验失败（疑似重放），请重新登录",
  subject_missing: "身份令牌缺少用户标识，请联系管理员",
  invalid_state: "登录状态已过期或无效，请重新登录",
  missing_params: "登录回调参数缺失，请重新登录",
  provider_denied: "已在统一认证页取消登录",
  internal_error: "登录失败，请稍后重试",
  login_failed: "登录失败，请稍后重试",
};

export function LoginClient() {
  const [error, setError] = useState("");
  const [returnTo, setReturnTo] = useState("/");

  // 直接解析 location.search（不用 useSearchParams，避免 Suspense 边界要求）
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("error");
    if (code) {
      setError(ERROR_MESSAGES[code] ?? `登录失败（${code}）`);
    }
    const target = params.get("returnTo");
    if (target && target.startsWith("/") && !target.startsWith("//")) {
      setReturnTo(target);
    }
  }, []);

  const handleLogin = () => {
    // 整页跳转发起 OIDC：302 → identity 授权页 → 输密码 → 302 回 /api/auth/callback
    window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
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

        {/* 登录入口 */}
        <div
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
            使用 PT AI 统一账号登录，由 Access 平台校验访问权限
          </p>

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
            type="button"
            onClick={handleLogin}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-[8px] py-2.5 text-sm font-medium text-white transition-all hover:-translate-y-0.5"
            style={{ background: "var(--purple)" }}
          >
            <LogIn size={16} />
            使用 PT AI 账号登录
          </button>

          <p className="mt-4 text-center text-xs" style={{ color: "var(--muted)" }}>
            本地联调账号见 pt-access/users.json（dev / dev-password）
          </p>
        </div>
      </div>
    </div>
  );
}

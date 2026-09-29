import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { LogIn } from "lucide-react";

import { LogoIcon } from "@/components/logo-icon";
import { safeRelativeReturnTo } from "@/lib/server/auth/safe-return-to";
import { getSessionActor } from "@/lib/server/auth/session";

export const metadata: Metadata = { title: "登录" };

/** 授权失败错误码 → 用户可读文案（code 由 callback/login 路由的 authFailureCode 归一） */
const ERROR_MESSAGES: Record<string, string> = {
  account_not_provisioned: "该账号尚未在 Access 平台开通，请联系管理员",
  account_disabled: "账号已停用，请联系管理员",
  account_not_active: "账号当前不可用，请联系管理员",
  entry_entitlement_required: "账号未获得归因模块的访问权限，请联系管理员",
  access_denied: "Access 平台拒绝了本次登录，请联系管理员",
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

function pick(params: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 登录页：Access 授权状态机的四个终态入口（对齐 creative 的 /login 设计）
 * 1. 已登录            → 302 回业务页，不渲染
 * 2. 首次访问（无信号） → 302 自动发起 OIDC，不渲染（用户无需多点一次按钮）
 * 3. signedOut=1       → 渲染「已退出登录」落地页
 * 4. error=<code>      → 渲染授权失败页（文案按错误码分类，保留 returnTo 便于重试）
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const signedOut = pick(params, "signedOut") === "1";
  const errorCode = pick(params, "error");
  const errorMessage = errorCode ? (ERROR_MESSAGES[errorCode] ?? `登录失败（${errorCode}）`) : "";
  const returnTo = safeRelativeReturnTo(pick(params, "returnTo"), "/");
  const loginHref = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

  // 态 1：已登录直进业务页。探测失败（Access 不可达等）不阻塞渲染——
  // 让错误页/登出页保持可用，比白屏更有价值
  let authenticated = false;
  try {
    const incoming = await headers();
    const probe = new Request("http://local.invalid/login", {
      method: "GET",
      headers: new Headers(incoming),
    });
    authenticated = Boolean(await getSessionActor(probe));
  } catch {
    authenticated = false;
  }
  if (authenticated) redirect(returnTo);

  // 态 2：无错误、非登出落地 → 自动发起 OIDC，登录页不停留
  if (!signedOut && !errorMessage) redirect(loginHref);

  // 态 3 / 4：渲染落地页（signedOut 与 error 两套文案）
  const lead = errorMessage || "你已安全退出归因模块，可使用 PT AI 账号重新登录";

  return (
    <div className="flex min-h-screen items-center justify-center" style={{ background: "var(--paper)" }}>
      <div className="w-full max-w-[400px] px-4">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl"
            style={{ background: "var(--purple)", color: "#fff" }}
          >
            <LogoIcon size={34} />
          </div>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight" style={{ color: "var(--ink)" }}>
            归因模块
          </h1>
          <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
            数据驱动的智能决策引擎
          </p>
        </div>

        {/* 登录入口 / 状态说明 */}
        <div
          className="rounded-[var(--radius-sm)] border p-7"
          style={{
            borderColor: "var(--line)",
            background: "var(--surface)",
            boxShadow: "0 8px 32px rgb(28 18 48 / 8%)",
          }}
        >
          <h2 id="login-title" className="text-base font-semibold" style={{ color: "var(--ink)" }}>
            {errorMessage ? "登录" : "已退出登录"}
          </h2>
          <p
            className="mt-1 text-xs"
            style={{ color: "var(--muted)" }}
            {...(errorMessage ? { role: "alert" } : {})}
          >
            {lead}
          </p>

          <a
            href={loginHref}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-[8px] py-2.5 text-sm font-medium text-white transition-all hover:-translate-y-0.5"
            style={{ background: "var(--purple)" }}
          >
            <LogIn size={16} />
            使用 PT AI 账号登录
          </a>

          <p className="mt-4 text-center text-xs" style={{ color: "var(--muted)" }}>
            登录由 PT AI Access 统一校验账号状态与归因模块访问权限
          </p>
        </div>
      </div>
    </div>
  );
}

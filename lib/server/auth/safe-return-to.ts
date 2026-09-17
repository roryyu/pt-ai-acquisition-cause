/**
 * 登录回跳目标白名单校验（对齐 Access 系应用的 safeRelativeReturnTo）
 * 供 /api/auth/login 与登录页共用，避免两处各写一份弱校验。
 *
 * 六重防护：长度上限 → 必须 / 开头 → 拒反斜杠与控制字符 → 拒 %2f/%5c 编码绕过
 * → URL 解析确认同源 → 排除 /login 与 /api/auth/*（防重定向死循环）
 */
export function safeRelativeReturnTo(
  value: string | null | undefined,
  fallback = "/",
  maxLength = 1024,
): string {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    !value.startsWith("/") ||
    /[\\\u0000-\u001f\u007f]/.test(value) ||
    /^\/(?:%2f|%5c)/i.test(value)
  ) {
    return fallback;
  }
  try {
    const base = new URL("https://return-to.invalid/");
    const target = new URL(value, base);
    // 协议相对（//host）与绝对 URL 经解析后会换 origin，一律拒绝
    if (target.origin !== base.origin) return fallback;
    const pathname = target.pathname.toLowerCase();
    if (pathname === "/login" || pathname.startsWith("/api/auth/")) return fallback;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return fallback;
  }
}

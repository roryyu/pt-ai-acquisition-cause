/**
 * 鉴权链路失败归一与结构化日志
 * 错误码既用于 /login?error=<code> 的文案映射，也用于日志检索（对齐 Access 系应用）
 */
import { AccessDeniedError, AccessUnavailableError } from "./access-client";
import { OidcError } from "./oidc";

/** 错误码归一：OIDC / Access 拒绝 / Access 不可达 / 其余一律 internal_error */
export function authFailureCode(error: unknown): string {
  if (error instanceof OidcError) return error.code;
  if (error instanceof AccessDeniedError) return error.code;
  if (error instanceof AccessUnavailableError) return "access_unavailable";
  return "internal_error";
}

/** 结构化失败事件（JSON 单行，便于日志平台按 event/application/code 聚合告警） */
export function logAuthRouteFailure(route: string, error: unknown): void {
  console.warn(
    JSON.stringify({
      event: "authentication_route_failed",
      application: "cause",
      code: authFailureCode(error),
      route,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

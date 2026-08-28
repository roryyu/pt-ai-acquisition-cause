import { NextResponse } from "next/server";
import { ZodError } from "zod";

/**
 * 统一 API 错误类（项目规范 4.5）
 * 三类错误：ApiError（业务） / ZodError（校验） / 未知错误（500）
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly message_: string,
    public readonly retryable = false,
    public readonly details?: unknown,
  ) {
    super(message_);
    this.name = "ApiError";
  }
}

/** 安全响应头（项目规范 4.6） */
const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** 成功响应 */
export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data }, { status, headers: SECURITY_HEADERS });
}

/** 从请求体安全解析 JSON */
export async function readJson<T>(request: Request): Promise<T> {
  const body = await request.json().catch(() => null);
  if (body === null) {
    throw new ApiError(400, "INVALID_REQUEST", "请求体解析失败，请检查 JSON 格式");
  }
  return body as T;
}

/**
 * 身份验证桩：当前阶段返回模拟用户
 * 后续迭代接入企业 SSO / next-auth
 */
export async function requireActor(_request: Request): Promise<{
  id: string;
  name: string;
  email: string;
  role: string;
}> {
  // TODO: 接入 next-auth / 企业 SSO
  return {
    id: "user_dev_default",
    name: "开发用户",
    email: "dev@example.com",
    role: "admin",
  };
}

/** 从 URL 查询参数获取分页 */
export function parsePagination(url: string): { skip: number; take: number } {
  const params = new URL(url).searchParams;
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(params.get("pageSize")) || 20));
  return { skip: (page - 1) * pageSize, take: pageSize };
}

/** 统一错误处理（项目规范 4.5：三类错误） */
export function handleApiError(error: unknown): NextResponse {
  // 1. ApiError → 结构化业务错误
  if (error instanceof ApiError) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message_,
          retryable: error.retryable,
          details: error.details,
        },
      },
      { status: error.status, headers: SECURITY_HEADERS },
    );
  }

  // 2. ZodError → 400 INVALID_REQUEST + 字段详情
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "请求参数校验失败",
          retryable: false,
          details: error.issues,
        },
      },
      { status: 400, headers: SECURITY_HEADERS },
    );
  }

  // 3. 未知错误 → 500 INTERNAL_ERROR（隐藏内部细节）
  const message = error instanceof Error ? error.message : "未知错误";
  console.error("[API] Unhandled error:", message, error);
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "服务器内部错误",
        retryable: true,
      },
    },
    { status: 500, headers: SECURITY_HEADERS },
  );
}

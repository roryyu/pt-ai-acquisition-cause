import { z } from "zod";

/**
 * 服务端环境变量 Schema
 * 设计约束（design.md 1.3 / 12.3）：所有外部输入必须经过 Zod 校验，环境变量亦不例外。
 * 类型从 Schema 推断，新增变量须同步维护 .env.example。
 */
const serverEnvSchema = z.object({
  // ---------- 应用 ----------
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3100"),
  // 会话签名密钥，至少 32 字符
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET 至少 32 字符"),

  // ---------- PT AI Access 统一认证（OIDC BFF，见 doc/鉴权接入PT-AI-Access设计.md） ----------
  // 默认值对应本地 pt-access 模拟器；接真实 Access 环境时必须显式覆盖
  /** identity 容器（Keycloak）realm 地址，用于 discovery/JWKS/授权端点 */
  OIDC_ISSUER: z.string().url().default("http://localhost:8094/realms/pt-ai"),
  OIDC_CLIENT_ID: z.string().default("pt-ai-cause"),
  OIDC_CLIENT_SECRET: z.string().default("pt-ai-cause-oidc-local-only"),
  /** access-app 容器内部接口基址（/internal/session-activated、/internal/principal） */
  ACCESS_INTERNAL_BASE_URL: z.string().url().default("http://localhost:4300"),
  ACCESS_INTERNAL_SECRET: z.string().default("pt-ai-access-internal-local-only"),
  /** cause 在 Access entryCatalog 中的入口 ID */
  ACCESS_ENTRY_ID: z.string().default("cause"),
  /** principal 请求期缓存秒数（fail-closed） */
  ACCESS_PRINCIPAL_CACHE_SECONDS: z.coerce.number().int().nonnegative().default(60),

  // ---------- 统一模型网关（所有 AI 调用的唯一入口，design.md 12.1） ----------
  MODEL_GATEWAY_BASE_URL: z.string().url(),
  MODEL_GATEWAY_API_KEY: z.string().min(1, "必须配置模型网关密钥"),
  MODEL_GATEWAY_DEFAULT_MODEL: z.string().min(1, "必须配置默认模型"),
  MODEL_GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),

  // ---------- 备用模型网关（主网关不可用时自动降级） ----------
  MODEL_GATEWAY_FALLBACK_URL: z.string().url().optional(),
  MODEL_GATEWAY_FALLBACK_KEY: z.string().optional(),
  MODEL_GATEWAY_FALLBACK_MODEL: z.string().optional(),

  // ---------- PostgreSQL + pgvector 主存储（design.md 6.1） ----------
  DATABASE_URL: z.string().min(1, "必须配置 DATABASE_URL"),

  // ---------- Redis（design.md 6.3） ----------
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  // ---------- 消息队列（研究任务队列，预留） ----------
  MQ_URL: z.string().optional(),

  // ---------- MCP Gateway（OAuth2.1，design.md 5.1.3） ----------
  MCP_GATEWAY_URL: z.string().url().optional(),
  MCP_GATEWAY_CLIENT_ID: z.string().optional(),
  MCP_GATEWAY_CLIENT_SECRET: z.string().optional(),

  // ---------- Web 抓取 Firecrawl（design.md 5.1.4） ----------
  FIRECRAWL_API_KEY: z.string().optional(),
  FIRECRAWL_BASE_URL: z.string().url().default("https://api.firecrawl.dev"),

  // ---------- 对象存储（design.md 6.3） ----------
  OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
  OBJECT_STORAGE_ACCESS_KEY: z.string().optional(),
  OBJECT_STORAGE_SECRET_KEY: z.string().optional(),
  OBJECT_STORAGE_BUCKET: z.string().default("insight"),

  // ---------- Adjust 报告服务 API（见 doc/Adjust官网API与MCP对接指南-20260902.md） ----------
  /** API 识别码：Adjust 控制面板 → 账户设置 → 个人档案，Bearer Token 认证 */
  ADJUST_API_TOKEN: z.string().optional(),
  ADJUST_RS_API_BASE_URL: z.string().url().default("https://automate.adjust.com/reports-service"),
  /** 报告时区（如 +08:00）：同步落库与算子 API 直查统一口径，避免跨日错位 */
  ADJUST_RS_UTC_OFFSET: z.string().regex(/^[+-]\d{2}:\d{2}$/, "格式如 +08:00").optional(),
});

/** 服务端环境变量类型（从 Schema 推断） */
export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * 校验并返回服务端环境变量
 * 校验失败立即抛错（fail fast），避免带病启动
 */
function loadServerEnv(): ServerEnv {
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`环境变量校验失败：\n${issues}\n请检查 .env 配置（参考 .env.example）`);
  }
  return parsed.data;
}

/** 服务端环境变量（仅可在服务端代码中导入） */
export const env = loadServerEnv();

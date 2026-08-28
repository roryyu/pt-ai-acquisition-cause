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
  APP_URL: z.string().url().default("http://localhost:3000"),
  // 会话签名密钥，至少 32 字符
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET 至少 32 字符"),

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

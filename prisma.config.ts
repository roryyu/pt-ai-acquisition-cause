import { defineConfig } from "prisma/config";

// Node 24 原生加载 .env；文件缺失（如 CI 的 postinstall 场景）时忽略
try {
  process.loadEnvFile();
} catch {
  // 回退到下方默认本地连接串
}

/**
 * Prisma 7 配置入口
 * - CLI（migrate / db push / studio）通过 datasource.url 连接数据库
 * - 运行时 PrismaClient 不使用此文件，而是在 lib/db/index.ts 中经 @prisma/adapter-pg 显式建连
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://insight:insight@localhost:5432/insight",
  },
});

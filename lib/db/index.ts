import { PrismaPg } from "@prisma/adapter-pg";

import { env } from "@/lib/env";
import { PrismaClient, Prisma } from "./generated/client/client";

/** Prisma 命名空间类型（如 Prisma.InputJsonValue），统一从此处导入 */
export { Prisma };

/**
 * 从连接串解析 ?schema= 参数（如 .../postgres?schema=cause）
 * PrismaPg 不会自行解析该参数，需显式传入以告知查询编译器模型所在 schema；
 * 与 prisma/schema.prisma 中 datasource.schemas 保持一致，缺省回退 public
 */
function parseSchemaParam(connectionString: string): string {
  try {
    return new URL(connectionString).searchParams.get("schema") ?? "public";
  } catch {
    return "public";
  }
}

const adapter = new PrismaPg(env.DATABASE_URL, {
  schema: parseSchemaParam(env.DATABASE_URL),
});

// 开发环境热重载时复用全局实例，避免连接池泄漏
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Prisma Client 单例（统一出口，业务代码禁止绕过此处自行建连） */
export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

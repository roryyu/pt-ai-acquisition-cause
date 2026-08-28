/**
 * 用户辅助：确保模拟用户已落库（requireActor 返回的桩用户首用前写入）
 */
import { prisma } from "@/lib/db";

/** 确保用户存在（不存在则创建，失败不阻塞主流程） */
export async function ensureUserExists(id: string, email: string, name: string): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    await prisma.user
      .create({ data: { id, email, name, role: "admin" } })
      .catch(() => {});
  }
}

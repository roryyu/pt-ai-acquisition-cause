#!/usr/bin/env node
/**
 * 数据库连通性与 CRUD 冒烟测试（本地调试用，不进入 CI）
 * 运行：npx tsx scripts/db-smoke.ts
 */
process.loadEnvFile();

// 动态导入确保 .env 先于 lib/env.ts 的校验加载
const { prisma } = await import("../lib/db/index");

const stamp = Date.now();
const email = `smoke-${stamp}@example.com`;

// 建用户（验证 cause.users 表与 UserRole 枚举映射）
const user = await prisma.user.create({
  data: {
    id: `user_smoke_${stamp}`,
    email,
    name: "冒烟测试",
    role: "analyst",
  },
});
console.log("create ✓", user.id, "role =", user.role);

// 读用户（验证 Timestamptz 与字段映射）
const found = await prisma.user.findUnique({ where: { id: user.id } });
if (!found || found.email !== email || !(found.createdAt instanceof Date)) {
  throw new Error("读取校验失败：字段映射异常");
}
console.log("read ✓", found.email, "createdAt =", found.createdAt.toISOString());

// 建工作区（验证外键关系）
const workspace = await prisma.workspace.create({
  data: {
    id: `workspace_smoke_${stamp}`,
    name: "冒烟工作区",
    ownerId: user.id,
    dataSourceIds: ["data_source_smoke"],
  },
});
console.log("create ✓", workspace.id, "dataSourceIds =", workspace.dataSourceIds);

// 关系查询（验证 owner 关系与跨表 JOIN）
const withOwner = await prisma.workspace.findUnique({
  where: { id: workspace.id },
  include: { owner: true },
});
if (withOwner?.owner.id !== user.id) {
  throw new Error("关系查询校验失败");
}
console.log("relation ✓", withOwner.owner.email);

// 清理冒烟数据
await prisma.workspace.delete({ where: { id: workspace.id } });
await prisma.user.delete({ where: { id: user.id } });
await prisma.$disconnect();
console.log("cleanup ✓ 数据库冒烟测试全部通过");

export {};

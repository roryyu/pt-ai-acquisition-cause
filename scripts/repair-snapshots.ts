/**
 * 修复旧版迁移脚本产生的不合法 tldraw snapshot
 *
 * 问题：旧版 migrate-insights.ts 生成的 snapshot 缺少 schema 字段，
 * 且 store 为数组格式，导致 tldraw loadSnapshot 在 upgradeSchema 时
 * 访问 undefined.schemaVersion 抛出 TypeError。
 *
 * 本脚本：
 * 1. 读取所有 InsightDoc
 * 2. 检测 snapshot 是否缺少 schema 或 store 为数组
 * 3. 补充正确的 schema、将 store 转为 map 格式
 * 4. 回写到数据库
 *
 * 幂等：已修复的文档不会重复处理。
 * 运行：npx tsx scripts/repair-snapshots.ts
 */

import { createTLSchema } from "tldraw";
import { defaultShapeSchemas } from "@tldraw/tlschema";

// 必须在导入 @/lib/db 之前加载 .env
process.loadEnvFile?.();

const { prisma } = await import("@/lib/db");

/** 构造包含默认形状 + live-content 自定义形状的 tldraw schema */
const tlSchema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    "live-content": { props: {} },
  },
});
const serializedSchema = tlSchema.serialize();

/** 判断 snapshot 是否需要修复 */
function needsRepair(snapshot: unknown): boolean {
  if (typeof snapshot !== "object" || snapshot === null) return true;
  const s = snapshot as Record<string, unknown>;
  // 缺少 schema 字段
  if (!s.schema || typeof s.schema !== "object") return true;
  // store 为数组格式
  if (Array.isArray(s.store)) return true;
  return false;
}

/** 将旧 snapshot 修复为 tldraw 可加载的格式 */
function repairSnapshot(snapshot: unknown): { schema: unknown; store: Record<string, unknown> } {
  let records: unknown[] = [];

  if (typeof snapshot === "object" && snapshot !== null) {
    const s = snapshot as Record<string, unknown>;
    if (Array.isArray(s.store)) {
      records = s.store as unknown[];
    } else if (s.store && typeof s.store === "object") {
      records = Object.values(s.store as Record<string, unknown>);
    }
  }

  // 确保 document 和 page 记录存在
  const hasDocument = records.some(
    (r) => typeof r === "object" && r !== null && (r as { typeName?: string }).typeName === "document",
  );
  const hasPage = records.some(
    (r) => typeof r === "object" && r !== null && (r as { typeName?: string }).typeName === "page",
  );
  if (!hasDocument) {
    records.unshift({ typeName: "document", id: "document:document", gridSize: 10, name: "", meta: {} });
  }
  if (!hasPage) {
    records.splice(1, 0, { typeName: "page", id: "page:page", name: "Page 1", index: "a1", meta: {} });
  }

  const store: Record<string, unknown> = {};
  for (const rec of records) {
    if (typeof rec === "object" && rec !== null) {
      const id = (rec as { id?: string }).id;
      if (id) store[id] = rec;
    }
  }

  return { schema: serializedSchema, store };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const docs = await prisma.insightDoc.findMany({ select: { id: true, title: true, snapshot: true } });

let repaired = 0;
let skipped = 0;

for (const doc of docs) {
  if (!needsRepair(doc.snapshot)) {
    skipped++;
    continue;
  }

  const fixed = repairSnapshot(doc.snapshot);
  await prisma.insightDoc.update({
    where: { id: doc.id },
    data: { snapshot: fixed as never },
  });
  repaired++;
  console.log(`✓ 已修复: ${doc.id} (${doc.title})`);
}

console.log(`\n完成：修复 ${repaired} 篇，跳过 ${skipped} 篇（已是正确格式）`);
process.exit(0);

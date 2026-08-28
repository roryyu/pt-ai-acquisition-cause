/**
 * 旧洞察模块 → 洞察画布 数据迁移脚本
 *
 * 将 reports / boards(+board_cards) / digests 三类旧数据统一迁移为
 * InsightDoc（tldraw 画布文档），旧内容以「实时内容形状」(live-content)
 * 程序化生成为 tldraw store snapshot：
 * - reports  → kind=report：正文转 text 形状、charts 数组转 chart 形状
 * - boards   → kind=board：board_cards 按 position 网格布局生成形状
 * - digests  → kind=digest：摘要正文转 text 形状
 *
 * 幂等：新文档 id 由旧 id 确定性推导（insight_mig_<旧id后缀>），重复执行自动跳过。
 * 运行：npx tsx scripts/migrate-insights.ts
 *
 * 注意：须在 prisma/schema.prisma 删除旧模型（drop 旧表）之前执行。
 */
import { randomUUID } from "node:crypto";

import { createTLSchema } from "tldraw";
import { defaultShapeSchemas } from "@tldraw/tlschema";

import type { Prisma } from "@/lib/db";
import type { LivePayload } from "@/lib/canvas/types";

// 必须在导入 @/lib/db（会触发 env 校验）之前加载 .env
process.loadEnvFile?.();

const { prisma } = await import("@/lib/db");

/** tldraw schema（含默认形状 + 自定义 live-content 形状），用于生成合法的 snapshot.schema */
const tlSchema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    "live-content": { props: {} },
  },
});
const serializedSchema = tlSchema.serialize();

/** 旧模型行结构（迁移后旧表将删除，此处仅保留运行时字段描述） */
interface LegacyReport {
  id: string;
  title: string;
  content: unknown;
  status: string;
  createdBy: string;
  workspaceId: string | null;
  updatedAt: Date;
}
interface LegacyBoardCard {
  id: string;
  title: string;
  type: string;
  config: unknown;
  position: number;
  width: number;
  height: number;
}
interface LegacyBoard {
  id: string;
  name: string;
  description: string;
  createdBy: string;
  workspaceId: string | null;
  updatedAt: Date;
  cards: LegacyBoardCard[];
}
interface LegacyDigest {
  id: string;
  title: string;
  content: unknown;
  workspaceId: string | null;
  updatedAt: Date;
}

/**
 * 旧模型访问入口（类型断言）：
 * 第二阶段 schema 删除旧模型后 Prisma 类型不再包含这些表，
 * 但本脚本必须在删表前运行，故用运行时断言保留可编译性。
 */
const legacy = prisma as unknown as {
  report: { findMany(args?: unknown): Promise<LegacyReport[]> };
  board: { findMany(args?: unknown): Promise<LegacyBoard[]> };
  digest: { findMany(args?: unknown): Promise<LegacyDigest[]> };
};

/** 形状网格布局参数 */
const SHAPE_W = 460;
const SHAPE_H = 340;
const GAP_X = 520;
const GAP_Y = 400;
const ORIGIN_X = 80;
const ORIGIN_Y = 80;
const COLS = 2;

/** tldraw 形状记录（live-content 自定义形状，与前端 LiveContentShapeUtil props 对齐） */
interface ShapeRecord {
  typeName: "shape";
  id: string;
  type: "live-content";
  x: number;
  y: number;
  rotation: number;
  index: string;
  parentId: string;
  isLocked: boolean;
  opacity: number;
  meta: Record<string, never>;
  props: {
    w: number;
    h: number;
    bindingId: string;
    payload: LivePayload | null;
    sourceStatus: string;
    updatedAt: string;
  };
}

/** 生成最小可加载的 tldraw store snapshot（schema + document + page + 若干形状，store 为 map 格式） */
function buildSnapshot(shapes: ShapeRecord[]): { schema: unknown; store: Record<string, unknown> } {
  const records: unknown[] = [
    { typeName: "document", id: "document:document", gridSize: 10, name: "", meta: {} },
    { typeName: "page", id: "page:page", name: "Page 1", index: "a1", meta: {} },
    ...shapes,
  ];
  // tldraw loadSnapshot 要求 store 为 { [id]: record } 映射形式
  const store: Record<string, unknown> = {};
  for (const rec of records) {
    const id = (rec as { id: string }).id;
    store[id] = rec;
  }
  return { schema: serializedSchema, store };
}

/** 创建 live-content 形状记录（迁移产物无实时绑定，sourceStatus 固定 completed） */
function makeShape(opts: {
  payload: LivePayload;
  x: number;
  y: number;
  index: string;
  updatedAt: string;
  w?: number;
  h?: number;
}): ShapeRecord {
  return {
    typeName: "shape",
    id: `shape:${randomUUID()}`,
    type: "live-content",
    x: opts.x,
    y: opts.y,
    rotation: 0,
    index: opts.index,
    parentId: "page:page",
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      w: opts.w ?? SHAPE_W,
      h: opts.h ?? SHAPE_H,
      bindingId: "",
      payload: opts.payload,
      sourceStatus: "completed",
      updatedAt: opts.updatedAt,
    },
  };
}

/** 从任意 Json 对象中防御式提取 markdown 正文（旧数据字段不统一） */
function extractText(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const c = content as Record<string, unknown>;
  for (const key of ["markdown", "text", "summary", "body", "content"]) {
    const v = c[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  // sections 数组：拼接各段标题与正文
  if (Array.isArray(c.sections)) {
    return (c.sections as Array<Record<string, unknown>>)
      .map((s) => [s.title, s.text ?? s.markdown ?? s.content].filter(Boolean).join("\n\n"))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

/** 从任意 Json 对象中防御式提取图表数组（ChartSpec 原样透传） */
function extractCharts(content: unknown): unknown[] {
  if (!content || typeof content !== "object") return [];
  const c = content as Record<string, unknown>;
  return Array.isArray(c.charts) ? (c.charts as unknown[]) : [];
}

/** tldraw 分数索引（简化：a1 ~ a9 后追加字母） */
function indexKey(i: number): string {
  return `a${String(i + 1)}`;
}

/** 迁移统计 */
const stats = { report: 0, board: 0, digest: 0, skipped: 0 };

/** 确定性新文档 id：insight_mig_<旧 id 去掉前缀> */
function migratedId(oldId: string): string {
  return `insight_mig_${oldId.replace(/^[a-z]+_/, "")}`;
}

/** reports → InsightDoc(kind=report)：正文 text 形状 + charts 网格 */
async function migrateReport(report: LegacyReport) {
  const newId = migratedId(report.id);
  if (await prisma.insightDoc.findUnique({ where: { id: newId } })) {
    stats.skipped += 1;
    return;
  }

  const text = extractText(report.content);
  const charts = extractCharts(report.content);
  const shapes: ShapeRecord[] = [];
  let seq = 0;

  if (text) {
    shapes.push(
      makeShape({
        payload: { kind: "text", title: report.title, text },
        x: ORIGIN_X,
        y: ORIGIN_Y,
        index: indexKey(seq++),
        updatedAt: report.updatedAt.toISOString(),
        w: 520,
        h: 420,
      }),
    );
  }
  charts.forEach((chart, i) => {
    shapes.push(
      makeShape({
        payload: {
          kind: "chart",
          title: `${report.title} · 图表 ${i + 1}`,
          charts: [chart as never],
        },
        x: ORIGIN_X + (i % COLS) * GAP_X,
        y: ORIGIN_Y + (text ? 480 : 0) + Math.floor(i / COLS) * GAP_Y,
        index: indexKey(seq++),
        updatedAt: report.updatedAt.toISOString(),
      }),
    );
  });
  if (shapes.length === 0) {
    shapes.push(
      makeShape({
        payload: { kind: "text", title: report.title, text: `（迁移自旧报告 ${report.id}，内容为空）` },
        x: ORIGIN_X,
        y: ORIGIN_Y,
        index: indexKey(seq++),
        updatedAt: report.updatedAt.toISOString(),
      }),
    );
  }

  await prisma.insightDoc.create({
    data: {
      id: newId,
      title: report.title,
      kind: "report",
      description: `迁移自旧洞察报告 ${report.id}`,
      snapshot: buildSnapshot(shapes) as Prisma.InputJsonValue,
      status: report.status === "published" ? "published" : "draft",
      createdBy: report.createdBy,
      workspaceId: report.workspaceId,
    },
  });
  stats.report += 1;
}

/** boards(+cards) → InsightDoc(kind=board)：按 position 网格布局 */
async function migrateBoard(board: LegacyBoard) {
  const newId = migratedId(board.id);
  if (await prisma.insightDoc.findUnique({ where: { id: newId } })) {
    stats.skipped += 1;
    return;
  }

  const cards = [...board.cards].sort((a, b) => a.position - b.position);
  const shapes: ShapeRecord[] = cards.map((card, i) => {
    const config = (card.config ?? {}) as Record<string, unknown>;
    let payload: LivePayload;
    if (card.type === "chart" && Array.isArray(config.spec)) {
      // 兼容 charts 数组形式的图表配置
      payload = { kind: "chart", title: card.title, charts: config.spec as never[] };
    } else if (card.type === "chart" && config.spec) {
      payload = { kind: "chart", title: card.title, charts: [config.spec as never] };
    } else if (typeof config.text === "string" || typeof config.content === "string") {
      payload = { kind: "text", title: card.title, text: (config.text ?? config.content) as string };
    } else {
      // metric / alert 等：以键值摘要呈现
      const lines = Object.entries(config)
        .filter(([k]) => k !== "spec")
        .map(([k, v]) => `- ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
      payload = {
        kind: "text",
        title: card.title,
        text: lines.length > 0 ? lines.join("\n") : `（${card.type} 卡片，无配置详情）`,
      };
    }
    // 按 position 网格布局，卡片 width/height 换算形状尺寸（1 单位 ≈ 240×170）
    return makeShape({
      payload,
      x: ORIGIN_X + (i % COLS) * GAP_X,
      y: ORIGIN_Y + Math.floor(i / COLS) * GAP_Y,
      index: indexKey(i),
      updatedAt: board.updatedAt.toISOString(),
      w: Math.max(SHAPE_W, card.width * 240),
      h: Math.max(SHAPE_H, card.height * 170),
    });
  });

  if (shapes.length === 0) {
    shapes.push(
      makeShape({
        payload: {
          kind: "text",
          title: board.name,
          text: board.description || `（迁移自旧看板 ${board.id}，暂无卡片）`,
        },
        x: ORIGIN_X,
        y: ORIGIN_Y,
        index: indexKey(0),
        updatedAt: board.updatedAt.toISOString(),
      }),
    );
  }

  await prisma.insightDoc.create({
    data: {
      id: newId,
      title: board.name,
      kind: "board",
      description: board.description || `迁移自旧看板 ${board.id}`,
      snapshot: buildSnapshot(shapes) as Prisma.InputJsonValue,
      status: "draft",
      createdBy: board.createdBy,
      workspaceId: board.workspaceId,
    },
  });
  stats.board += 1;
}

/** digests → InsightDoc(kind=digest)：旧日报无创建人，挂在首个用户名下 */
async function migrateDigest(digest: LegacyDigest, fallbackUserId: string) {
  const newId = migratedId(digest.id);
  if (await prisma.insightDoc.findUnique({ where: { id: newId } })) {
    stats.skipped += 1;
    return;
  }

  const text = extractText(digest.content) || `（迁移自旧日报 ${digest.id}，内容为空）`;
  const shapes = [
    makeShape({
      payload: { kind: "text", title: digest.title, text },
      x: ORIGIN_X,
      y: ORIGIN_Y,
      index: indexKey(0),
      updatedAt: digest.updatedAt.toISOString(),
      w: 520,
      h: 420,
    }),
  ];

  await prisma.insightDoc.create({
    data: {
      id: newId,
      title: digest.title,
      kind: "digest",
      description: `迁移自旧日报 ${digest.id}`,
      snapshot: buildSnapshot(shapes) as Prisma.InputJsonValue,
      status: "draft",
      createdBy: fallbackUserId,
      workspaceId: digest.workspaceId,
    },
  });
  stats.digest += 1;
}

async function main() {
  console.log("开始迁移旧洞察模块数据 → 洞察画布 ...\n");

  const [reports, boards, digests, fallbackUser] = await Promise.all([
    legacy.report.findMany({ orderBy: { createdAt: "asc" } }),
    legacy.board.findMany({ include: { cards: true }, orderBy: { createdAt: "asc" } }),
    legacy.digest.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.user.findFirst({ orderBy: { createdAt: "asc" } }),
  ]);

  for (const report of reports) {
    await migrateReport(report);
  }
  for (const board of boards) {
    await migrateBoard(board);
  }
  if (digests.length > 0 && !fallbackUser) {
    console.warn("⚠️ 存在旧日报但无可用用户，日报迁移已跳过（InsightDoc 需要创建人）");
  } else {
    for (const digest of digests) {
      await migrateDigest(digest, fallbackUser!.id);
    }
  }

  console.log("迁移完成：");
  console.log(`  - 报告 → 画布：${stats.report} 个`);
  console.log(`  - 看板 → 画布：${stats.board} 个`);
  console.log(`  - 日报 → 画布：${stats.digest} 个`);
  console.log(`  - 已存在跳过：${stats.skipped} 个`);
  console.log("\n验证无误后可从 prisma/schema.prisma 删除 Report/Board/BoardCard/Digest 模型并重新 db push。");
}

main()
  .catch((err) => {
    console.error("迁移失败：", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
